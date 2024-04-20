# PCTL

Runtime type checking library for JavaScript (PerformanC's Typing Library)

## Features

- Lightweight
- Easy to use
- Precise type checking
- No dependencies

## Dependencies

- N/A

## Installation

```shell
$ npm i PerformanC/Internals#PCTL
```

## Usage

```js
import verifyParams from '@performanc/pctl'

const checks = {
  'id': {
    type: 'string',
    extraVerification: (param) => {
      if (param == '0') {
        console.log('Cannot use id 0')

        process.exit(1)
      }
    }
  },
  'name': {
    type: 'string',
    extraVerification: (param) => {
      if (param.length < 3) {
        console.log('Name must be at least 3 characters long')

        process.exit(1)
      }
    }
  }
}

const options = {
  'id': '0',
  'name': 'John'
}

helper.verifyParams(checks, options)
```

## Documentation

As an internal library, PCTL does not have a dedicated documentation. You should refer to the source code for more information.

## Support

Any question related to PCTL or other PerformanC projects can be made in [PerformanC's Discord server](https://discord.gg/uPveNfTuCJ).

## Contribution

It is mandatory to follow the PerformanC's [contribution guidelines](https://github.com/PerformanC/contributing) to contribute to PCTL. Following its Security Policy, Code of Conduct and syntax standard.

## Projects using PCTL

- [PerforVNMaker](https://github.com/PerformanC/PerforVNMaker)

## License

PCTL is licensed under [BSD 2-Clause License](LICENSE). You can read more about it on [Open Source Initiative](https://opensource.org/licenses/BSD-2-Clause).