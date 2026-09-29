/**
 * 「委派型」模型提供方：把 DSH 的模型请求交给 ZCode 客户端自带的 agent（zcode.cjs）执行。
 *
 * 为什么这样设计：
 *   - ZCode 的计划端点被阿里云无痕验证 + 风控保护，外部 HTTP 请求一律 3007/3012；而客户端
 *     自带的 CLI 用的是它自己的凭证与验证码链路，实测可用。
 *   - CLI 本身是一个 agent（自带 Bash/Edit/Read 等工具）。实测「提示词约定 tool_calls JSON」
 *     这条路走不通：GLM-5.3 会把它识别成提示词注入并拒答。所以这个 provider 不做工具调用，
 *     而是把 DSH 的对话**委派**给 CLI agent，拿回它的最终答复。
 *   - 多轮：按 DSH 的 sessionId 记住 CLI 的 sessionId，后续轮次用 `--resume` 只发新增消息，
 *     既保持上下文又省 token（否则每轮要重发整段 + CLI 自身约 18k 的系统提示）。
 *
 * 适用：想用 ZCode/GLM 额度做对话与「让 ZCode agent 干活」；不适配需要 DSH 自身工具循环的场景。
 *
 * @module lib/cli-provider.js
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'

/** CLI 会话映射的存活时间（超过就当作失效，重新灌上下文）。 */
const CLI_SESSION_TTL_MS = 6 * 60 * 60 * 1000

function flattenContent(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => {
      if (block === null || typeof block !== 'object') return ''
      if (block.type === 'text') return block.text ?? ''
      if (block.type === 'image') return '[图片]'
      if (block.type === 'tool-call') return `[调用工具 ${block.name}]`
      if (block.type === 'reasoning') return ''
      return ''
    })
    .filter((text) => text !== '')
    .join('\n')
}

/** 把 DSH 的对话拍平成一段可读文本（首轮或 resume 失效时使用）。 */
export function flattenConversation(messages, system) {
  const parts = []
  if (typeof system === 'string' && system.trim() !== '') parts.push(`# 系统提示\n${system.trim()}`)
  for (const message of messages ?? []) {
    const content = message.content ?? []
    if (message.role === 'system') {
      const text = flattenContent(content)
      if (text !== '') parts.push(`# 系统提示\n${text}`)
      continue
    }
    if (message.role === 'assistant') {
      const text = flattenContent(content)
      const calls = content
        .filter((block) => block !== null && typeof block === 'object' && block.type === 'tool-call')
        .map((block) => `[调用工具 ${block.name}(${block.arguments ?? ''})]`)
      const body = [text, ...calls].filter((value) => value !== '').join('\n')
      if (body !== '') parts.push(`# 助手\n${body}`)
      continue
    }
    const toolResults = content.filter((block) => block !== null && typeof block === 'object' && block.type === 'tool-result')
    for (const result of toolResults) {
      parts.push(`# 工具结果\n${flattenContent(result.content)}`)
    }
    const text = flattenContent(content)
    if (text !== '') parts.push(`# 用户\n${text}`)
  }
  return parts.join('\n\n')
}

/** 取最后一条用户消息（resume 时只发这一条）。 */
export function lastUserText(messages) {
  for (let index = (messages?.length ?? 0) - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role === 'user') {
      const text = flattenContent(message.content)
      if (text !== '') return text
    }
  }
  return ''
}

/** 本地生成会话标题，避免为一句话标题去调用一次 CLI（15s + 额度）。 */
function localTitle(messages) {
  const text = lastUserText(messages).replace(/\s+/g, ' ').trim()
  if (text === '') return '新会话'
  return text.length > 24 ? `${text.slice(0, 24)}…` : text
}

