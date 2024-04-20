function makeLog(message) {
  return `${message}\n` + new Error().stack.replace('Error\n', '\u001b[2m') + '\u001b[0m'
}

function logFatal(message) {
  console.error(`\n\u001b[31mError\u001b[0m: ${makeLog(message)}`)

  process.exit(1)
}

function logWarning(message) {
  console.warn(`\u001b[33mWarning\u001b[0m: ${makeLog(message)}`)
}

function verifyParams(check, params, additionalinfo = {}) {
  if (params === undefined) {
    logFatal('The parameters object is undefined.')
  }

  if (typeof params != 'object') {
    logFatal('The parameters object must be an object.')
  }

  const isArray = Array.isArray(params)
  if (isArray) {
    params.forEach((item, index) => {
      additionalinfo.parent = params
      additionalinfo.index = index

      verifyParams(check, item, additionalinfo)
    })

    return;
  }

  Object.keys(check).forEach((key) => {
    const checkKey = check[key]

    if (checkKey.shouldCheck && !checkKey.shouldCheck(params[key], additionalinfo)) return;

    if (checkKey.required != false && params[key] === undefined) {
      logFatal(`The parameter "${key}" is required.`)
    }
  })

  Object.keys(params).forEach((key) => {
    const param = params[key]
    const checkKey = check[key]

    if (!checkKey) {
      logWarning(`Unecessary parameter "${key}".`)

      return;
    }

    if (checkKey.shouldCheck && !checkKey.shouldCheck(param, additionalinfo)) return;

    const type = isArray ? 'array' : typeof param

    if (checkKey.params) {
      if (type != 'object') {
        logFatal(`The parameter "${key}" must be an object or an array.`)
      }

      if (isArray == true && param.length == 0 && checkKey.required == true) {
        logFatal(`The parameter "${key}" must not be empty.`)
      }

      additionalinfo.parent = params

      verifyParams(checkKey.params, param, additionalinfo)
    }

    switch (checkKey.type) {
      case 'file': {
        try {
          fs.accessSync((checkKey.basePath || './') + param, fs.constants.F_OK)
        } catch {
          logFatal(`The file "${param}" does not exist.`)
        }

        break
      }
      case 'fileInitial': {
        try {
          if (!fs.readdirSync((checkKey.basePath || './')).find((file) => {
            return file.startsWith(param)
          })) {
            logFatal(`The file "${param}" does not exist.`)
          }
        } catch {
          logFatal(`The file "${param}" does not exist.`)
        }

        break
      }
      default: {
        if (!checkKey.type.includes(Array.isArray(param) ? 'array' : typeof param)) {
          logFatal(`The parameter "${key}" must be a ${checkKey.type}.`)
        }
      }
    }

    if ((checkKey.shouldCheckValues ? checkKey.shouldCheckValues(param, additionalinfo) : 'true') && checkKey.values) {
      if (!checkKey.values.includes(param)) {
        logFatal(`The parameter "${key}" must be one of the following values: ${checkKey.values.join(', ')}.`)
      }
    }

    if ((checkKey.shouldCheckNotValues ? checkKey.shouldCheckNotValues(param, additionalinfo) : true) && checkKey.notValues) {
      if (checkKey.notValues.includes(param)) {
        logFatal(`The parameter "${key}" must not be one of the following values: ${checkKey.notValues.join(', ')}.`)
      }
    }
  
    if (checkKey.min !== undefined && param < checkKey.min) {
      logFatal(`The parameter "${key}" must be greater than or equal to ${checkKey.min}.`)
    }

    if (checkKey.max !== undefined && param > checkKey.max) {
      logFatal(`The parameter "${key}" must be less than or equal to ${checkKey.max}.`)
    }

    if (checkKey.extraVerification) {
      checkKey.extraVerification(param, additionalinfo)
    }
  })
}

export default verifyParams