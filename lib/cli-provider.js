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

import { LlmAdapter, LlmError, offloadedImageText } from '@deepseek-ai/dsh-llm'

/** CLI 会话映射的存活时间（超过就当作失效，重新灌上下文）。 */
const CLI_SESSION_TTL_MS = 6 * 60 * 60 * 1000

/** 临时图片文件的扩展名（CLI 端同时按魔数嗅探，扩展名只是兜底）。 */
const IMAGE_EXTENSIONS = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
}

/**
 * 把消息里的图片块落成 CLI 可用的附件，返回 { imageText, files, tempFiles }。
 *   - imageText：Map<image 块, 占位文本>，flatten 时替换 `type:'image'` 块；
 *   - files：传给 `--attach` 的图片文件列表（顺序即占位符编号）；
 *   - tempFiles：files 里属于本函数新建的临时文件（调用后删除）；
 *     imageHostPath 直读后端给出的是 attachment 服务的宿主文件，只附不删。
 *
 * DSH 的 image 块持有 durable attachment 引用（block.attachment），不直接带字节：
 *   - offloaded 块已经是文本形态 → offloadedImageText 占位，不产生附件；
 *   - 宿主文件直读后端 → imageHostPath 拿现成路径（零拷贝）；
 *   - 否则 readImage 读字节 → 写临时文件。
 */
export async function materializeImages(messages, { attachments, logger }) {
  const imageText = new Map()
  const files = []
  const tempFiles = []
  if (attachments === undefined) return { imageText, files, tempFiles }
  let index = 0
  for (const message of messages ?? []) {
    for (const block of message?.content ?? []) {
      if (block === null || typeof block !== 'object' || block.type !== 'image') continue
      if (block.offloaded === true) {
        imageText.set(block, offloadedImageText(block.attachment))
        continue
      }
      try {
        let file = attachments.imageHostPath?.(block.attachment)
        if (file === undefined) {
          const stored = await attachments.readImage(block.attachment)
          const ext = IMAGE_EXTENSIONS[stored.ref?.mediaType] ?? '.png'
          file = path.join(os.tmpdir(), `zcode2api-img-${Date.now()}-${index + 1}${ext}`)
          fs.writeFileSync(file, Buffer.from(stored.data))
          tempFiles.push(file)
        }
        index += 1
        files.push(file)
        imageText.set(block, `[图片 #${index}]`)
      } catch (error) {
        logger?.warn?.(`zcode-cli: 读取图片附件失败（${error?.message ?? error}）`)
        imageText.set(block, '[图片（读取失败）]')
      }
    }
  }
  return { imageText, files, tempFiles }
}

/** 删除临时图片文件（尽力而为）。 */
export function removeFiles(files) {
  for (const file of files ?? []) {
    try {
      fs.unlinkSync(file)
    } catch {
      /* 清理失败无妨（临时目录） */
    }
  }
}

function flattenContent(content, imageText) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => {
      if (block === null || typeof block !== 'object') return ''
      if (block.type === 'text') return block.text ?? ''
      if (block.type === 'image') return imageText?.get(block) ?? '[图片]'
      if (block.type === 'tool-call') return `[调用工具 ${block.name}]`
      if (block.type === 'reasoning') return ''
      return ''
    })
    .filter((text) => text !== '')
    .join('\n')
}

/** 把 DSH 的对话拍平成一段可读文本（首轮或 resume 失效时使用）。 */
export function flattenConversation(messages, system, imageText) {
  const parts = []
  if (typeof system === 'string' && system.trim() !== '') parts.push(`# 系统提示\n${system.trim()}`)
  for (const message of messages ?? []) {
    const content = message.content ?? []
    if (message.role === 'system') {
      const text = flattenContent(content, imageText)
      if (text !== '') parts.push(`# 系统提示\n${text}`)
      continue
    }
    if (message.role === 'assistant') {
      const text = flattenContent(content, imageText)
      const calls = content
        .filter((block) => block !== null && typeof block === 'object' && block.type === 'tool-call')
        .map((block) => `[调用工具 ${block.name}(${block.arguments ?? ''})]`)
      const body = [text, ...calls].filter((value) => value !== '').join('\n')
      if (body !== '') parts.push(`# 助手\n${body}`)
      continue
    }
    const toolResults = content.filter((block) => block !== null && typeof block === 'object' && block.type === 'tool-result')
    for (const result of toolResults) {
      parts.push(`# 工具结果\n${flattenContent(result.content, imageText)}`)
    }
    const text = flattenContent(content, imageText)
    if (text !== '') parts.push(`# 用户\n${text}`)
  }
  return parts.join('\n\n')
}

