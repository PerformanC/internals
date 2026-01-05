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
const CONTINUE_HEADER_LENGTH = 2

function parseFrameHeader(buffer) {
  let startIndex = 2

  const opcode = buffer[0] & 0b00001111
  const fin = (buffer[0] & 0b10000000) === 0b10000000
  const isMasked = (buffer[1] & 0x80) === 0x80
  let payloadLength = buffer[1] & 0b01111111

  if (payloadLength === 126) {
    startIndex += 2
    payloadLength = buffer.readUInt16BE(2)
  } else if (payloadLength === 127) {
    const buf = buffer.subarray(startIndex, startIndex + 8)

    payloadLength = buf.readUInt32BE(0) * Math.pow(2, 32) + buf.readUInt32BE(4)
    startIndex += 8
  }

  let mask = null

  if (isMasked) {
    mask = buffer.subarray(startIndex, startIndex + 4)
    startIndex += 4

    buffer = buffer.subarray(startIndex, startIndex + payloadLength)
    
    for (let i = 0; i < buffer.length; i++) {
      buffer[i] ^= mask[i & 3]
    }
  } else {
    buffer = buffer.subarray(startIndex, startIndex + payloadLength)
  }

  return {
    opcode,
    fin,
    buffer,
    payloadLength
  }
}

class WebsocketConnection extends EventEmitter {
  constructor(req, socket, head, addHeaders) {
    super()

    this.req = req
    this.socket = socket

    this.cachedData = []
    
    socket.setNoDelay()
    socket.setKeepAlive(true)

    if (head.length !== 0) socket.unshift(head)

    const headers = [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      'Sec-WebSocket-Accept: ' + crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64'),
      'Sec-WebSocket-Version: 13',
    ]

    if (addHeaders) {
      for (const [key, value] of Object.entries(addHeaders)) {
        headers.push(`${key}: ${value}`)
      }
    }

    socket.write(headers.join('\r\n') + '\r\n\r\n')

    socket.on('data', (data) => {
      const headers = parseFrameHeader(data)

      switch (headers.opcode) {
        case 0x0: {
          this.cachedData.push(headers.buffer)

          if (headers.fin) {
            this.emit('message', Buffer.concat(this.cachedData).toString())

            this.cachedData = []
          }

          break
        }
        case 0x1: {
          this.emit('message', headers.buffer.toString())

          break
        }
        case 0x2: {
          this.emit('message', headers.buffer)

          break
        }
        case 0x8: {
          if (headers.buffer.length === 0) {
            this.emit('close', 1006, '')
          } else {
            const code = headers.buffer.readUInt16BE(0)
            const reason = headers.buffer.subarray(2).toString('utf-8')

            this.emit('close', code, reason)
          }

          socket.end()

          socket.removeAllListeners()

          break
        }
        case 0x9: {
          this.sendFrame(headers.buffer, { 
            len: headers.payloadLength, 
            fin: true, 
            opcode: 0xA
          })
          
          break
        }
        case 0xA: { 
          this.emit('pong')
        }
      }

      if (headers.buffer.length > headers.payloadLength)
        this.socket.unshift(headers.buffer)
    })

    req.on('error', (err) => {
      socket.destroy()

      this.emit('close', 1006, `Error: ${err.message}`)

      socket.removeAllListeners()
    })

    socket.on('error', (err) => {
      socket.destroy()

      this.emit('close', 1006, `Error: ${err.message}`)

      socket.removeAllListeners()
    })

    socket.on('end', () => {
      socket.end()

      this.emit('close', 1006, '')

      socket.removeAllListeners()
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
      return this.sendFrame(payload, { len: payload.length, fin: true, opcode })
    }

    /* INFO: Otherwise, send it as fragmented frames */

    /* INFO: Send the buffers immediatly */
    this.socket.cork()

    for (let offset = 0; offset < payload.length; offset += maxPayloadPerFrame) {
      const end = Math.min(offset + maxPayloadPerFrame, payload.length)
      const chunk = payload.subarray(offset, end)
      const fin = end === payload.length
      const frameOpcode = offset === 0 ? opcode : 0x0

      this.sendFrame(chunk, { len: chunk.length, fin, opcode: frameOpcode })
    }

    socket.uncork()

    return true
  }

  destroy() {
    this.socket.destroy()
    this.socket = null
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
      header[2] = header[3] = 0
      header.writeUIntBE(options.len, 4, 6)
    }

    return header
  }

  sendFrame(data, options) {
    if (this.socket) {
      this.socket.write(this.makeFHeader(options))
      this.socket.write(data)
    }

    return true
  }

  close(code, reason) {
    const data = Buffer.allocUnsafe(2 + Buffer.byteLength(reason || 'normal close'))
    data.writeUInt16BE(code || 1000)
    data.write(reason || 'normal close', 2)

    this.sendFrame(data, { len: data.length, fin: true, opcode: 0x08 })

    return true
  }
}

class WebSocketServer extends EventEmitter {
  constructor() {
    super()
  }

  handleUpgrade(req, socket, head, headers, callback) {
    const connection = new WebsocketConnection(req, socket, head, headers)

    if (!socket.readable || !socket.writable) return socket.destroy()

    callback(connection)
  }
}

export default nativeWs || WebSocketServer
