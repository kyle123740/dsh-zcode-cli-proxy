/**
 * app-server 版委派通道：常驻 `zcode app-server` 进程，走 ZCode Protocol（stdio JSON-RPC）。
 *
 * 相比 `-p` 一次性调用的好处：
 *   - 常驻进程：不每次重启（省掉进程启动 + 每轮约 15k 的重复上下文）
 *   - 真流式：session/event → model.streaming 的 text_delta / reasoning_delta 直接转发给 DSH
 *   - 会话复用：按 DSH 的 sessionId 建一个 app-server 会话，后续轮次直接续
 *   - 可观测：session.updated 里带 providerId / baseURL，能明确知道这一轮烧的是哪个渠道的额度
 *
 * 协议（实测，bundle 里的 schema 也印证过）：
 *   信封      请求 {id, method, params}；通知 {method, params}；响应 {id, result|error} —— 没有 jsonrpc 字段
 *   session/create {workspace:{workspacePath, workspaceKey}} → result.session.sessionId
 *   服务端请求 session/requestRuntimePreferences {sessionId, scope}
 *              → 必须回复 {nativeSearchEnhancementsEnabled, memoryEnabled, askUserQuestionAutoResolutionEnabled, modelContextBudgetStrategy}
 *   session/subscribe {sessionId, deliveryKind:'desktop-continuous', afterSeq, includeSnapshot}
 *   session/setModel {sessionId, model:{providerId, modelId, options?:{reasoningLevel}}}（0.16.9 起要求对象式）
 *   session/send {sessionId, content}
 *   事件       session/event：**type 在 params 顶层**（params.type），数据在 params.payload ——
 *              session.titleUpdated | turn.started | session.updated | model.streaming{kind,delta,done}
 *              | turn.completed{response,usage,resultType} | turn.failed{error}
 *              （另有 model_request_started/failed 遥测事件，payload.type 在内层，与 GUI 事件并存）
 *
 * Start Plan 通道（2026-09-30 逆向打通，全部实测）：
 *   1. spawn 时按 GUI 同款设置 env：ZCODE_APP_VERSION / ZCODE_BUILTIN_PROVIDER_CONFIG_FILE /
 *      ZCODE_PERSONAL_PROVIDER_CONFIG_FILE / ZCODE_BASE_URL —— 否则 CLI 用 "0.0.0-dev" 目录，
 *      registry 的 configSource 与注入层的 basedOn 对不上。
 *   2. provider/updateAccountConfig 注入 `account:zai-start-plan`（access:{type:'zhipu-account',entitled:true}，
 *      schema 只接受这两个键）。**basedOnZCodeBuiltinRevision 必须精确等于 configSource 的
 *      `zcode-builtin:<revision>:<sha256(activeFilePath)>`**，否则 registry 合并循环里
 *      `s.basedOnZCodeBuiltinRevision !== o.zcodeBuiltinRevision` 静默跳过（不报错！），注入无效。
 *   3. session/setModel 切到 Start Plan（reasoning level 必填，GUI 默认 'max'）。
 *   4. agent 发模型请求前回调 interaction/requestProviderRuntimeHeaders 要鉴权 —— 回
 *      **zcodejwttoken**（共享凭证里的 `zcodejwttoken` 键）。oauth:zai:access_token 是过期的
 *      OAuth 会话 token，回它上游 401。
 *
 * @module lib/app-server.js
 */

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'

import { flattenConversation, lastUserText, materializeImages, removeFiles } from './messages.js'
import { readZaiPlanAuth, CredentialError } from './credentials.js'

const RUNTIME_PREFERENCES = {
  nativeSearchEnhancementsEnabled: false,
  memoryEnabled: false,
  askUserQuestionAutoResolutionEnabled: true,
  modelContextBudgetStrategy: 'preflight-v1',
}

/**
 * app-server 一个会话同时只允许一个在途回合。上一轮被中止 / 超时 / 静默丢弃时，它的回合锁
 * 不会自己释放，直接重发就被拒：`A prompt is already running for this session`。
 */
const STUCK_TURN_ERROR = /already running|already in flight|still running|in progress|is busy/i
/** 会话在 app-server 侧已经不存在（进程重启、被回收）—— 只能重建会话重放对话。 */
const STALE_SESSION_ERROR = /not found|unknown session|no such session|does not exist|invalid session/i
/** stop → 重试之间，给 agent 一点时间释放回合锁（毫秒）。 */
const STOP_SETTLE_MS = 1500
/**
 * 排队等上一轮的上限（毫秒）。DSH 自己就把同一会话的 prompt 串行了，所以真排到队通常意味着
 * 上一轮的生成器被弃用（消费方没走到 finally）—— 等久了不如放行，让撞锁恢复去处理。
 */
