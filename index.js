import https from 'node:https'
import http from 'node:http'
import crypto from 'node:crypto'
import EventEmitter from 'node:events'
import { URL } from 'node:url'
import BunWebSocket from './bun-support.js'

/* INFO: Prefer Bun WebSocket implementation over PWSL's for performance reasons */
let nativeWs = null
if (process.versions.bun) nativeWs = BunWebSocket

function tryParseFrame(buffer) {
  if (buffer.length < 2) return null

  const opcode = buffer[0] & 0x0f
  const rsv = buffer[0] & 0x70
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
    payloadLength = Number(buffer.readBigUInt64BE(2))
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
    rsv,
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
    this.request = null
    this.recvBuffer = Buffer.alloc(0)
    this.continueInfo = {
      type: -1,
      buffer: []
    }

    this.connect()
  }

  connect() {
    const parsedUrl = new URL(this.url)
    const isSecure = parsedUrl.protocol === 'wss:'
    const agent = isSecure ? https : http
    const key = crypto.randomBytes(16).toString('base64')

    /* INFO: Strip credentials, if any, then turn the ws(s) URL into an http(s) one */
    parsedUrl.username = parsedUrl.password = ''

    const request = agent.request(parsedUrl.href.replace(/^ws/, 'http'), {
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

    this.request = request

    request.on('error', (err) => {
      if (this.request !== request) return;

      this.emit('error', err)
      this.emit('close', 1006, null)

      this.cleanup()
    })

    request.on('timeout', () => {
      if (this.request !== request) return;

      this.request = null
      request.destroy()

      this.emit('error', new Error('Connection timed out'))
      this.emit('close', 1006, null)
    })

    /* INFO: A regular HTTP response means the server refused the upgrade */
    request.on('response', (res) => {
      if (this.request !== request) return;

      this.request = null
      res.resume()
      request.destroy()

      this.emit('error', new Error(`Unexpected HTTP response: ${res.statusCode}`))
      this.emit('close', 1002, null)
    })

    request.on('upgrade', (res, socket, head) => {
      if (this.request !== request) {
        socket.destroy()

        return;
      }

      socket.setNoDelay()
      socket.setKeepAlive(true)

      if (head.length !== 0) socket.unshift(head)

      const digest = crypto.createHash('sha1')
        .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
        .digest('base64')

      if ((res.headers.upgrade || '').toLowerCase() !== 'websocket' || res.headers['sec-websocket-accept'] !== digest) {
        this.request = null
        socket.destroy()

        this.emit('error', new Error('Invalid WebSocket handshake'))
        this.emit('close', 1002, null)

        return;
      }

      this.request = null
      this.socket = socket

      socket.on('data', (data) => {
        this.recvBuffer = this.recvBuffer.length === 0 ? data : Buffer.concat([this.recvBuffer, data])

        while (true) {
          const frame = tryParseFrame(this.recvBuffer)
          if (!frame) break

          this.recvBuffer = this.recvBuffer.subarray(frame.consumed)

          /* INFO: Per the RFC, frames from server MUST NOT be masked */
          if (frame.masked) {
            this.emit('error', new Error('Masked frame from server'))
            this.emit('close', 1002, null)
            this.close(1002, 'Masked frame from server')

            this.cleanup()

            return;
          }

          const isControl = frame.opcode >= 0x8
          if (isControl && (!frame.fin || frame.payloadLength > 125)) {
            this.emit('error', new Error('Invalid control frame'))
            this.emit('close', 1002, null)
            this.close(1002, 'Invalid control frame')

            this.cleanup()

            return;
          }

          if (frame.rsv !== 0) {
            this.emit('error', new Error('Unsupported extension (RSV bits set)'))
            this.emit('close', 1002, null)
            this.close(1002, 'Unsupported extension')

            this.cleanup()

            return;
          }

          switch (frame.opcode) {
            case 0x0: {
              if (this.continueInfo.type === -1) {
                this.emit('error', new Error('Unexpected continuation frame'))
                this.emit('close', 1002, null)
                this.close(1002, 'Unexpected continuation frame')

                this.cleanup()

                return;
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
                this.emit('error', new Error('Interleaved data frames'))
                this.emit('close', 1002, null)
                this.close(1002, null)

                this.cleanup()

                return;
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
                this.emit('error', new Error('Invalid close frame'))
                this.emit('close', 1002, null)
                this.close(1002, 'Invalid close frame')

                this.cleanup()

                return;
              }

              /* INFO: RFC 6455 (§5.5.1) says client must send close back as ACK for close opcode */
              this.sendData(frame.payload, { len: frame.payload.length, fin: true, opcode: 0x8, mask: true })

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
              this.emit('ping', frame.payload)
              /* INFO: RFC 6455 (§5.5.3) requires that clients pass back the payload of a ping frame in the pong frame. */
              this.sendData(frame.payload, { len: frame.payload.length, fin: true, opcode: 0xA, mask: true })

              break
            }
            case 0xA: {
              this.emit('pong', frame.payload)

              break
            }
            default: {
              /* INFO: RFC 6455 reserves opcodes 0x3-0x7 and 0xB-0xF. Frames using
                         them must kill the connection. */
              this.emit('error', new Error(`Unexpected opcode: 0x${frame.opcode.toString(16)}`))
              this.emit('close', 1002, null)
              this.close(1002, 'Unexpected opcode')

              this.cleanup()

              return;
            }
          }
        }
      })

      socket.on('close', () => {
        if (this.socket !== socket) return;

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
    const request = this.request
    /* INFO: Invalidate the request before destroying it to prevent stale callbacks from handling it. */
    this.request = null
    request?.destroy()

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

    /* INFO: Length encoding: 7 bits, 16 bits, or 64 bits */
    const extended = options.len >= 65536 ? 8 : options.len > 125 ? 2 : 0
    const headerLength = 2 + extended + (options.mask ? 4 : 0)

    const frame = Buffer.allocUnsafe(headerLength + options.len)
    frame[0] = options.fin ? options.opcode | 128 : options.opcode
    frame[1] = (options.mask ? 128 : 0) | (extended === 8 ? 127 : extended === 2 ? 126 : options.len)

    if (extended === 2) {
      frame.writeUInt16BE(options.len, 2)
    } else if (extended === 8) {
      frame.writeBigUInt64BE(BigInt(options.len), 2)
    }

    if (options.mask) {
      crypto.randomFillSync(frame, headerLength - 4, 4)

      for (let i = 0; i < options.len; i++) {
        frame[headerLength + i] = data[i] ^ frame[headerLength - 4 + (i & 3)]
      }
    } else {
      data.copy(frame, headerLength)
    }

    return this.socket.write(frame)
  }

  send(data) {
    if (!this.socket) return false

    let opcode = 0x1
    let payload

    if (typeof data === 'string') {
      payload = Buffer.from(data)
    } else if (Buffer.isBuffer(data)) {
      payload = data
      opcode = 0x2
    } else if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
      payload = ArrayBuffer.isView(data) ? Buffer.from(data.buffer, data.byteOffset, data.byteLength) : Buffer.from(data)
      opcode = 0x2
    } else {
      payload = Buffer.from(String(data))
    }

    return this.sendData(payload, { len: payload.length, fin: true, opcode, mask: true })
  }

  close(code, reason) {
    if (this.request) {
      this.cleanup()
      this.emit('close', 1006, null)

      return true
    }

    const data = Buffer.allocUnsafe(2 + Buffer.byteLength(reason ?? 'normal close'))
    data.writeUInt16BE(code ?? 1000)
    data.write(reason ?? 'normal close', 2)

    return this.sendData(data, { len: data.length, fin: true, opcode: 0x8, mask: true })
  }
}

export default nativeWs || WebSocket
