let DockerRunner
const Settings = require('settings-sharelatex')
const logger = require('logger-sharelatex')
const Docker = require('dockerode')
const dockerode = new Docker()
const crypto = require('crypto')
const async = require('async')
const LockManager = require('./DockerLockManager')
const fs = require('fs')
const Path = require('path')
const _ = require('lodash')

const ONE_HOUR_IN_MS = 60 * 60 * 1000
logger.info('using docker runner')

const usingSiblingContainers = () =>
  Settings != null &&
  Settings.path != null &&
  Settings.path.sandboxedCompilesHostDir != null

let containerMonitorTimeout
let containerMonitorInterval

module.exports = DockerRunner = {
  ERR_NOT_DIRECTORY: new Error('not a directory'),
  ERR_TERMINATED: new Error('terminated'),
  ERR_EXITED: new Error('exited'),
  ERR_TIMED_OUT: new Error('container timed out'),

  run(
    projectId,
    command,
    directory,
    image,
    timeout,
    environment,
    compileGroup,
    callback
  ) {
    let name
    if (usingSiblingContainers()) {
      const _newPath = Settings.path.sandboxedCompilesHostDir
      logger.log(
        { path: _newPath },
        'altering bind path for sibling containers'
      )
      // Server Pro, example:
      //   '/var/lib/sharelatex/data/compiles/<project-id>'
      //   ... becomes ...
      //   '/opt/sharelatex_data/data/compiles/<project-id>'
      directory = Path.join(
        Settings.path.sandboxedCompilesHostDir,
        Path.basename(directory)
      )
    }

    const volumes = {}
    volumes[directory] = '/compile'

    command = command.map((arg) =>
      arg.toString().replace('$COMPILE_DIR', '/compile')
    )
    if (image == null) {
      ;({ image } = Settings.clsi.docker)
    }

    if (
      Settings.clsi.docker.allowedImages &&
      !Settings.clsi.docker.allowedImages.includes(image)
    ) {
      return callback(new Error('image not allowed'))
    }

    if (Settings.texliveImageNameOveride != null) {
      const img = image.split('/')
      image = `${Settings.texliveImageNameOveride}/${img[2]}`
    }

    const options = DockerRunner._getContainerOptions(
      command,
      image,
      volumes,
      timeout,
      environment,
      compileGroup
    )
    const fingerprint = DockerRunner._fingerprintContainer(options)
    options.name = name = `project-${projectId}-${fingerprint}`

    // logOptions = _.clone(options)
    // logOptions?.HostConfig?.SecurityOpt = "secomp used, removed in logging"
    logger.log({ projectId }, 'running docker container')
    DockerRunner._runAndWaitForContainer(options, volumes, timeout, function (
      error,
      output
    ) {
      if (error && error.statusCode === 500) {
        logger.log(
          { err: error, projectId },
          'error running container so destroying and retrying'
        )
        DockerRunner.destroyContainer(name, null, true, function (error) {
          if (error != null) {
            return callback(error)
          }
          DockerRunner._runAndWaitForContainer(
            options,
            volumes,
            timeout,
            callback
          )
        })
      } else {
        callback(error, output)
      }
    })

    // pass back the container name to allow it to be killed
    return name
  },

  kill(containerId, callback) {
    logger.log({ containerId }, 'sending kill signal to container')
    const container = dockerode.getContainer(containerId)
    container.kill(function (error) {
      if (
        error != null &&
        error.message != null &&
        error.message.match(/Cannot kill container .* is not running/)
      ) {
        logger.warn(
          { err: error, containerId },
          'container not running, continuing'
        )
        error = null
      }
      if (error != null) {
        logger.error({ err: error, containerId }, 'error killing container')
        callback(error)
      } else {
        callback()
      }
    })
  },

  _runAndWaitForContainer(options, volumes, timeout, _callback) {
    const callback = function (...args) {
      _callback(...args)
      // Only call the callback once
      _callback = function () {}
    }

    const { name } = options

    let streamEnded = false
    let containerReturned = false
    let output = {}

    const callbackIfFinished = function () {
      if (streamEnded && containerReturned) {
        callback(null, output)
      }
    }

    const attachStreamHandler = function (error, _output) {
      if (error != null) {
        return callback(error)
      }
      output = _output
      streamEnded = true
      callbackIfFinished()
    }

    DockerRunner.startContainer(
      options,
      volumes,
      attachStreamHandler,
      function (error, containerId) {
        if (error != null) {
          return callback(error)
        }

        DockerRunner.waitForContainer(name, timeout, function (
          error,
          exitCode
        ) {
          let err
          if (error != null) {
            return callback(error)
          }
          if (exitCode === 137) {
            // exit status from kill -9
            err = DockerRunner.ERR_TERMINATED
            err.terminated = true
            return callback(err)
          }
          if (exitCode === 1) {
            // exit status from chktex
            err = DockerRunner.ERR_EXITED
            err.code = exitCode
            return callback(err)
          }
          containerReturned = true
          if (options != null && options.HostConfig != null) {
            options.HostConfig.SecurityOpt = null
          }
          logger.log({ err, exitCode, options }, 'docker container has exited')
          callbackIfFinished()
        })
      }
    )
  },

  _getContainerOptions(
    command,
    image,
    volumes,
    timeout,
    environment,
    compileGroup
  ) {
    let m, year
    let key, value, hostVol, dockerVol
    const timeoutInSeconds = timeout / 1000

    const dockerVolumes = {}
    for (hostVol in volumes) {
      dockerVol = volumes[hostVol]
      dockerVolumes[dockerVol] = {}

      if (volumes[hostVol].slice(-3).indexOf(':r') === -1) {
        volumes[hostVol] = `${dockerVol}:rw`
      }
    }

    // merge settings and environment parameter
    const env = {}
    for (const src of [Settings.clsi.docker.env, environment || {}]) {
      for (key in src) {
        value = src[key]
        env[key] = value
      }
    }
    // set the path based on the image year
    if ((m = image.match(/:([0-9]+)\.[0-9]+/))) {
      year = m[1]
    } else {
      year = '2014'
    }
    env.PATH = `/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/usr/local/texlive/${year}/bin/x86_64-linux/`
    const options = {
      Cmd: command,
      Image: image,
      Volumes: dockerVolumes,
      WorkingDir: '/compile',
      NetworkDisabled: true,
      Memory: 1024 * 1024 * 1024 * 1024, // 1 Gb
      User: Settings.clsi.docker.user,
      Env: Object.entries(env).map(([key, value]) => `${key}=${value}`),
      HostConfig: {
        Binds: Object.entries(volumes).map(
          ([hostVol, dockerVol]) => `${hostVol}:${dockerVol}`
        ),
        LogConfig: { Type: 'none', Config: {} },
        Ulimits: [
          {
            Name: 'cpu',
            Soft: timeoutInSeconds + 5,
            Hard: timeoutInSeconds + 10
          }
        ],
        CapDrop: 'ALL',
        SecurityOpt: ['no-new-privileges']
      }
    }

    if (Settings.path != null && Settings.path.synctexBinHostPath != null) {
      options.HostConfig.Binds.push(
        `${Settings.path.synctexBinHostPath}:/opt/synctex:ro`
      )
    }

    if (Settings.clsi.docker.seccomp_profile != null) {
      options.HostConfig.SecurityOpt.push(
        `seccomp=${Settings.clsi.docker.seccomp_profile}`
      )
    }

    if (Settings.clsi.docker.runtime) {
      options.HostConfig.Runtime = Settings.clsi.docker.runtime
    }

    if (Settings.clsi.docker.Readonly) {
      options.HostConfig.ReadonlyRootfs = true
      options.HostConfig.Tmpfs = { '/tmp': 'rw,noexec,nosuid,size=65536k' }
    }

    // Allow per-compile group overriding of individual settings
    if (
      Settings.clsi.docker.compileGroupConfig &&
      Settings.clsi.docker.compileGroupConfig[compileGroup]
    ) {
      const override = Settings.clsi.docker.compileGroupConfig[compileGroup]
      let key
      for (key in override) {
        _.set(options, key, override[key])
      }
    }

    return options
  },

  _fingerprintContainer(containerOptions) {
    // Yay, Hashing!
    const json = JSON.stringify(containerOptions)
    return crypto.createHash('md5').update(json).digest('hex')
  },

  startContainer(options, volumes, attachStreamHandler, callback) {
    LockManager.runWithLock(
      options.name,
      (releaseLock) =>
        // Check that volumes exist before starting the container.
        // When a container is started with volume pointing to a
        // non-existent directory then docker creates the directory but
        // with root ownership.
        DockerRunner._checkVolumes(options, volumes, function (err) {
          if (err != null) {
            return releaseLock(err)
          }
          DockerRunner._startContainer(
            options,
            volumes,
            attachStreamHandler,
            releaseLock
          )
        }),

      callback
    )
  },

  // Check that volumes exist and are directories
  _checkVolumes(options, volumes, callback) {
    if (usingSiblingContainers()) {
      // Server Pro, with sibling-containers active, skip checks
      return callback(null)
    }

    const checkVolume = (path, cb) =>
      fs.stat(path, function (err, stats) {
        if (err != null) {
          return cb(err)
        }
        if (!stats.isDirectory()) {
          return cb(DockerRunner.ERR_NOT_DIRECTORY)
        }
        cb()
      })
    const jobs = []
    for (const vol in volumes) {
      jobs.push((cb) => checkVolume(vol, cb))
    }
    async.series(jobs, callback)
  },

  _startContainer(options, volumes, attachStreamHandler, callback) {
    callback = _.once(callback)
    const { name } = options

    logger.log({ container_name: name }, 'starting container')
    const container = dockerode.getContainer(name)

    const createAndStartContainer = () =>
      dockerode.createContainer(options, function (error, container) {
        if (error != null) {
          return callback(error)
        }
        startExistingContainer()
      })
    var startExistingContainer = () =>
      DockerRunner.attachToContainer(
        options.name,
        attachStreamHandler,
        function (error) {
          if (error != null) {
            return callback(error)
          }
          container.start(function (error) {
            if (error != null && error.statusCode !== 304) {
              callback(error)
            } else {
              // already running
              callback()
            }
          })
        }
      )
    container.inspect(function (error, stats) {
      if (error != null && error.statusCode === 404) {
        createAndStartContainer()
      } else if (error != null) {
        logger.err(
          { container_name: name, error },
          'unable to inspect container to start'
        )
        callback(error)
      } else {
        startExistingContainer()
      }
    })
  },

  attachToContainer(containerId, attachStreamHandler, attachStartCallback) {
    const container = dockerode.getContainer(containerId)
    container.attach({ stdout: 1, stderr: 1, stream: 1 }, function (
      error,
      stream
    ) {
      if (error != null) {
        logger.error(
          { err: error, containerId },
          'error attaching to container'
        )
        return attachStartCallback(error)
      } else {
        attachStartCallback()
      }

      logger.log({ containerId }, 'attached to container')

      const MAX_OUTPUT = 1024 * 1024 // limit output to 1MB
      const createStringOutputStream = function (name) {
        return {
          data: '',
          overflowed: false,
          write(data) {
            if (this.overflowed) {
              return
            }
            if (this.data.length < MAX_OUTPUT) {
              this.data += data
            } else {
              logger.error(
                {
                  containerId,
                  length: this.data.length,
                  maxLen: MAX_OUTPUT
                },
                `${name} exceeds max size`
              )
              this.data += `(...truncated at ${MAX_OUTPUT} chars...)`
              this.overflowed = true
            }
          }
          // kill container if too much output
          // docker.containers.kill(containerId, () ->)
        }
      }

      const stdout = createStringOutputStream('stdout')
      const stderr = createStringOutputStream('stderr')

      container.modem.demuxStream(stream, stdout, stderr)

      stream.on('error', (err) =>
        logger.error(
          { err, containerId },
          'error reading from container stream'
        )
      )

      stream.on('end', () =>
        attachStreamHandler(null, { stdout: stdout.data, stderr: stderr.data })
      )
    })
  },

  waitForContainer(containerId, timeout, _callback) {
    const callback = function (...args) {
      _callback(...args)
      // Only call the callback once
      _callback = function () {}
    }

    const container = dockerode.getContainer(containerId)

    let timedOut = false
    const timeoutId = setTimeout(function () {
      timedOut = true
      logger.log({ containerId }, 'timeout reached, killing container')
      container.kill(function () {})
    }, timeout)

    logger.log({ containerId }, 'waiting for docker container')
    container.wait(function (error, res) {
      if (error != null) {
        clearTimeout(timeoutId)
        logger.error({ err: error, containerId }, 'error waiting for container')
        return callback(error)
      }
      if (timedOut) {
        logger.log({ containerId }, 'docker container timed out')
        error = DockerRunner.ERR_TIMED_OUT
        error.timedout = true
        callback(error)
      } else {
        clearTimeout(timeoutId)
        logger.log(
          { containerId, exitCode: res.StatusCode },
          'docker container returned'
        )
        callback(null, res.StatusCode)
      }
    })
  },

  destroyContainer(containerName, containerId, shouldForce, callback) {
    // We want the containerName for the lock and, ideally, the
    // containerId to delete.  There is a bug in the docker.io module
    // where if you delete by name and there is an error, it throws an
    // async exception, but if you delete by id it just does a normal
    // error callback. We fall back to deleting by name if no id is
    // supplied.
    LockManager.runWithLock(
      containerName,
      (releaseLock) =>
        DockerRunner._destroyContainer(
          containerId || containerName,
          shouldForce,
          releaseLock
        ),
      callback
    )
  },

  _destroyContainer(containerId, shouldForce, callback) {
    logger.log({ containerId }, 'destroying docker container')
    const container = dockerode.getContainer(containerId)
    container.remove({ force: shouldForce === true }, function (error) {
      if (error != null && error.statusCode === 404) {
        logger.warn(
          { err: error, containerId },
          'container not found, continuing'
        )
        error = null
      }
      if (error != null) {
        logger.error({ err: error, containerId }, 'error destroying container')
      } else {
        logger.log({ containerId }, 'destroyed container')
      }
      callback(error)
    })
  },

  // handle expiry of docker containers

  MAX_CONTAINER_AGE: Settings.clsi.docker.maxContainerAge || ONE_HOUR_IN_MS,

  examineOldContainer(container, callback) {
    const name = container.Name || (container.Names && container.Names[0])
    const created = container.Created * 1000 // creation time is returned in seconds
    const now = Date.now()
    const age = now - created
    const maxAge = DockerRunner.MAX_CONTAINER_AGE
    const ttl = maxAge - age
    logger.log(
      { containerName: name, created, now, age, maxAge, ttl },
      'checking whether to destroy container'
    )
    return { name, id: container.Id, ttl }
  },

  destroyOldContainers(callback) {
    dockerode.listContainers({ all: true }, function (error, containers) {
      if (error != null) {
        return callback(error)
      }
      const jobs = []
      for (const container of containers) {
        const { name, id, ttl } = DockerRunner.examineOldContainer(container)
        if (name.slice(0, 9) === '/project-' && ttl <= 0) {
          // strip the / prefix
          // the LockManager uses the plain container name
          const plainName = name.slice(1)
          jobs.push((cb) =>
            DockerRunner.destroyContainer(plainName, id, false, () => cb())
          )
        }
      }
      // Ignore errors because some containers get stuck but
      // will be destroyed next time
      async.series(jobs, callback)
    })
  },

  startContainerMonitor() {
    logger.log(
      { maxAge: DockerRunner.MAX_CONTAINER_AGE },
      'starting container expiry'
    )

    // guarantee only one monitor is running
    DockerRunner.stopContainerMonitor()

    // randomise the start time
    const randomDelay = Math.floor(Math.random() * 5 * 60 * 1000)
    containerMonitorTimeout = setTimeout(() => {
      containerMonitorInterval = setInterval(
        () =>
          DockerRunner.destroyOldContainers((err) => {
            if (err) {
              logger.error({ err }, 'failed to destroy old containers')
            }
          }),
        ONE_HOUR_IN_MS
      )
    }, randomDelay)
  },

  stopContainerMonitor() {
    if (containerMonitorTimeout) {
      clearTimeout(containerMonitorTimeout)
      containerMonitorTimeout = undefined
    }
    if (containerMonitorInterval) {
      clearInterval(containerMonitorTimeout)
      containerMonitorTimeout = undefined
    }
  }
}

DockerRunner.startContainerMonitor()
