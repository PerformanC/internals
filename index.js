import EventEmitter from 'node:events'
import crypto from 'node:crypto'
import { Buffer } from 'node:buffer'

/* Bun is problematic with PWSLs due leak of full implementation of TLS/NET modules */
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

let nativeWs = null

if (process.isBun) {
  const { WebSocketServer } = require('ws')
  nativeWs = WebSocketServer
}

const TLS_MAX_SEND_SIZE = 2 ** 14

function tryParseFrame(buffer) {
  if (buffer.length < 2) return null

  const firstByte = buffer[0]
  const secondByte = buffer[1]

  const fin = (firstByte & 0x80) === 0x80
  const rsv1 = (firstByte & 0x40) === 0x40
  const rsv2 = (firstByte & 0x20) === 0x20
  const rsv3 = (firstByte & 0x10) === 0x10

  const opcode = firstByte & 0x0f
  const masked = (secondByte & 0x80) === 0x80

  const isKnownOpcode =
    opcode === 0x0 ||
    opcode === 0x1 ||
    opcode === 0x2 ||
    opcode === 0x8 ||
    opcode === 0x9 ||
    opcode === 0xA

  const isControlFrame = opcode >= 0x8

  if (rsv1 || rsv2 || rsv3 || !isKnownOpcode) {
    return {
      opcode,
      fin,
      payload: Buffer.alloc(0),
      masked,
      payloadLength: 0,
      consumed: 0,
      invalid: true
    }
  }

  if (isControlFrame && !fin) {
    return {
      opcode,
      fin,
      payload: Buffer.alloc(0),
      masked,
      payloadLength: 0,
      consumed: 0,
      invalid: true
    }
  }

  let payloadLength = secondByte & 0x7f
  let offset = 2

  if (payloadLength === 126) {
    if (buffer.length < 4) return null

    payloadLength = buffer.readUInt16BE(2)
    offset = 4
  } else if (payloadLength === 127) {
    if (buffer.length < 10) return null

    const high = buffer.readUInt32BE(2)
    const low = buffer.readUInt32BE(6)

    if (high & 0x80000000) {
      return {
        opcode,
        fin,
        payload: Buffer.alloc(0),
        masked,
        payloadLength: 0,
        consumed: 0,
        invalid: true
      }
    }

    payloadLength = high * Math.pow(2, 32) + low
    offset = 10
  }

  if (isControlFrame && payloadLength > 125) {
    return {
      opcode,
      fin,
      payload: Buffer.alloc(0),
      masked,
      payloadLength: 0,
      consumed: 0,
      invalid: true
    }
  }

  if (!masked) {
    return {
      opcode,
      fin,
      payload: Buffer.alloc(0),
      masked,
      payloadLength: 0,
      consumed: 0,
      invalid: true
    }
  }

  if (buffer.length < offset + 4) return null

  const mask = buffer.subarray(offset, offset + 4)
  offset += 4

  if (buffer.length < offset + payloadLength) return null

  let payload = buffer.subarray(offset, offset + payloadLength)
  const unmasked = Buffer.allocUnsafe(payloadLength)

  for (let i = 0; i < payloadLength; i++) {
    unmasked[i] = payload[i] ^ mask[i & 3]
  }

  payload = unmasked

  return {
    opcode,
    fin,
    payload,
    masked,
    payloadLength,
    consumed: offset + payloadLength,
    invalid: false
  }
}

