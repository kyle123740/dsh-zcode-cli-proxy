/**
 * zcode2api 网关进程托管。
 *
 * 插件的模型提供方依赖一个跑在 <host>:<port> 上的 Python 网关。这里负责：
 *   - 探测端口上是否已经有一个健康的网关（外部实例 → 借用，不接管、不杀）；
 *   - 否则按配置拉起 `python main.py serve --port N`，把 stdout/stderr 落到日志文件；
 *   - 轮询 /v1/models 等待就绪，超时则报错并回收进程；
 *   - 进程意外退出时按退避策略自动重启（可关）；
 *   - 插件卸载时只清理自己拉起来的进程。
 *
 * @module lib/supervisor.js
 */

import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'

/** 网关状态机的取值。 */
export const GATEWAY_STATE = Object.freeze({
  /** 未运行，也没尝试过。 */
  STOPPED: 'stopped',
  /** 正在拉起 / 等待就绪。 */
  STARTING: 'starting',
  /** 由本插件拉起且已就绪。 */
  RUNNING: 'running',
  /** 端口上已有一个不是我们拉起的健康网关。 */
  EXTERNAL: 'external',
  /** 启动失败或反复退出。 */
  FAILED: 'failed',
  /** 配置里关掉了托管。 */
  DISABLED: 'disabled',
  /** 缺少 Python 运行时 / 内置源码，需要先跑 scripts/setup.ps1。 */
  NEEDS_SETUP: 'needs-setup',
})

const PROBE_INTERVAL_MS = 400
const PROBE_TIMEOUT_MS = 2500
const STOP_GRACE_MS = 6000
const LOG_TAIL_BYTES = 64 * 1024

/** 判断一个字符串是路径还是 PATH 上的命令名。 */
function looksLikePath(value) {
  return value.includes('/') || value.includes('\\')
}

/** 试绑一下端口：能绑上说明可用（Windows 上被保留的端口会给 EACCES）。 */
function probePortFree(host, port) {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.unref?.()
    server.once('error', (error) => resolve({ free: false, code: error?.code ?? 'UNKNOWN' }))
    server.once('listening', () => server.close(() => resolve({ free: true })))
    try {
      server.listen({ host, port, exclusive: true })
    } catch (error) {
      resolve({ free: false, code: error?.code ?? 'UNKNOWN' })
    }
  })
}

/** 端口不可用时的可读解释。 */
function portProblem(host, port, code) {
  if (code === 'EADDRINUSE') return `端口 ${host}:${port} 已被其它程序占用`
  if (code === 'EACCES') return `端口 ${host}:${port} 被系统保留（Windows 的 excludedportrange 会这样报 EACCES），换一个端口即可`
  return `端口 ${host}:${port} 不可用（${code}）`
}

/** 按平台杀进程树。 */
function killTree(pid, logger) {
  if (process.platform === 'win32') {
    try {
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    } catch (error) {
      logger?.warn?.(`zcode2api: taskkill 失败（${error?.message ?? error}）`)
    }
    return
  }
  try {
    process.kill(pid, 'SIGTERM')
  } catch (error) {
    logger?.warn?.(`zcode2api: SIGTERM 失败（${error?.message ?? error}）`)
  }
}

/**
 * 一个被托管（或借用）的 zcode2api 网关。
 */
export class GatewaySupervisor {
  /**
   * @param {object} deps
   * @param {() => object} deps.options 解析后的插件配置（每次调用都取最新值）。
   * @param {object} deps.logger harness logger。
   * @param {(snapshot: object) => void} [deps.onStateChange] 状态变化回调。
   */
  constructor({ options, logger, onStateChange }) {
    this.options = options
    this.logger = logger
    this.onStateChange = onStateChange
    this.child = undefined
    this.state = GATEWAY_STATE.STOPPED
    this.since = Date.now()
    this.lastError = ''
    this.lastExit = undefined
    this.restarts = 0
    this.disposed = false
    this.stopping = false
    this.restartTimer = undefined
    this.starting = undefined
    this.exitError = undefined
  }