const TURN_QUEUE_MAX_MS = 60_000

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 等 promise 落定，最多 ms 毫秒；超时不算失败（回合排队用，避免死锁）。 */
function settleWithin(promise, ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    const done = () => {
      clearTimeout(timer)
      resolve()
    }
    promise.then(done, done)
  })
}

/** Start Plan 账户注入的 provider / 模型 / 推理档位（与 zcode-builtin.json 的 builtin 声明一致）。 */
export const START_PLAN_PROVIDER_ID = 'account:zai-start-plan'
export const START_PLAN_MODELS = ['GLM-5.3-Flash', 'GLM-5.2', 'GLM-5-Turbo']
const START_PLAN_REASONING_LEVEL = 'max'

/**
 * 定位 ZCode 的 zcode-builtin.json（GUI 同款运行时目录）。
 *
 * CLI 的 registry configSource 读 `<DSH_HOME>/…/.zcode/v2/runtime/provider/<platform>/<appVersion>/<endpointKey>/zcode-builtin.json`。
 * GUI 桌面客户端 spawn CLI 时会把 ZCODE_APP_VERSION / ZCODE_BUILTIN_PROVIDER_CONFIG_FILE
 * 指向它自己的版本目录；插件模拟这一行为，选「有 zcode-builtin.json 的最新版本目录」
 * （0.0.0-dev 是 CLI 裸跑的 fallback，GUI 的版本目录更新更活跃，优先非 dev 的）。
 */
export function resolveBuiltinRuntime(dataBaseDir) {
  const base = dataBaseDir ?? process.env.ZCODE_DATA_BASE_DIR?.trim() ?? os.homedir()
  const platformDir = process.platform === 'win32'
    ? `windows-${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}`
    : `${process.platform}-${process.arch}`
  const root = path.join(base, '.zcode', 'v2', 'runtime', 'provider', platformDir)
  let best
  let bestDev
  let entries
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return undefined
  }
  for (const versionDir of entries) {
    if (!versionDir.isDirectory()) continue
    let endpoints
    try {
      endpoints = fs.readdirSync(path.join(root, versionDir.name), { withFileTypes: true })
    } catch {
      continue
    }
    for (const endpointDir of endpoints) {
      if (!endpointDir.isDirectory() || !endpointDir.name.startsWith('endpoint-')) continue
      const full = path.join(root, versionDir.name, endpointDir.name, 'zcode-builtin.json')
      let stat
      try {
        stat = fs.statSync(full)
      } catch {
        continue
      }
      const candidate = { version: versionDir.name, activeFilePath: full, mtimeMs: stat.mtimeMs }
      if (versionDir.name === '0.0.0-dev') bestDev = candidate
      else if (best === undefined || stat.mtimeMs > best.mtimeMs) best = candidate
    }
  }
  return best ?? bestDev
}

/**
 * 计算 updateAccountConfig 要求的 basedOnZCodeBuiltinRevision。
 * registry 合并守卫做严格相等比较：`zcode-builtin:<release.revision>:<sha256(resolve(activeFilePath))>`，
 * 一个字符都不能差，否则注入被静默丢弃。
 */
export function computeBuiltinRevision(activeFilePath) {
  const release = JSON.parse(fs.readFileSync(activeFilePath, 'utf8'))
  const hash = createHash('sha256').update(path.resolve(activeFilePath)).digest('hex')
  return `zcode-builtin:${release.revision}:${hash}`
}

/**
 * Start Plan 账户注入配置（provider/updateAccountConfig）。
 * schema（CGt：providers 为 record(string, unknown)，但值经 Qtr→Tk/zj 二次解析）严格校验：
 *   - access 只接受 {type:'zhipu-account', entitled}（accountType/mode/api 会被拒）；
 *     accountType/mode/api 由 builtin config overlay 时自动保留，无需（也不能）在此声明。
 *   - states[s] 必须带 current（zhipu-account + entitled 的硬校验）。
 */
function buildAccountConfigPatch(basedOnRevision) {
  return {
    revision: `dsh-zcode-cli-proxy:${Date.now()}`,
    basedOnZCodeBuiltinRevision: basedOnRevision,
    providers: {
      [START_PLAN_PROVIDER_ID]: {
        access: { type: 'zhipu-account', entitled: true },
        builtinModelIds: [...START_PLAN_MODELS],
      },
    },
    states: {
      [START_PLAN_PROVIDER_ID]: {
        availability: 'available',
        entitled: true,
        current: true,
      },
    },
  }
}

/** 一个常驻 app-server 进程 + JSON-RPC 收发。 */
class AppServerClient {
  constructor({ options, logger }) {
    this.options = options
    this.logger = logger
    this.child = undefined
    this.nextId = 1
    this.pending = new Map()
    this.listeners = new Set()
    this.buffer = ''
    this.starting = undefined
    this.disposed = false
    /** 子进程退出时的回调：适配器用它丢弃已经失效的 app-server 会话映射。 */
    this.onExit = undefined
    /** 最近一次观察到的执行渠道，便于排查「烧的是哪个额度」。 */
    this.lastChannel = undefined
    /** spawn 时固定的 builtin 运行时（activeFilePath），注入时算 basedOn 用。 */
    this.builtin = undefined
  }