class WebsocketConnection extends EventEmitter {
  constructor(req, socket, head, addHeaders) {
    super()

    this.req = req
    this.socket = socket

    this.cachedData = []
    this.fragmentOpcode = null
    this.recvBuffer = Buffer.alloc(0)

    socket.setNoDelay()
    socket.setKeepAlive(true)

    if (head.length !== 0) socket.unshift(head)

    const wsKey = req.headers['sec-websocket-key']

    if (!wsKey) {
      socket.destroy()
      this.socket = null
      this.req = null

      return;
    }

    const headers = [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      'Sec-WebSocket-Accept: ' + crypto.createHash('sha1').update(wsKey + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64'),
      'Sec-WebSocket-Version: 13'
    ]

    if (addHeaders) {
      for (const [key, value] of Object.entries(addHeaders)) {
        headers.push(`${key}: ${value}`)
      }
    }

    socket.write(headers.join('\r\n') + '\r\n\r\n')

    socket.on('data', (data) => {
      if (!this.socket) return;

      this.recvBuffer = this.recvBuffer.length === 0 ? data : Buffer.concat([this.recvBuffer, data])

      while (true) {
        const frame = tryParseFrame(this.recvBuffer)

        if (!frame) break

        if (frame.invalid) {
          this.close(1002, 'protocol error')

          this.destroy()

          return;
        }

        this.recvBuffer = this.recvBuffer.subarray(frame.consumed)

        switch (frame.opcode) {
          case 0x0: {
            if (this.fragmentOpcode === null) {
              this.close(1002, 'protocol error')

              this.destroy()

              return;
            }

            this.cachedData.push(frame.payload)

            if (frame.fin) {
              const messageBuffer = Buffer.concat(this.cachedData)

              this.emit('message', this.fragmentOpcode === 0x1 ? messageBuffer.toString() : messageBuffer)

              this.cachedData = []
              this.fragmentOpcode = null
            }

            break
          }

          case 0x1:
          case 0x2: {
            if (this.fragmentOpcode !== null) {
              this.close(1002, 'protocol error')

              this.destroy()

              return;
            }

            if (frame.fin) {
              this.emit('message', frame.opcode === 0x1 ? frame.payload.toString() : frame.payload)
            } else {
              this.fragmentOpcode = frame.opcode
              this.cachedData = [ frame.payload ]
            }

            break
          }

          case 0x8: {
            if (frame.payload.length === 1) {
              this.close(1002, 'protocol error')

              this.destroy()

              return;
            }

            if (frame.payload.length < 2) {
              this.emit('close', 1005, '')
            } else {
              const code = frame.payload.readUInt16BE(0)
              const reason = frame.payload.subarray(2).toString('utf-8')

              const codeIsReserved = code === 1004 || code === 1005 || code === 1006
              const codeIsInvalidRange = (code >= 1015 && code <= 2999) || code < 1000 || code > 4999

              if (codeIsReserved || codeIsInvalidRange || Buffer.byteLength(reason, 'utf8') > (125 - 2)) {
                this.close(1002, 'protocol error')

                this.destroy()

                return;
              }

              this.emit('close', code, reason)
            }

            this.socket.end()
            this.socket.removeAllListeners()
            this.socket = null
            this.req = null

            return;
          }

          case 0x9: {
            this.sendFrame(frame.payload, {
              len: frame.payload.length,
              fin: true,
              opcode: 0xA
            })

            break
          }

          case 0xA: {
            this.emit('pong')

            break
          }

          default: {
            this.close(1002, 'protocol error')

            this.destroy()

            return;
          }
        }
      }
    })

    req.on('error', (err) => {
      if (!this.socket) return;

      this.emit('close', 1006, `Error: ${err.message}`)
      this.socket.destroy()

      this.socket.removeAllListeners()
      this.socket = null
      this.req = null
    })

    socket.on('error', (err) => {
      if (!this.socket) return;

      this.emit('close', 1006, `Error: ${err.message}`)
      this.socket.destroy()

      this.socket.removeAllListeners()
      this.socket = null
      this.req = null
    })

    socket.on('end', () => {
      if (!this.socket) return;

      this.emit('close', 1006, null)
      this.socket.end()

      this.socket.removeAllListeners()
      this.socket = null
      this.req = null
    })

    socket.on('close', () => {
      if (!this.socket) return;

      this.emit('close', 1006, null)

      this.socket.removeAllListeners()
      this.socket = null
      this.req = null
    })
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

    const maxPayloadPerFrame = TLS_MAX_SEND_SIZE - 4

    /* INFO: If it fits in one frame, send it as a single frame */
    if (payload.length <= maxPayloadPerFrame) {
      return this.sendFrame(payload, {
        len: payload.length,
        fin: true,
        opcode
      })
    }

    /* INFO: Otherwise, send it as fragmented frames */

    /* INFO: Send the buffers immediatly */
    this.socket.cork()

    for (let offset = 0; offset < payload.length; offset += maxPayloadPerFrame) {
      const end = Math.min(offset + maxPayloadPerFrame, payload.length)
      const chunk = payload.subarray(offset, end)
      const fin = end === payload.length
      const frameOpcode = offset === 0 ? opcode : 0x0

      this.sendFrame(chunk, {
        len: chunk.length,
        fin,
        opcode: frameOpcode
      })
    }

    this.socket.uncork()

    return true
  }

  destroy() {
    if (this.socket) {
      this.socket.destroy()
      this.socket.removeAllListeners()
      this.socket = null
    }

    this.req = null
  }

  makeFHeader(options) {
    let payloadStartIndex = 2
    let payloadLength = options.len

    if (options.len >= 65536) {
      payloadStartIndex += 8
      payloadLength = 127
    } else if (options.len > 125) {
      payloadStartIndex += 2
      payloadLength = 126
    }

    const header = Buffer.allocUnsafe(payloadStartIndex)

    header[0] = options.fin ? options.opcode | 0x80 : options.opcode
    header[1] = payloadLength

    if (payloadLength === 126) {
      header.writeUInt16BE(options.len, 2)
    } else if (payloadLength === 127) {
      const bigLength = BigInt(options.len)

      header.writeUInt32BE(Number((bigLength >> 32n) & 0xffffffffn), 2)
      header.writeUInt32BE(Number(bigLength & 0xffffffffn), 6)
    }

    return header
  }

  sendFrame(data, options) {
    if (this.socket) {
      this.socket.write(this.makeFHeader(options))
      this.socket.write(data)

      return true
    }

    return false
  }

  close(code, reason) {
    const closeReason = Buffer.from(reason || 'normal close', 'utf8').subarray(0, 125 - 2).toString('utf8')
    const data = Buffer.allocUnsafe(2 + Buffer.byteLength(closeReason))

    data.writeUInt16BE(code || 1000)
    data.write(closeReason, 2)

    this.sendFrame(data, {
      len: data.length,
      fin: true,
      opcode: 0x08
    })

    return true
  }
}

class WebSocketServer extends EventEmitter {
  constructor() {
    super()
  }

  handleUpgrade(req, socket, head, headers, callback) {
    if (!socket.readable || !socket.writable) return socket.destroy()

    const connection = new WebsocketConnection(req, socket, head, headers)

    if (!socket.readable || !socket.writable) return socket.destroy()

    callback(connection)
  }
}

export default nativeWs || WebSocketServer
