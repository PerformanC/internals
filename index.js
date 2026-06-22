import https from 'node:https'
import http from 'node:http'
import crypto from 'node:crypto'
import EventEmitter from 'node:events'
import { URL } from 'node:url'
import BunWebSocket from './bun-support.js'

/* Bun is problematic with PWSLs due leak of full implementation of TLS/NET modules */
let nativeWs = null
if (process.versions.bun) nativeWs = BunWebSocket

function tryParseFrame(buffer) {
  if (buffer.length < 2) return null

  const opcode = buffer[0] & 0x0f
  const fin = (buffer[0] & 0x80) === 0x80
  const masked = (buffer[1] & 0x80) === 0x80

  let payloadLength = buffer[1] & 0x7f
  let offset = 2

  if (payloadLength === 126) {
    if (buffer.length < 4) return null

    payloadLength = buffer.readUInt16BE(2)
    offset = 4
  } else if (payloadLength === 127) {
    if (buffer.length < 10) return null
    const high = buffer.readUInt32BE(2)
    const low = buffer.readUInt32BE(6)

    payloadLength = high * Math.pow(2, 32) + low
    offset = 10
  }

  let mask = null
  if (masked) {
    if (buffer.length < offset + 4) return null

    mask = buffer.subarray(offset, offset + 4)
    offset += 4
  }

  if (buffer.length < offset + payloadLength) return null

  let payload = buffer.subarray(offset, offset + payloadLength)
  if (masked) {
    const unmasked = Buffer.allocUnsafe(payloadLength)
    for (let i = 0; i < payloadLength; i++) {
      unmasked[i] = payload[i] ^ mask[i & 3]
    }

    payload = unmasked
  }

  return {
    opcode,
    fin,
    masked,
    payload,
    payloadLength,
    consumed: offset + payloadLength
  }
}

class WebSocket extends EventEmitter {
  constructor(url, options) {
    super()

    this.url = url
    this.options = options
    this.socket = null
    this.recvBuffer = Buffer.alloc(0)
    this.continueInfo = {
      type: -1,
      buffer: []
    }

    this.connect()

    return this
  }

  connect() {
    const parsedUrl = new URL(this.url)
    const isSecure = parsedUrl.protocol === 'wss:'
    const agent = isSecure ? https : http
    const key = crypto.randomBytes(16).toString('base64')

    const request = agent.request((isSecure ? 'https://' : 'http://') + parsedUrl.hostname + parsedUrl.pathname + parsedUrl.search, {
      port: parsedUrl.port || (isSecure ? 443 : 80),
      timeout: this.options?.timeout ?? 0,
      headers: {
        'Sec-WebSocket-Key': key,
        'Sec-WebSocket-Version': 13,
        'Upgrade': 'websocket',
        'Connection': 'Upgrade',
        ...(this.options?.headers || {})
      },
      method: 'GET'
    })

    request.on('error', (err) => {
      this.emit('error', err)
      this.emit('close', 1006, null)

      this.cleanup()
    })

    request.on('upgrade', (res, socket, head) => {
      socket.setNoDelay()
      socket.setKeepAlive(true)

      if (head.length !== 0) socket.unshift(head)

      if (res.headers.upgrade.toLowerCase() !== 'websocket') {
        socket.destroy()

        return;
      }

      const digest = crypto.createHash('sha1')
        .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
        .digest('base64')

      if (res.headers['sec-websocket-accept'] !== digest) {
        socket.destroy()

        return;
      }

      this.socket = socket

      socket.on('data', (data) => {
        this.recvBuffer = this.recvBuffer.length === 0 ? data : Buffer.concat([this.recvBuffer, data])

        while (true) {
          const frame = tryParseFrame(this.recvBuffer)
          if (!frame) break

          this.recvBuffer = this.recvBuffer.subarray(frame.consumed)

          /* INFO: Per the RFC, frames from server MUST NOT be masked */
          if (frame.masked) {
            this.close(1002, 'Masked frame from server')
            this.cleanup()

            return
          }

          const isControl = frame.opcode >= 0x8
          if (isControl && (!frame.fin || frame.payloadLength > 125)) {
            this.close(1002, 'Invalid control frame')
            this.cleanup()

            return
          }

          switch (frame.opcode) {
            case 0x0: {
              if (this.continueInfo.type === -1) {
                this.close(1002, 'Unexpected continuation frame')
                this.cleanup()

                return
              }

              this.continueInfo.buffer.push(frame.payload)

              if (frame.fin) {
                const messageBuffer = Buffer.concat(this.continueInfo.buffer)
                this.emit('message', this.continueInfo.type === 0x1 ? messageBuffer.toString('utf8') : messageBuffer)

                this.continueInfo = {
                  type: -1,
                  buffer: []
                }
              }

              break
            }
            case 0x1:
            case 0x2: {
              if (this.continueInfo.type !== -1) {
                this.close(1002, 'Interleaved data frames')
                this.cleanup()

                return
              }

              if (!frame.fin) {
                this.continueInfo.type = frame.opcode
                this.continueInfo.buffer.push(frame.payload)
              } else {
                this.emit('message', frame.opcode === 0x1 ? frame.payload.toString('utf8') : frame.payload)
              }

              break
            }
            case 0x8: {
              if (frame.payload.length === 1) {
                this.close(1002, 'Invalid close frame')
                this.cleanup()
                return
              }

              if (frame.payload.length < 2) {
                this.emit('close', 1005, '')
              } else {
                const code = frame.payload.readUInt16BE(0)
                const reason = frame.payload.subarray(2).toString('utf-8')

                this.emit('close', code, reason)
              }

              this.cleanup()

              return
            }
            case 0x9: {
              this.sendData(frame.payload, { len: frame.payload.length, fin: true, opcode: 0xA, mask: true })

              break
            }
            case 0xA: {
              this.emit('pong')

              break
            }
          }
        }
      })

      socket.on('close', () => {
        this.emit('close', 1006, null)

        this.cleanup()
      })

      socket.on('error', (err) => {
        this.emit('error', err)
        this.emit('close', 1006, null)

        this.cleanup()
      })

      socket.on('end', () => {
        if (!this.socket || this.socket.destroyed) return;

        socket.destroy()
      })

      this.emit('open', socket, res.headers)
    })

    request.end()
  }