  async ensureStarted() {
    if (this.child !== undefined) return
    if (this.starting !== undefined) return this.starting
    this.starting = this.start().finally(() => {
      this.starting = undefined
    })
    return this.starting
  }

  async start() {
    const options = this.options()
    if (!fs.existsSync(options.zcodeCliPath)) {
      throw new LlmError(`找不到 ZCode CLI：${options.zcodeCliPath}`, 'PROVIDER')
    }
    // GUI 同款运行时目录：固定 builtin/personal 配置路径，让 CLI 的 configSource 与
    // 本插件注入层的 basedOnZCodeBuiltinRevision 指向同一个 zcode-builtin.json。
    this.builtin = resolveBuiltinRuntime(options.zcodeDataBaseDir || undefined)
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    // desktop-local 让 agent 把 headers 鉴权反向请求宿主（interaction/requestProviderRuntimeHeaders），
    // 而不是走本地 SHo（它只认 individual-coding-plan，start-plan 会直接抛错）
    env.ZCODE_SERVICE_AUTHORITY_MODE = 'desktop-local'
    if (this.builtin !== undefined) {
      env.ZCODE_APP_VERSION = this.builtin.version
      env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE = this.builtin.activeFilePath
      env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE = path.join(
        options.zcodeDataBaseDir?.trim() || os.homedir(), '.zcode', 'v2', 'provider_config.json')
      env.ZCODE_BASE_URL = 'https://zcode.z.ai'
      this.logger?.info?.(`zcode: builtin 运行时 ${this.builtin.version}（${this.builtin.activeFilePath}）`)
    } else {
      this.logger?.warn?.('zcode: 没找到 zcode-builtin.json（ZCode 未登录/未运行过？），Start Plan 注入可能失效')
    }

    // 注意：不能加 --browser-use headless —— app-server 只允许 -p/--target/tui 搭配该参数，
    // 加了会直接退出（code=1）。app-server 会话的浏览器走 interaction/browser* 向宿主要，
    // 宿主（本插件）回空列表/拒绝后该工具优雅降级为不可用。
    const child = spawn(options.zcodeCliNode, [options.zcodeCliPath, 'app-server', '--surface', 'terminal', '--no-color'], {
      cwd: options.cliCwd !== '' ? options.cliCwd : os.homedir(),
      env,
      windowsHide: true,
    })
    this.child = child
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => this.onData(chunk))
    child.stderr.on('data', (chunk) => {
      const text = String(chunk).trim()
      if (text !== '') this.logger?.debug?.(`zcode app-server: ${text.slice(0, 200)}`)
    })
    child.on('exit', (code) => {
      this.logger?.warn?.(`zcode app-server 退出（code=${code}），下次调用会重启`)
      for (const { reject } of this.pending.values()) reject(new LlmError('app-server 已退出', 'TRANSPORT'))
      this.pending.clear()
      this.child = undefined
      // 进程没了，缓存的 sessionId 全是悬空的：留着下一轮就是「会话不存在」
      try {
        this.onExit?.()
      } catch {
        /* 清理回调不影响收发 */
      }
    })
    // spawn 失败（node 路径不对、被沙箱拦成 EPERM…）是 'error' 事件：不接住就是未捕获异常，
    // 会把宿主进程一起带崩。接住后按普通失败处理，下一轮再试。
    child.on('error', (error) => {
      this.logger?.error?.(`zcode: app-server 启动失败：${error?.message ?? error}`)
      for (const { reject } of this.pending.values()) reject(new LlmError(`app-server 启动失败：${error?.message ?? error}`, 'TRANSPORT'))
      this.pending.clear()
      this.child = undefined
      try {
        this.onExit?.()
      } catch {
        /* 清理回调不影响收发 */
      }
    })
    this.logger?.info?.(`zcode: app-server 已启动（pid ${child.pid}）`)

