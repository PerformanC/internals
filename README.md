# PWSL-server

Simple and fast WebSocket server for Node.js

## Features

- Lightweight
- Easy to use
- Fast

## Dependencies

- N/A

## Installation

```shell
$ npm i PerformanC/Internals#PWSL-server
```

## Usage

```js
import http from 'node:http'
import { URL } from 'node:url'

import PWSL from '@performanc/pwsl-server'

const server = http.createServer((req, res) => {
  res.writeHead(400)
  res.end('Invalid request.')
})
const WebSocketServer = new PWSL()

WebSocketServer.on('/', async (ws) => {
  console.log('Connected to WebSocket server.')

  ws.send('Hello, World!')

  ws.on('message', (message) => {
    console.log(`Received message: ${message}`)
  })

  ws.on('close', () => {
    console.log('Disconnected from WebSocket server.')
  })

  ws.on('error', (err) => {
    console.log(`Error: ${err.message}`)
  })
})

server.on('upgrade', (req, socket, head) => {
  const { pathname } = new URL(req.url, `http://${req.headers.host}`)

  if (pathname === '/')
    WebSocketServer.handleUpgrade(req, socket, head, {}, (ws) => WebSocketServer.emit('/', ws, req))
})

server.on('error', (err) => {
  console.log(`Error: ${err.message}`)
})

WebSocketServer.on('error', (err) => {
  console.log(`Error: ${err.message}`)
})

server.listen(8080, () => {
  console.log(`Listening on port \u001b[94m${8080}\u001b[37m.`)
})
```

## Documentation

As an internal library, PWSL-server does not have a dedicated documentation. You should refer to the source code for more information.

## Support

Any question related to PWSL-server or other PerformanC projects can be made in [PerformanC's Discord server](https://discord.gg/uPveNfTuCJ).

## Contribution

It is mandatory to follow the PerformanC's [contribution guidelines](https://github.com/PerformanC/contributing) to contribute to PWSL-server. Following its Security Policy, Code of Conduct and syntax standard.

## Projects using PWSL-server

- [NodeLink](https://github.com/PerformanC/NodeLink)

## License

PWSL-server is licensed under [BSD 2-Clause License](LICENSE). You can read more about it on [Open Source Initiative](https://opensource.org/licenses/BSD-2-Clause).