  cleanup() {
    if (this.socket) {
      this.socket.destroy()
      this.socket = null
    }

    this.continueInfo = {
      type: -1,
      buffer: []
    }

    return true
  }

  sendData(data, options) {
    if (!this.socket) return false
    
    let payloadStartIndex = 2
    let payloadLength = options.len
    let mask = null

    if (options.mask) {
      mask = Buffer.allocUnsafe(4)

      while ((mask[0] | mask[1] | mask[2] | mask[3]) === 0)
        crypto.randomFillSync(mask, 0, 4)

      payloadStartIndex += 4
    }

    if (options.len >= 65536) {
      payloadStartIndex += 8
      payloadLength = 127
    } else if (options.len > 125) {
      payloadStartIndex += 2
      payloadLength = 126
    }

    const header = Buffer.allocUnsafe(payloadStartIndex)
    header[0] = options.fin ? options.opcode | 128 : options.opcode
    header[1] = payloadLength

    if (payloadLength === 126) {
      header.writeUInt16BE(options.len, 2)
    } else if (payloadLength === 127) {
      header.writeBigUInt64BE(BigInt(options.len), 2)
    }

    let payloadToWrite = data

    if (options.mask) {
      header[1] |= 128
      header[payloadStartIndex - 4] = mask[0]
      header[payloadStartIndex - 3] = mask[1]
      header[payloadStartIndex - 2] = mask[2]
      header[payloadStartIndex - 1] = mask[3]

      const maskedPayload = Buffer.allocUnsafe(options.len)
      for (let i = 0; i < options.len; i++) {
        maskedPayload[i] = data[i] ^ mask[i & 3]
      }

      payloadToWrite = maskedPayload
    }

    this.socket.write(header)
    this.socket.write(payloadToWrite)

    return true
  }

  send(data) {
    if (!this.socket) return false

    let payload = null
    let opcode = null

    if (Buffer.isBuffer(data) || data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
      payload = ArrayBuffer.isView(data) ? Buffer.from(data.buffer, data.byteOffset, data.byteLength) : Buffer.from(data)
      opcode = 0x2
    } else {
      payload = Buffer.from(String(data))
      opcode = 0x1
    }

    return this.sendData(payload, { len: payload.length, fin: true, opcode, mask: true })
  }

  close(code, reason) {
    const data = Buffer.allocUnsafe(2 + Buffer.byteLength(reason ?? 'normal close'))
    data.writeUInt16BE(code ?? 1000)
    data.write(reason ?? 'normal close', 2)

    this.sendData(data, { len: data.length, fin: true, opcode: 0x8, mask: true })

    return true
  }
}

export default nativeWs || WebSocket