    // 等 agent 运行时就绪：storageState 通知走完（phase=ready）或最多 8s。
    // 不等就 create+send 的话，回合会被静默丢弃（实测卡死在 send accepted 之后）。
    await new Promise((resolve) => {
      let settled = false
      const finish = () => {
        if (settled) return
        settled = true
        this.listeners.delete(listener)
        resolve()
      }
      const listener = (message) => {
        if (message.method === undefined) return
        const phase = message.params?.phase
        if (/^startup\//.test(String(message.method)) && (phase === 'ready' || phase === 'committing')) {
          this.ready = true
          finish()
        }
      }
      this.listeners.add(listener)
      setTimeout(finish, 8000)
    })
    this.logger?.info?.('zcode: app-server 运行时就绪')
    // 探测成功时的时序：就绪后还有 ~2.5s 的稳定期，这里照做
    await new Promise((resolve) => setTimeout(resolve, 2500))
    // GUI 同款：把 Start Plan 账户推给 agent（模型进 registry 需要 entitled:true）
    await this.injectAccountConfig()
  }

  onData(chunk) {
    this.buffer += chunk
    let index = this.buffer.indexOf('\n')
    while (index !== -1) {
      const line = this.buffer.slice(0, index).trim()
      this.buffer = this.buffer.slice(index + 1)
      index = this.buffer.indexOf('\n')
      if (line === '') continue
      let message
      try {
        message = JSON.parse(line)
      } catch {
        continue
      }
      this.dispatch(message)
    }
  }

  dispatch(message) {
    // 我方请求的响应
    if (message.id !== undefined && message.method === undefined) {
      const entry = this.pending.get(message.id)
      if (entry !== undefined) {
        this.pending.delete(message.id)
        if (message.error !== undefined) entry.reject(new LlmError(String(message.error.message ?? 'app-server 错误'), 'PROVIDER'))
        else entry.resolve(message.result)
      }
      return
    }
    // 服务端 → 客户端 的请求
    if (message.method !== undefined && message.id !== undefined) {
      this.logger?.info?.(`zcode: 收到服务端请求 ${message.method} ${JSON.stringify(message.params ?? {}).slice(0, 160)}`)
      if (message.method === 'session/requestRuntimePreferences') {
        this.write({ id: message.id, result: RUNTIME_PREFERENCES })
      } else if (message.method === 'interaction/requestProviderRuntimeHeaders') {
        // agent 模型请求前向宿主要鉴权（GUI 同款链路）：回 zcodejwttoken。
        // 注意是共享凭证里的 `zcodejwttoken`，不是 oauth:zai:access_token —— 那个是过期的
        // OAuth 会话 token，回它上游直接 401（实测）。
        this.handleRuntimeHeadersRequest(message).catch(() => {})
      } else if (message.method === 'interaction/requestPermission') {
        // DSH 场景下工具一律放行（权限由 DSH 侧管）。响应 schema（JL）是 strict 的：
        // 只接受 {decision:'allow'|'deny'|'escalate'|'modify', reason?, modifiedInput?, permissionUpdates?}，
        // 多余字段（如 approved/allow）会被 Zod 拒绝 → agent 视为批准失败 → Bash/浏览器被挡。
        this.write({ id: message.id, result: { decision: 'allow' } })
      } else if (message.method === 'interaction/browserList') {
        // 宿主不提供浏览器集成：回空列表，agent 回落到自带的 headless browser-use backend
        this.write({ id: message.id, result: { browsers: [] } })
      } else if (message.method === 'interaction/browserExecute') {
        this.write({
          id: message.id,
          result: { ok: false, error: { code: 'host_unavailable', message: '宿主不提供浏览器集成，请使用 agent 自带浏览器' } },
        })
      } else if (/approval|permission/i.test(message.method)) {
        // 其他权限类请求（未来新增的方法名）同样只回 decision
        this.write({ id: message.id, result: { decision: 'allow' } })
      } else {
        this.write({ id: message.id, result: {} })
      }
      return
    }
    // 通知
    if (message.method !== undefined) {
      for (const listener of this.listeners) {
        try {
          listener(message)
        } catch {
          /* 监听器异常不影响收发 */
        }
      }
    }
  }

  write(message) {
    this.child?.stdin.write(JSON.stringify(message) + '\n')
  }

  /**
   * 回应 interaction/requestProviderRuntimeHeaders：agent 在模型请求前向宿主要鉴权（GUI 同款）。
   * 响应结构与 zcode.cjs 的 DGt schema 一致：{ headersApplied, requestAuth:{apiKey,headers?} }。
   * agent 拿 apiKey 自己算 coding-plan 请求签名（x-client-sig 等），能过上游 WAF。
   */
  async handleRuntimeHeadersRequest(message) {
    try {
      const options = this.options()
      const auth = readZaiPlanAuth(options.zcodeDataBaseDir)
      this.logger?.info?.(`zcode: 返回 Start Plan 鉴权（activeProvider=${auth.activeProvider ?? '?'}，token ${auth.planToken.length} 字符）`)
      this.write({
        id: message.id,
        result: {
          headersApplied: true,
          requestAuth: {
            apiKey: auth.planToken,
            headers: {
              'http-referer': 'https://zcode.z.ai',
              'user-agent': 'ZCode/0.16.9',
              'x-zcode-app-version': '0.16.9',
              'x-title': 'Z Code@cli',
            },
          },
        },
      })
    } catch (error) {
      const detail = error instanceof CredentialError ? error.message : '宿主无法提供 Start Plan 鉴权'
      this.logger?.warn?.(`zcode: headers 请求失败 → ${detail}`)
      // 明确拒绝（headersApplied:false），让 agent 走自己的兜底，而不是挂死
      this.write({
        id: message.id,
        result: { headersApplied: false, errorMessage: detail },
      })
    }
  }

  /**
   * 向 agent 注入 Start Plan 账户（GUI 同款）：模型进 registry 需要 entitled:true。
   * basedOn 必须与 configSource 的 revision 串逐字符一致，否则合并被静默跳过。
   * 失败不致命（agent 冷启动时本来就没有 Start Plan，会兜底其他供应商）。
   */
  async injectAccountConfig() {
    const options = this.options()
    if (options.injectStartPlanAccount === false) return
    if (this.builtin === undefined) {
      this.logger?.warn?.('zcode: 跳过 Start Plan 注入（没有可用的 builtin 运行时）')
      return
    }
    try {
      const basedOn = computeBuiltinRevision(this.builtin.activeFilePath)
      const patch = buildAccountConfigPatch(basedOn)
      const result = await this.request('provider/updateAccountConfig', patch, options.appServerTimeoutMs)
      // status "unchanged" 也算成功（revision 没变时 yee.replace 直接拒了）。
      this.logger?.info?.(
        `zcode: Start Plan 账户已注入（providerCount=${result?.providerCount ?? '?'} status=${result?.status ?? '?'} basedOn=${basedOn.slice(0, 40)}…）`,
      )
    } catch (error) {
      this.logger?.warn?.(`zcode: Start Plan 账户注入失败（不影响默认通道）：${error?.message ?? error}`)
    }
  }

  request(method, params, timeoutMs) {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new LlmError(`app-server ${method} 超时（${timeoutMs}ms）`, 'TIMEOUT'))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        },
      })
      this.write({ id, method, params })
    })
  }

  onNotification(listener) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  notify(method, params) {
    this.write({ method, params })
  }

  dispose() {
    this.disposed = true
    try {
      this.child?.kill()
    } catch {
      /* 已经退了 */
    }
    this.child = undefined
  }
}