  /** 当前快照，供工具 / HTTP API 使用。 */
  snapshot() {
    const options = this.options()
    return {
      state: this.state,
      managed: this.child !== undefined,
      pid: this.child?.pid,
      host: options.host,
      port: options.port,
      baseUrl: `http://${options.host}:${options.port}`,
      adminUrl: `http://${options.host}:${options.port}/admin`,
      since: this.since,
      uptimeMs: this.state === GATEWAY_STATE.RUNNING || this.state === GATEWAY_STATE.EXTERNAL ? Date.now() - this.since : 0,
      restarts: this.restarts,
      lastError: this.lastError,
      ...(this.lastExit === undefined ? {} : { lastExit: this.lastExit }),
      pythonPath: options.pythonPath,
      projectDir: options.projectDir,
      dataDir: options.dataDir,
      logFile: options.logFile,
      ready: this.state === GATEWAY_STATE.RUNNING || this.state === GATEWAY_STATE.EXTERNAL,
    }
  }

  /** 状态迁移 + 通知。 */
  setState(state, { error } = {}) {
    if (this.state !== state) {
      this.state = state
      this.since = Date.now()
      this.logger?.info?.(`zcode2api: 网关状态 → ${state}`)
    }
    if (error !== undefined) this.lastError = error
    try {
      this.onStateChange?.(this.snapshot())
    } catch {
      /* 通知失败不影响进程管理 */
    }
  }

