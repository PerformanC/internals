# PWSL-mini

A simplified version of PWSL (PerformanC's WebSocket Library)

## Features

- Lightweight
- Easy to use
- Fast

## Dependencies

- N/A

## Installation

```shell
$ npm i PerformanC/Internals#PWSL-mini
```

## Usage

```js
import PWSL from '@performanc/pwsl-mini'

const ws = new PWSL('ws://localhost:8080')

ws.on('open', () => {
  console.log('Connected to the server.')

  ws.send('Hello, world.')
})

ws.on('message', (data) => {
  console.log(`Received: ${data}`)
})

ws.on('close', () => {
  console.log('Disconnected from the server.')
})
```

## Documentation

As an internal library, PWSL-mini does not have a dedicated documentation. You should refer to the source code for more information.

## Support

Any question related to PWSL-mini or other PerformanC projects can be made in [PerformanC's Discord server](https://discord.gg/uPveNfTuCJ).

## Contribution

It is mandatory to follow the PerformanC's [contribution guidelines](https://github.com/PerformanC/contributing) to contribute to PWSL-mini. Following its Security Policy, Code of Conduct and syntax standard.

## Projects using PWSL-mini

- [FastLink](https://github.com/PerformanC/FastLink)

## License

PWSL-mini is licensed under [BSD 2-Clause License](LICENSE). You can read more about it on [Open Source Initiative](https://opensource.org/licenses/BSD-2-Clause).