/** session/event 的 type 在 params 顶层（GUI 事件），部分遥测事件在 payload.type —— 两种都读。 */
function eventPayload(message) {
  const params = message.params ?? {}
  return { type: params.type ?? params.payload?.type, payload: params.payload ?? params }
}

/** app-server 版适配器：注册成 provider `zcode-cli` 的实现。 */
export class ZcodeAppServerAdapter extends LlmAdapter {
  /**
   * @param {() => object} [deps.resolveAttachments] 取 durable attachment 服务（读图片用）。
   */
  constructor({ options, resolveAttachments, logger }) {
    super()
    this.options = options
    this.resolveAttachments = resolveAttachments
    this.logger = logger
    this.client = new AppServerClient({ options, logger })
    /** DSH sessionId → app-server 会话条目 */
    this.sessions = new Map()
    /** DSH sessionId → 该会话最近一轮的收尾 Promise（同一会话的回合串行化闸门） */
    this.turnLocks = new Map()
    this.client.onExit = () => {
      if (this.sessions.size === 0) return
      this.logger?.warn?.(`zcode: app-server 进程已退出，丢弃 ${this.sessions.size} 个缓存会话`)
      this.sessions.clear()
    }
  }

  dispose() {
    this.client.dispose()
    this.sessions.clear()
    this.turnLocks.clear()
  }

  /**
   * 让 app-server 放弃该会话正在跑的回合（`session/stop` 是通知，没有响应）。
   * 只要本轮没有正常结束（超时 / 被中止 / 发送失败 / turn.failed）就必须补这一刀，
   * 否则那把回合锁一直占着，下一轮直接撞 `A prompt is already running for this session`。
   */
  stopTurn(session, reason) {
    if (session?.sessionId === undefined) return
    try {
      this.client.notify('session/stop', { sessionId: session.sessionId })
      this.logger?.warn?.(`zcode: 已补发 session/stop（${reason}）`)
    } catch (error) {
      this.logger?.warn?.(`zcode: session/stop 发送失败（${reason}）：${error?.message ?? error}`)
    }
  }

  providerInfo(provider) {
    return { id: provider, name: 'ZCode CLI（客户端 agent）' }
  }

  providerRetryPolicy() {
    return this.options().retryPolicy
  }

  listModels(provider) {
    return Promise.resolve(
      this.options().cliModels.map((model) => ({
        provider,
        id: model.id,
        name: model.name ?? model.id,
        // Start Plan 的 GLM 系列支持视觉输入（GUI config.json 里 modalities.input 含 image）
        inputModalities: ['text', 'image'],
      })),
    )
  }

  resolveModel(provider, model) {
    const options = this.options()
    const configured = options.cliModels.find((entry) => entry.id === model)
    return Promise.resolve({
      provider,
      id: model,
      name: configured?.name ?? model,
      inputModalities: ['text', 'image'],
      context: { contextWindow: configured?.contextWindow ?? options.defaultContextWindow },
      defaultMaxTokens: configured?.maxTokens ?? options.maxTokens,
    })
  }