export class ZcodeCliAdapter extends LlmAdapter {
  /**
   * @param {object} deps
   * @param {() => object} deps.options 解析后的插件配置。
   * @param {object} [deps.logger]
   */
  constructor({ options, logger }) {
    super()
    this.options = options
    this.logger = logger
    /** DSH sessionId → { cliSessionId, at } */
    this.sessions = new Map()
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

  /** 跑一次 CLI，返回解析后的 JSON 与耗时。 */
  runCli({ prompt, attachments, cwd, mode, resume, signal }) {
    const options = this.options()
    const timeoutMs = Number.isFinite(options.zcodeCliTimeoutMs) && options.zcodeCliTimeoutMs > 0
      ? options.zcodeCliTimeoutMs
      : 600000
    const cliArgs = [
      options.zcodeCliPath,
      '-p',
      prompt,
      '--json',
      '--surface',
      'terminal',
      '--no-color',
      '--mode',
      mode,
    ]
    if (resume !== undefined) cliArgs.push('--resume', resume)
    if (cwd !== undefined && cwd !== '') cliArgs.push('--cwd', cwd)
    for (const file of attachments ?? []) cliArgs.push('--attach', file)

    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE

    const started = Date.now()
    return new Promise((resolve, reject) => {
      const child = spawn(options.zcodeCliNode, cliArgs, {
        cwd: cwd !== undefined && cwd !== '' ? cwd : options.cliCwd || process.cwd(),
        env,
        windowsHide: true,
      })
      let stdout = ''
      let stderr = ''
      const timer = setTimeout(() => {
        try {
          child.kill()
        } catch {}
        reject(new LlmError(`ZCode CLI 超时（${timeoutMs}ms）`, 'TIMEOUT'))
      }, timeoutMs)

      const onAbort = () => {
        try {
          child.kill()
        } catch {}
      }
      signal?.addEventListener('abort', onAbort, { once: true })

      child.stdout.on('data', (chunk) => (stdout += chunk))
      child.stderr.on('data', (chunk) => (stderr += chunk))
      child.on('error', (error) => {
        clearTimeout(timer)
        reject(new LlmError(`无法启动 ZCode CLI：${error.message}`, 'TRANSPORT', { cause: error }))
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        const text = stdout.trim()
        const start = text.indexOf('{')
        if (start === -1) {
          reject(new LlmError(`ZCode CLI 没有输出 JSON（退出码 ${code}）：${(stderr || text).slice(0, 300)}`, 'PROVIDER'))
          return
        }
        try {
          resolve({ parsed: JSON.parse(text.slice(start)), elapsedMs: Date.now() - started, stderr })
        } catch (error) {
          reject(new LlmError(`ZCode CLI 输出不是合法 JSON：${text.slice(0, 200)}`, 'PROVIDER', { cause: error }))
        }
      })
    })
  }

  async *stream(options) {
    const config = this.options()
    if (config.zcodeCliPath === '' || !fs.existsSync(config.zcodeCliPath)) {
      throw new LlmError(
        `找不到 ZCode CLI（配置 zcodeCliPath，当前 "${config.zcodeCliPath}"）`,
        'PROVIDER',
      )
    }

    // 辅助调用（会话标题）本地生成，省一次 15s + 额度的 CLI 调用
    if (options.purpose === 'session-title') {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: localTitle(options.messages) }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: localTitle(options.messages) } }
      yield { type: 'usage', usage: { inputTokens: 0, outputTokens: 0 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }

    const sessionKey = String(options.sessionId ?? 'default')
    const remembered = this.sessions.get(sessionKey)
    const fresh = remembered !== undefined && Date.now() - remembered.at < CLI_SESSION_TTL_MS
    const latest = lastUserText(options.messages)
    const resumedPrompt = latest === '' ? '（继续）' : latest

    /**
     * 统一派发：整段历史超过命令行安全长度（Windows 32767 字符）时，
     * 把历史写进临时文件并用 `--attach` 附件带给 CLI——旧 DSH 会话切过来时
     * 历史往往远超限制，直接塞进 `-p` 会 spawn ENAMETOOLONG。
     */
    const dispatch = async ({ prompt, resume, signal }) => {
      let attachments
      let effectivePrompt = prompt
      if (prompt.length > 24000) {
        attachments = [
          path.join(os.tmpdir(), `zcode2api-history-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.md`),
        ]
        fs.writeFileSync(attachments[0], prompt, 'utf8')
        effectivePrompt =
          '附件里是本轮对话之前的完整历史（系统提示、历轮对话与工具结果）。' +
          '请先阅读附件掌握上下文，然后回答最新的用户请求：\n\n' + (latest || '（继续）')
        this.logger?.info?.(`zcode-cli: 历史过长（${prompt.length} 字符），改用附件 ${attachments[0]}`)
      }
      try {
        return await this.runCli({
          prompt: effectivePrompt,
          attachments,
          cwd: config.cliCwd,
          mode: config.cliMode,
          resume,
          signal,
        })
      } finally {
        if (attachments !== undefined) {
          for (const file of attachments) {
            try {
              fs.unlinkSync(file)
            } catch {
              /* 清理失败无妨（临时目录） */
            }
          }
        }
      }
    }

    let result
    if (fresh) {
      try {
        result = await dispatch({ prompt: resumedPrompt, resume: remembered.cliSessionId, signal: options.signal })
      } catch (error) {
        this.logger?.warn?.(`zcode-cli: 续接会话失败，改为整段重发（${error?.message ?? error}）`)
        this.sessions.delete(sessionKey)
        result = undefined
      }
    }
    if (result === undefined) {
      result = await dispatch({
        prompt: flattenConversation(options.messages, options.system) || resumedPrompt,
        signal: options.signal,
      })
    }

    const text = typeof result.parsed.response === 'string' ? result.parsed.response : ''
    if (result.parsed.sessionId !== undefined) {
      this.sessions.set(sessionKey, { cliSessionId: result.parsed.sessionId, at: Date.now() })
    }
    if (text === '') {
      yield { type: 'usage', usage: { inputTokens: result.parsed.usage?.inputTokens ?? 0, outputTokens: 0 } }
      yield {
        type: 'finish',
        reason: { kind: 'error', failure: { message: 'ZCode CLI 返回了空答复', code: 'EMPTY_RESPONSE' } },
      }
      return
    }

    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield {
      type: 'usage',
      usage: {
        inputTokens: result.parsed.usage?.inputTokens ?? 0,
        outputTokens: result.parsed.usage?.outputTokens ?? 0,
        ...(result.parsed.usage?.cacheReadTokens === undefined
          ? {}
          : { cacheReadTokens: result.parsed.usage.cacheReadTokens }),
      },
    }
    yield {
      type: 'finish',
      reason: { kind: 'stop' },
      replayState: {
        response: { messageId: result.parsed.turnId, model: options.model, stopReason: 'end_turn' },
        blocks: [null],
      },
    }
  }
}
