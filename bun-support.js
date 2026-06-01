import EventEmitter from 'node:events'

export default class BunWebSocket extends EventEmitter {
  constructor(url, options) {
    super()

    this.ws = new globalThis.WebSocket(url, options)

    this.ws.addEventListener('open', () => this.emit('open'))
    this.ws.addEventListener('message', (event) => {
      const data =
        event.data instanceof ArrayBuffer ? Buffer.from(event.data) : event.data
      this.emit('message', data)
    })
    this.ws.addEventListener('close', (event) => {
      this.emit('close', event.code, event.reason)
    })
    this.ws.addEventListener('error', (event) => {
      this.emit('error', event.error || new Error('WebSocket error'))
    })
  }

  send(data) {
    try {
      this.ws.send(data)

      return true
    } catch {
      return false
    }
  }

  close(code, reason) {
    try {
      this.ws.close(code, reason)

      return true
    } catch {
      return false
    }
  }
}