  /** 建立（或复用）app-server 会话。 */
  async ensureSession(dshSessionKey) {
    const existing = this.sessions.get(dshSessionKey)
    if (existing !== undefined) return existing

    await this.client.ensureStarted()
    const options = this.options()
    // 工作目录默认用用户主目录：DSH 进程的 cwd 可能是一个巨大的目录树，
    // agent 启动时会扫描工作区，把几万个文件的目录灌给它会让回合卡死。
    const workspacePath = options.cliCwd !== '' ? options.cliCwd : os.homedir()
    const created = await this.client.request(
      'session/create',
      { workspace: { workspacePath, workspaceKey: 'dsh-zcode-cli-proxy' } },
      options.appServerTimeoutMs,
    )
    const sessionId = created?.session?.sessionId
    if (typeof sessionId !== 'string' || sessionId === '') {
      throw new LlmError('app-server 没有返回 sessionId', 'PROVIDER')
    }
    await this.client.request(
      'session/subscribe',
      { sessionId, deliveryKind: 'desktop-continuous', afterSeq: 0, includeSnapshot: true },
      options.appServerTimeoutMs,
    )
    // 切到 yolo：DSH 委派场景下没有人工批准的 UI，build 模式会让 Bash/浏览器等工具
    // 全部卡在 interaction/requestPermission 上。失败不致命（还有 requestPermission 放行兜底）。
    try {
      await this.client.request(
        'session/setMode',
        { sessionId, mode: 'yolo' },
        options.appServerTimeoutMs,
      )
      this.logger?.info?.('zcode: 会话权限模式已切到 yolo')
    } catch (error) {
      this.logger?.warn?.(`zcode: setMode 失败（继续用会话默认模式，靠 requestPermission 放行）：${error?.message ?? error}`)
    }
    // 显式把会话切到 Start Plan。注意顺序：先注入（刷新 registry），再 setModel。
    // 会话默认选择来自 provider_config.json 的 defaultModelSelection 或 registry-fallback，
    // 基源排前时会选中基源 → 显式 setModel 覆盖。失败不致命（继续用默认供应商）。
    await this.client.injectAccountConfig()
    // updateAccountConfig 只是 "received"（异步注册），等 registry 刷新完成再 setModel
    await new Promise((resolve) => setTimeout(resolve, 2000))
    try {
      // 0.16.9 的 setModel 要求对象式 model，且 reasoningLevel 必填（GUI 默认 max）
      await this.client.request(
        'session/setModel',
        {
          sessionId,
          model: {
            providerId: START_PLAN_PROVIDER_ID,
            modelId: START_PLAN_MODELS[0],
            options: { reasoningLevel: START_PLAN_REASONING_LEVEL },
          },
        },
        options.appServerTimeoutMs,
      )
      this.logger?.info?.(`zcode: 会话模型已切到 ${START_PLAN_PROVIDER_ID}/${START_PLAN_MODELS[0]}`)
    } catch (error) {
      this.logger?.warn?.(`zcode: setModel 失败（继续用会话默认模型）：${error?.message ?? error}`)
    }
    // 探测时序：create→subscribe、subscribe→send 之间各垫 1.5s。
    // 零延迟时回合会被静默丢弃（send accepted 后事件流为空，实测多次复现）。
    await new Promise((resolve) => setTimeout(resolve, 1500))
    const entry = { sessionId, firstTurn: true }
    this.sessions.set(dshSessionKey, entry)
    this.logger?.info?.(`zcode: 新建 app-server 会话 ${sessionId}`)
    return entry
  }