/** 取最后一条用户消息（resume 时只发这一条）。 */
export function lastUserText(messages, imageText) {
  for (let index = (messages?.length ?? 0) - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role === 'user') {
      const text = flattenContent(message.content, imageText)
      if (text !== '') return text
    }
  }
  return ''
}

/** 最后一条用户消息的下标（没有则 -1）。 */
function lastUserIndex(messages) {
  for (let index = (messages?.length ?? 0) - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'user') return index
  }
  return -1
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
   * @param {() => object} [deps.resolveAttachments] 取 durable attachment 服务（读图片用）。
   * @param {object} [deps.logger]
   */
  constructor({ options, resolveAttachments, logger }) {
    super()
    this.options = options
    this.resolveAttachments = resolveAttachments
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
      // 一次性调用允许启用 agent 自带的 headless 浏览器（app-server 模式不支持该参数）
      '--browser-use',
      'headless',
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

    // 图片块 → 附件。resume 只带最新一条用户消息的图（历史图已在 CLI 会话上下文里）；
    // 整段重发带全部。没有 attachments 服务时图片块退化为 '[图片]' 占位。
    const attachmentsService = typeof this.resolveAttachments === 'function' ? this.resolveAttachments() : undefined
    const materialize = (messages) => materializeImages(messages, { attachments: attachmentsService, logger: this.logger })

    /**
     * 统一派发：整段历史超过命令行安全长度（Windows 32767 字符）时，
     * 把历史写进临时文件并用 `--attach` 附件带给 CLI——旧 DSH 会话切过来时
     * 历史往往远超限制，直接塞进 `-p` 会 spawn ENAMETOOLONG。
     * 图片附件（imageFiles）由调用方 materialize 出来，临时文件由调用方清理。
     */
    const dispatch = async ({ prompt, resume, signal, imageFiles }) => {
      let historyFile
      const attachments = [...(imageFiles ?? [])]
      let effectivePrompt = prompt
      if (prompt.length > 24000) {
        historyFile = path.join(os.tmpdir(), `zcode2api-history-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.md`)
        fs.writeFileSync(historyFile, prompt, 'utf8')
        attachments.unshift(historyFile)
        const latestText = lastUserText(options.messages, imageTextOf(options.messages, imageFiles))
        effectivePrompt =
          '附件里是本轮对话之前的完整历史（系统提示、历轮对话与工具结果）。' +
          '请先阅读附件掌握上下文，然后回答最新的用户请求：\n\n' + (latestText || '（继续）')
        this.logger?.info?.(`zcode-cli: 历史过长（${prompt.length} 字符），改用附件 ${historyFile}`)
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
        if (historyFile !== undefined) removeFiles([historyFile])
      }
    }

    let result
    if (fresh) {
      const lastIdx = lastUserIndex(options.messages)
      const imageCtx = await materialize(lastIdx >= 0 ? [options.messages[lastIdx]] : [])
      try {
        const latest = lastUserText(options.messages, imageCtx.imageText)
        result = await dispatch({
          prompt: latest === '' ? '（继续）' : latest,
          resume: remembered.cliSessionId,
          signal: options.signal,
          imageFiles: imageCtx.files,
        })
      } catch (error) {
        this.logger?.warn?.(`zcode-cli: 续接会话失败，改为整段重发（${error?.message ?? error}）`)
        this.sessions.delete(sessionKey)
        result = undefined
      } finally {
        removeFiles(imageCtx.tempFiles)
      }
    }
    if (result === undefined) {
      const imageCtx = await materialize(options.messages)
      try {
        const prompt = flattenConversation(options.messages, options.system, imageCtx.imageText)
        result = await dispatch({
          prompt: prompt !== '' ? prompt : '（继续）',
          signal: options.signal,
          imageFiles: imageCtx.files,
        })
      } finally {
        removeFiles(imageCtx.tempFiles)
      }
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
