# PWSL

The PerformanC's WebSocket Library

## Features

- Lightweight
- Easy to use
- Fast

## Dependencies

- N/A

## Installation

```shell
$ npm i PerformanC/Internals#PWSL
```

## Usage

```js
import PWSL from '@performanc/pwsl'

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

As an internal library, PWSL does not have a dedicated documentation. You should refer to the source code for more information.

## Support

Any question related to PWSL or other PerformanC projects can be made in [PerformanC's Discord server](https://discord.gg/uPveNfTuCJ).

## Contribution

It is mandatory to follow the PerformanC's [contribution guidelines](https://github.com/PerformanC/contributing) to contribute to PWSL. Following its Security Policy, Code of Conduct and syntax standard.

## Projects using PWSL

- [@performanc/voice](https://github.com/PerformanC/voice)

## License

PWSL is licensed under [BSD 2-Clause License](LICENSE). You can read more about it on [Open Source Initiative](https://opensource.org/licenses/BSD-2-Clause).