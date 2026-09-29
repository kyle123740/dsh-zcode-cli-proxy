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
 *   session/send {sessionId, content}
 *   事件       session/event → params.payload.type: session.titleUpdated | turn.started | session.updated
 *              | model.streaming{kind,delta,done} | turn.completed{response,usage,resultType}
 *
 * @module lib/app-server.js
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'

import { LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'

import { flattenConversation, lastUserText } from './cli-provider.js'

const RUNTIME_PREFERENCES = {
  nativeSearchEnhancementsEnabled: false,
  memoryEnabled: false,
  askUserQuestionAutoResolutionEnabled: true,
  modelContextBudgetStrategy: 'preflight-v1',
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
    /** 最近一次观察到的执行渠道，便于排查「烧的是哪个额度」。 */
    this.lastChannel = undefined
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
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE

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
      } else if (/permission|approval/i.test(message.method)) {
        // 尽量放行（provider 场景下 DSH 自己管权限）；失败也不致命
        this.write({ id: message.id, result: { decision: 'allow', approved: true, allow: true } })
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

/** app-server 版适配器：注册成 provider `zcode-cli` 的实现。 */
export class ZcodeAppServerAdapter extends LlmAdapter {
  constructor({ options, logger }) {
    super()
    this.options = options
    this.logger = logger
    this.client = new AppServerClient({ options, logger })
    /** DSH sessionId → app-server sessionId */
    this.sessions = new Map()
  }

  dispose() {
    this.client.dispose()
    this.sessions.clear()
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
        inputModalities: ['text'],
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
      inputModalities: ['text'],
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
      { workspace: { workspacePath, workspaceKey: 'dsh-zcode2api' } },
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
    const session = this.client.disposed === true ? undefined : await this.ensureSession(key)

    // 事件队列：把 session/event 转成流式 chunk
    const queue = []
    let notify = () => {}
    const waitFor = () => new Promise((resolve) => (notify = resolve))
    let finished = undefined
    let channel = undefined
    let usage = { inputTokens: 0, outputTokens: 0 }
    let sawReasoning = false
    let sawText = false

    const off = this.client.onNotification((message) => {
      if (message.method !== 'session/event') return
      const params = message.params ?? {}
      if (params.sessionId !== session.sessionId) return
      const payload = params.payload ?? {}
      switch (payload.type) {
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
            sawReasoning = true
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
          }
          notify()
          break
        }
        default:
          break
      }
    })

    const first = session.firstTurn
    const content = first ? flattenConversation(options.messages, options.system) || lastUserText(options.messages) : lastUserText(options.messages)
    session.firstTurn = false
    if (first) await new Promise((resolve) => setTimeout(resolve, 1500)) // 探测时序垫片（见 ensureSession）

    try {
      const sendResult = await this.client.request(
        'session/send',
        { sessionId: session.sessionId, content: content || '（继续）' },
        config.appServerTimeoutMs,
      )
      this.logger?.info?.(`zcode: session/send -> ${JSON.stringify(sendResult).slice(0, 200)}`)

      let textIndex = 0
      let reasoningIndex = 0
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
          textIndex += 1
          reasoningIndex += item.kind === 'reasoning' ? 1 : 0
        }
        if (finished !== undefined) break
        if (Date.now() > deadline) throw new LlmError(`app-server 回合超时（${config.zcodeCliTimeoutMs}ms）`, 'TIMEOUT')
        if (options.signal?.aborted === true) {
          this.client.notify('session/stop', { sessionId: session.sessionId })
          throw new LlmError('请求被调用方中止', 'ABORTED')
        }
        await Promise.race([waitFor(), new Promise((resolve) => setTimeout(resolve, 500))])
      }

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
      if (finished.resultType !== 'success' && finalText === '') {
        yield {
          type: 'finish',
          reason: { kind: 'error', failure: { message: `app-server 回合以 ${finished.resultType} 结束`, code: 'PROVIDER' } },
        }
        return
      }
      yield {
        type: 'finish',
        reason: { kind: 'stop' },
        replayState: {
          response: { messageId: undefined, model: options.model, stopReason: 'end_turn' },
          blocks: [null, null],
          ...(channel === undefined ? {} : { channel }),
        },
      }
    } finally {
      off()
    }
  }
}