  /** 把一轮对话跑成流式迭代器。 */
  async *stream(options) {
    const config = this.options()

    if (options.purpose === 'session-title') {
      const title = (lastUserText(options.messages) || '新会话').replace(/\s+/g, ' ').slice(0, 24)
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: title }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: title } }
      yield { type: 'usage', usage: { inputTokens: 0, outputTokens: 0 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }

    const key = String(options.sessionId ?? 'default')
    if (this.client.disposed === true) {
      throw new LlmError('app-server 已销毁（插件被停用或正在重启），请重试', 'TRANSPORT')
    }

    // 回合串行化闸门：app-server 一个会话同时只允许一个在途 prompt，并发发第二条会被直接拒
    // （"A prompt is already running for this session"）。同一 DSH 会话的轮次排队跑。
    const previousTurn = this.turnLocks.get(key) ?? Promise.resolve()
    let releaseTurn = () => {}
    const turnDone = new Promise((resolve) => {
      releaseTurn = resolve
    })
    const tail = previousTurn.then(() => turnDone)
    this.turnLocks.set(key, tail)
    tail.catch(() => {}).then(() => {
      if (this.turnLocks.get(key) === tail) this.turnLocks.delete(key)
    })
    // 上一轮的生成器被弃用（消费方没走到 finally）时不能一直排队：等满上限就放行，
    // 真撞上没释放的回合锁，交给下面的撞锁恢复处理。
    await settleWithin(previousTurn, TURN_QUEUE_MAX_MS)

    // 事件队列：把 session/event 转成流式 chunk
    const queue = []
    let notify = () => {}
    const waitFor = () => new Promise((resolve) => (notify = resolve))
    let finished = undefined
    let channel = undefined
    let usage = { inputTokens: 0, outputTokens: 0 }
    let sawText = false
    let off = () => {}
    let imageCtx = { files: [], tempFiles: [], imageText: new Map() }
    const tempFiles = [] // 本轮落盘的临时图片（撞锁恢复可能重算 imageCtx，统一在这里收口删除）
    let turnSettled = false

    let session = undefined
    try {
      session = await this.ensureSession(key)
    } catch (error) {
      releaseTurn()
      throw error
    }

    off = this.client.onNotification((message) => {
      if (message.method !== 'session/event') return
      const params = message.params ?? {}
      // session 会在撞锁恢复时被换成新会话：只认当前这个 sessionId
      if (session === undefined || params.sessionId !== session.sessionId) return
      const { type, payload } = eventPayload(message)
      switch (type) {
        case 'session.updated':
          if (typeof payload.baseURL === 'string') {
            channel = { providerId: payload.providerId, modelId: payload.modelId, baseURL: payload.baseURL }
            this.client.lastChannel = channel
          }
          break
        case 'model.streaming': {
          if (payload.done === true) break
          if (payload.kind === 'text_delta') {
            sawText = true
            queue.push({ kind: 'text', text: String(payload.delta ?? '') })
          } else if (payload.kind === 'reasoning_delta') {
            queue.push({ kind: 'reasoning', text: String(payload.delta ?? '') })
          }
          notify()
          break
        }
        case 'turn.completed': {
          if (payload.usage !== undefined) {
            usage = {
              inputTokens: payload.usage.inputTokens ?? 0,
              outputTokens: payload.usage.outputTokens ?? 0,
              ...(payload.usage.cacheReadTokens === undefined ? {} : { cacheReadTokens: payload.usage.cacheReadTokens }),
            }
          }
          finished = {
            response: typeof payload.response === 'string' ? payload.response : '',
            resultType: payload.resultType ?? 'success',
            error: undefined,
          }
          notify()
          break
        }
        case 'turn.failed': {
          // 不处理的话回合会挂到超时；带出上游错误（402 余额不足 / 401 鉴权失败等）
          const attribution = payload.error?.attribution ?? {}
          const detail = payload.error?.message ?? payload.error?.code ?? 'unknown'
          this.logger?.warn?.(
            `zcode: 回合失败（${attribution.providerId ?? '?'}/${attribution.modelId ?? '?'} ${attribution.providerErrorCode ?? ''} ${detail}）`,
          )
          finished = { response: '', resultType: 'failed', error: detail }
          notify()
          break
        }
        default:
          break
      }
    })

    // 图片块 → 落成本地文件，content 里给出路径并让 agent 用 Read 读图（CLI 端读图会转成
    // 视觉输入块）。实测结论：data-URL 内嵌 content 与 session/send attachments 参数
    // （ref=本地路径）都不行——前者被 agent 当文件引用 Read 失败，后者 ref 服务端解析不了。
    // 临时文件要等回合结束才能删（agent 在回合内异步读文件），清理挂在生成器 finally。
    const attachmentsService = typeof this.resolveAttachments === 'function' ? this.resolveAttachments() : undefined
    /** 按会话新旧取需要落盘图片的消息范围：新会话带整段历史，续接只要最后一条用户消息。 */
    const attachImages = async (fullHistory) => {
      const source = fullHistory ? options.messages : (options.messages ?? []).filter((m) => m?.role === 'user').slice(-1)
      const ctx = await materializeImages(source, { attachments: attachmentsService, logger: this.logger })
      tempFiles.push(...ctx.tempFiles)
      return ctx
    }
    try {
      imageCtx = await attachImages(session.firstTurn)
    } catch (error) {
      off()
      releaseTurn()
      throw error
    }

    /** 拼本轮 content：新会话（firstTurn）重放整段对话，续接会话只发最后一条用户消息。 */
    const buildContent = (entry, ctx) => {
      const text = entry.firstTurn
        ? flattenConversation(options.messages, options.system, ctx.imageText) || lastUserText(options.messages, ctx.imageText)
        : lastUserText(options.messages, ctx.imageText)
      if (ctx.files.length === 0) return text || '（继续）'
      const listing = ctx.files.map((file, i) => `#${i + 1} ${file}`).join('\n')
      return `${text || '（继续）'}\n\n[图片附件] 本条消息附有 ${ctx.files.length} 张本地图片（对应上文 [图片 #k] 占位）：\n${listing}\n回答前请先用 Read 工具逐张读取这些图片。`
    }
    if (imageCtx.files.length > 0) this.logger?.info?.(`zcode: 图片附件 ×${imageCtx.files.length} 已随消息附上`)
    if (session.firstTurn) await sleep(1500) // 探测时序垫片（见 ensureSession）

    try {
      // 发送 + 撞锁恢复：app-server 的回合锁在上一轮被中止 / 超时时不会自己释放，
      // 直接重发就是 "A prompt is already running for this session"。先补发 stop 再试一次；
      // 还不行（或会话已被 app-server 回收）就换新会话——新会话 firstTurn=true，重放整段对话。
      let sendResult
      for (let attempt = 0; ; attempt += 1) {
        try {
          sendResult = await this.client.request(
            'session/send',
            { sessionId: session.sessionId, content: buildContent(session, imageCtx) },
            config.appServerTimeoutMs,
          )
          session.firstTurn = false // 只有真的送出去了才算续接会话；失败时保留 firstTurn 以便重放
          this.logger?.info?.(`zcode: session/send -> ${JSON.stringify(sendResult).slice(0, 200)}`)
          break
        } catch (error) {
          const detail = String(error?.message ?? error)
          const stuck = STUCK_TURN_ERROR.test(detail)
          const stale = !stuck && STALE_SESSION_ERROR.test(detail)
          if (attempt >= 1 || (!stuck && !stale)) throw error
          if (stuck) {
            this.logger?.warn?.(`zcode: 会话 ${session.sessionId} 上一轮未释放（${detail}）→ 补发 session/stop 后重试`)
            this.stopTurn(session, '上一轮未释放')
            await sleep(STOP_SETTLE_MS)
          } else {
            this.logger?.warn?.(`zcode: 会话 ${session.sessionId} 已失效（${detail}）→ 重建会话并重放整段对话`)
            this.sessions.delete(key)
            session = await this.ensureSession(key)
            imageCtx = await attachImages(true)
          }
        }
      }

      let started = false
      const deadline = Date.now() + config.zcodeCliTimeoutMs
      while (finished === undefined) {
        while (queue.length > 0) {
          const item = queue.shift()
          if (item.kind === 'text') {
            if (!started) {
              started = true
              yield { type: 'block-start', index: 1, blockType: 'text' }
            }
            yield { type: 'text-delta', index: 1, text: item.text }
          } else {
            yield { type: 'reasoning-delta', index: 0, text: item.text }
          }
        }
        if (finished !== undefined) break
        if (Date.now() > deadline) throw new LlmError(`app-server 回合超时（${config.zcodeCliTimeoutMs}ms）`, 'TIMEOUT')
        // stop 由 finally 统一补发：任何提前离开等待循环的路径都得把 app-server 的回合锁放掉
        if (options.signal?.aborted === true) throw new LlmError('请求被调用方中止', 'ABORTED')
        await Promise.race([waitFor(), new Promise((resolve) => setTimeout(resolve, 500))])
      }
      // 只有 turn.completed 才算回合正常结束；turn.failed 也补一次 stop 兜底
      turnSettled = finished.resultType === 'success'

      // 刷新剩余队列
      while (queue.length > 0) {
        const item = queue.shift()
        if (item.kind === 'text') {
          if (!started) {
            started = true
            yield { type: 'block-start', index: 1, blockType: 'text' }
          }
          yield { type: 'text-delta', index: 1, text: item.text }
        } else {
          yield { type: 'reasoning-delta', index: 0, text: item.text }
        }
      }

      const finalText = finished.response !== '' ? finished.response : ''
      if (started) {
        yield { type: 'block-end', index: 1, block: { type: 'text', text: finalText } }
      }
      if (channel !== undefined) {
        this.logger?.info?.(
          `zcode: 本轮执行渠道 providerId=${channel.providerId ?? '?'} model=${channel.modelId ?? '?'} baseURL=${channel.baseURL ?? '?'}`,
        )
      }
      yield { type: 'usage', usage }
      if ((finished.resultType !== 'success' && finalText === '') || finished.error !== undefined) {
        yield {
          type: 'finish',
          reason: {
            kind: 'error',
            failure: {
              message: finished.error !== undefined
                ? `ZCode Start Plan 回合失败：${finished.error}`
                : `app-server 回合以 ${finished.resultType} 结束`,
              code: 'PROVIDER',
            },
          },
        }
        return
      }
      yield {
        type: 'finish',
        reason: { kind: 'stop' },
        replayState: {
          response: { model: options.model, stopReason: 'end_turn' },
          blocks: [null, null],
          ...(channel === undefined ? {} : { channel }),
        },
      }
    } finally {
      off()
      if (!turnSettled) this.stopTurn(session, '本轮未正常结束（超时 / 中止 / 发送失败 / 回合失败）')
      removeFiles(tempFiles) // 回合结束才删（agent 读图发生在回合内）
      releaseTurn()          // 放行同一 DSH 会话排队的下一轮
    }
  }
}