  /** 探测 /v1/models：任何 HTTP 响应都说明服务活着（401/403 也算）。 */
  async probe() {
    const options = this.options()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort('probe timeout'), PROBE_TIMEOUT_MS)
    timer.unref?.()
    try {
      const response = await fetch(`http://${options.host}:${options.port}/v1/models`, {
        method: 'GET',
        signal: controller.signal,
      })
      await response.body?.cancel?.().catch(() => {})
      return { ok: true, status: response.status }
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) }
    } finally {
      clearTimeout(timer)
    }
  }

  /** 轮询等待就绪。 */
  async waitForReady(timeoutMs) {
    const deadline = Date.now() + timeoutMs
    let last = ''
    while (Date.now() < deadline) {
      if (this.disposed) throw new Error('已卸载')
      if (this.exitError !== undefined) throw new Error(this.exitError)
      if (this.child !== undefined && this.child.exitCode !== null) {
        throw new Error(`网关进程已退出（exit ${this.child.exitCode}），请查看 ${this.options().logFile}`)
      }
      const result = await this.probe()
      if (result.ok) return result
      last = result.error ?? ''
      await new Promise((resolve) => setTimeout(resolve, PROBE_INTERVAL_MS))
    }
    throw new Error(`等待网关就绪超时（${timeoutMs}ms）${last === '' ? '' : `：${last}`}`)
  }

  /** 解析要用的 Python 解释器；找不到就返回 undefined。 */
  resolvePython() {
    const options = this.options()
    const configured = options.pythonPath
    if (configured !== undefined && configured.trim() !== '') {
      const value = configured.trim()
      if (!looksLikePath(value)) return value // 交给 PATH 解析，例如 "python" / "py"
      return fs.existsSync(value) ? value : undefined
    }
    if (fs.existsSync(options.venvPython)) return options.venvPython
    return undefined
  }

  /** 是否具备启动条件；不满足时给出可执行的提示。 */
  preflight() {
    const options = this.options()
    if (!fs.existsSync(path.join(options.projectDir, 'main.py'))) {
      return { ok: false, hint: `内置源码不完整：缺 ${path.join(options.projectDir, 'main.py')}，请重新安装插件。` }
    }
    const python = this.resolvePython()
    if (python === undefined) {
      return {
        ok: false,
        hint: `没有可用的 Python 运行时（既没有 ${options.venvPython}，也没有配置 pythonPath）。请先执行：powershell -NoProfile -ExecutionPolicy Bypass -File "${path.join(options.pluginDir, 'scripts', 'setup.ps1')}"`,
      }
    }
    if (looksLikePath(python) && !fs.existsSync(python)) {
      return { ok: false, hint: `配置的 pythonPath 不存在：${python}` }
    }
    return { ok: true, python }
  }

  /** 打开日志文件（追加）。 */
  openLog() {
    const options = this.options()
    fs.mkdirSync(path.dirname(options.logFile), { recursive: true })
    return fs.openSync(options.logFile, 'a')
  }

  /** 环境变量：zcode2api 全部通过 env 配置。 */
  env() {
    const options = this.options()
    return {
      ...process.env,
      ZCODE_HOST: options.host,
      ZCODE_PORT: String(options.port),
      ZCODE_DATA_DIR: options.dataDir,
      ZCODE_ADMIN_KEY: options.adminKey,
      ZCODE_QUOTA_REFRESH_INTERVAL: String(options.quotaRefreshInterval),
      ZCODE_COOLING_SECONDS: String(options.coolingSeconds),
      ZCODE_NODE_PATH: options.nodePath,
      ...(options.captchaTimeoutSeconds === undefined ? {} : { ZCODE_CAPTCHA_TIMEOUT: String(options.captchaTimeoutSeconds) }),
      PYTHONUTF8: '1',
      PYTHONIOENCODING: 'utf-8',
      PYTHONUNBUFFERED: '1',
    }
  }

  /** 确保网关在跑（启动或借用外部实例）。并发调用共享同一次启动。 */
  async ensureRunning() {
    if (this.disposed) return this.snapshot()
    if (this.state === GATEWAY_STATE.RUNNING || this.state === GATEWAY_STATE.EXTERNAL) return this.snapshot()
    if (this.starting !== undefined) return this.starting
    this.starting = this.start().finally(() => {
      this.starting = undefined
    })
    return this.starting
  }

  /** 启动网关；端口上已有健康实例时借用它。 */
  async start() {
    const options = this.options()
    if (this.state === GATEWAY_STATE.RUNNING || this.state === GATEWAY_STATE.EXTERNAL) return this.snapshot()

    // 端口上已经有健康的网关？直接借用，避免两个实例抢同一个 SQLite。
    const existing = await this.probe()
    if (existing.ok) {
      this.setState(GATEWAY_STATE.EXTERNAL, { error: '' })
      this.logger?.info?.(
        `zcode2api: 复用已在 http://${options.host}:${options.port} 上运行的网关（状态 ${existing.status}），插件不接管它的生命周期`,
      )
      return this.snapshot()
    }

    if (options.manageProcess !== true) {
      this.setState(GATEWAY_STATE.DISABLED, { error: `manageProcess 已关闭，且 ${options.baseUrl} 上没有运行的网关` })
      return this.snapshot()
    }

    const preflight = this.preflight()
    if (preflight.ok !== true) {
      this.setState(GATEWAY_STATE.NEEDS_SETUP, { error: preflight.hint })
      this.logger?.warn?.(`zcode2api: ${preflight.hint}`)
      return this.snapshot()
    }

    // 端口先探一下：被别的程序占用、或者撞上 Windows 保留端口段时，
    // 与其等 90 秒超时，不如立刻给出准确的解释。
    const availability = await probePortFree(options.host, options.port)
    if (availability.free !== true) {
      const message = `${portProblem(options.host, options.port, availability.code)}。改插件配置里的 port，或停掉占用该端口的程序。`
      this.setState(GATEWAY_STATE.FAILED, { error: message })
      this.logger?.error?.(`zcode2api: ${message}`)
      return this.snapshot()
    }

    this.setState(GATEWAY_STATE.STARTING, { error: '' })
    this.exitError = undefined
    const logFd = this.openLog()
    const startedAt = new Date().toISOString()
    fs.writeSync(logFd, `\n===== zcode2api 网关启动 ${startedAt} (pid 待定, port ${options.port}) =====\n`)

    let child
    try {
      child = spawn(preflight.python, ['main.py', 'serve', '--port', String(options.port)], {
        cwd: options.projectDir,
        env: this.env(),
        stdio: ['ignore', logFd, logFd],
        windowsHide: true,
      })
    } catch (error) {
      fs.closeSync(logFd)
      this.setState(GATEWAY_STATE.FAILED, { error: `无法启动网关进程：${error?.message ?? error}` })
      return this.snapshot()
    }

    this.child = child
    child.on('error', (error) => {
      this.logger?.error?.(`zcode2api: 网关进程错误（${error?.message ?? error}）`)
      this.lastError = String(error?.message ?? error)
    })
    child.on('exit', (code, signal) => this.onExit(code, signal))
    child.unref?.()
    this.logger?.info?.(`zcode2api: 已启动网关 pid=${child.pid}，日志 ${options.logFile}`)

    try {
      await this.waitForReady(options.startTimeoutMs)
      this.setState(GATEWAY_STATE.RUNNING, { error: '' })
    } catch (error) {
      const tail = this.tailLines(6)
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line !== '')
        .slice(-3)
        .join(' | ')
      this.lastError = `${String(error?.message ?? error)}${tail === '' ? '' : `；日志尾部：${tail}`}`
      this.logger?.error?.(`zcode2api: ${this.lastError}`)
      killTree(child.pid, this.logger)
      this.child = undefined
      this.setState(GATEWAY_STATE.FAILED, { error: this.lastError })
    } finally {
      try {
        fs.closeSync(logFd)
      } catch {
        /* 交给子进程持有 */
      }
    }
    return this.snapshot()
  }

  /** 子进程退出：正常停止 → STOPPED；意外退出 → 退避重启或 FAILED。 */
  onExit(code, signal) {
    this.child = undefined
    this.lastExit = { code, signal, at: Date.now() }
    if (this.disposed) return
    if (this.stopping === true) {
      this.setState(GATEWAY_STATE.STOPPED, { error: '' })
      return
    }
    const options = this.options()
    const message = `网关进程退出（code=${code ?? 'null'} signal=${signal ?? 'null'}）`
    this.logger?.warn?.(`zcode2api: ${message}`)
    if (this.state === GATEWAY_STATE.STARTING) {
      // start() 正在等就绪：把退出原因递给它，避免白等一轮超时。
      this.exitError = `${message}，请查看 ${options.logFile}`
      return
    }
    if (options.restartOnExit !== true) {
      this.setState(GATEWAY_STATE.STOPPED, { error: message })
      return
    }
    if (this.restarts >= options.maxRestarts) {
      this.setState(GATEWAY_STATE.FAILED, { error: `${message}；已达到最大重启次数 ${options.maxRestarts}` })
      return
    }
    this.restarts += 1
    const delay = Math.min(30_000, 1000 * 2 ** Math.min(this.restarts - 1, 5))
    this.setState(GATEWAY_STATE.STARTING, { error: message })
    this.logger?.info?.(`zcode2api: ${delay}ms 后第 ${this.restarts} 次自动重启`)
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined
      void this.start().catch((error) => this.logger?.error?.(`zcode2api: 自动重启失败（${error?.message ?? error}）`))
    }, delay)
    this.restartTimer.unref?.()
  }

  /** 停止（只杀自己拉起的进程）。 */
  async stop({ reason = 'plugin request' } = {}) {
    if (this.restartTimer !== undefined) {
      clearTimeout(this.restartTimer)
      this.restartTimer = undefined
    }
    const child = this.child
    if (child === undefined) {
      if (this.state !== GATEWAY_STATE.FAILED && this.state !== GATEWAY_STATE.NEEDS_SETUP) this.setState(GATEWAY_STATE.STOPPED, { error: '' })
      return this.snapshot()
    }
    this.stopping = true
    this.logger?.info?.(`zcode2api: 停止网关 pid=${child.pid}（${reason}）`)
    const exited = new Promise((resolve) => {
      // 这个定时器不能 unref：它就是我们在等的“宽限期”本身。
      const timer = setTimeout(() => resolve(false), STOP_GRACE_MS)
      child.once('exit', () => {
        clearTimeout(timer)
        resolve(true)
      })
    })
    killTree(child.pid, this.logger)
    const clean = await exited
    if (!clean && process.platform !== 'win32') {
      try {
        process.kill(child.pid, 'SIGKILL')
      } catch {
        /* 已经退了 */
      }
    }
    this.child = undefined
    this.stopping = false
    this.setState(GATEWAY_STATE.STOPPED, { error: '' })
    return this.snapshot()
  }

  /** 重启：先停再起，并清空重启计数。 */
  async restart() {
    await this.stop({ reason: 'restart' })
    this.restarts = 0
    return this.start()
  }

  /** 读取日志文件尾部。 */
  tailLines(lines = 80) {
    const options = this.options()
    try {
      const stat = fs.statSync(options.logFile)
      const start = Math.max(0, stat.size - LOG_TAIL_BYTES)
      const fd = fs.openSync(options.logFile, 'r')
      try {
        const buffer = Buffer.alloc(stat.size - start)
        fs.readSync(fd, buffer, 0, buffer.length, start)
        const text = buffer.toString('utf8')
        return text.split(/\r?\n/).slice(-lines).join('\n')
      } finally {
        fs.closeSync(fd)
      }
    } catch (error) {
      if (error?.code === 'ENOENT') return '(还没有日志文件，网关尚未启动过)'
      return `(读取日志失败：${error?.message ?? error})`
    }
  }

  /** 卸载：停止自建进程，不再重启。 */
  async dispose() {
    this.disposed = true
    try {
      await this.stop({ reason: 'plugin unload' })
    } catch (error) {
      this.logger?.warn?.(`zcode2api: 卸载时停止网关失败（${error?.message ?? error}）`)
    }
  }
}
