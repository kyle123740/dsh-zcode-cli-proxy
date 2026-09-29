/**
 * zcode2api 的 Anthropic Messages 适配器。
 *
 * zcode2api 网关把 ZCode / Z.AI 的上游原样透传成 Anthropic Messages 协议
 * （`POST /v1/messages`，SSE 流式），所以这一侧只需要：
 *   1. 把 Harness 的 options 序列化成 Anthropic wire 请求；
 *   2. 把 Anthropic 的 SSE 事件翻译回 Harness 的 StreamChunk。
 *
 * 刻意不依赖 `@anthropic-ai/sdk`：网关就在本机，直接用 fetch + 手写 SSE 解析，
 * 插件因此只剩 DSH 自带的 peer 依赖，装进任何 profile 都不会多出第三方包。
 *
 * @module lib/anthropic-adapter.js
 */

import {
  CONTEXT_WINDOW_EXCEEDED_CODE,
  EMPTY_RESPONSE_CODE,
  LlmAdapter,
  LlmError,
  QUOTA_EXCEEDED_CODE,
  ToolCallId,
  contentHasImage,
  isContextWindowExceededError,
  isQuotaExceededError,
  offloadedImageText,
} from '@deepseek-ai/dsh-llm'

/** 流式空闲超时的错误码（网关卡住时让 harness 能区分“等太久”和“网络断了”）。 */
export const STREAM_IDLE_TIMEOUT_CODE = 'LLM_STREAM_IDLE_TIMEOUT'

/** 网关自己的错误体里会出现这些 type，语义上等价于“没有可用额度”。 */
const QUOTA_LIKE_TYPES = new Set(['no_available_account', 'quota_error', 'quota_exceeded', 'captcha_error'])

// ── 请求序列化 ────────────────────────────────────────────────────────────────

/** 把文本块拍平成一个字符串。 */
function flattenText(blocks) {
  return blocks.filter((block) => block.type === 'text').map((block) => block.text).join('')
}

/** 解析工具调用参数（模型可能给出半截 JSON）。 */
function parseToolInput(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return {}
  try {
    return JSON.parse(raw)
  } catch {
    return {}
  }
}

/** Harness 的 reasoning 块 → Anthropic thinking 块（缺 signature 时丢弃）。 */
function thinkingBlock(block, signature) {
  if (signature === undefined || signature === null) return null
  return { type: 'thinking', thinking: block.text, signature }
}

/** Harness assistant 消息 → Anthropic assistant content。 */
function assistantContent(message) {
  const blocks = message.content ?? []
  if (blocks.length === 0) return ''
  if (!blocks.some((block) => block.type !== 'text')) return flattenText(blocks)
  const replay = message.source?.replayState
  const content = []
  for (const [index, block] of blocks.entries()) {
    if (block.type === 'text') {
      content.push({ type: 'text', text: block.text })
    } else if (block.type === 'reasoning') {
      const thinking = thinkingBlock(block, replay?.blocks?.[index]?.signature)
      if (thinking !== null) content.push(thinking)
    } else if (block.type === 'tool-call') {
      content.push({ type: 'tool_use', id: block.id, name: block.name, input: parseToolInput(block.arguments) })
    }
  }
  return content.length === 0 ? flattenText(blocks) : content
}

/** Harness 图片块 → Anthropic image 块（需要附件服务提供字节）。 */
async function imagePart(block, attachments, signal) {
  if (block.offloaded === true) return { type: 'text', text: offloadedImageText(block.attachment) }
  if (attachments === undefined) {
    throw new LlmError('zcode2api: 发送图片需要附件服务（attachments）', 'UNSUPPORTED_CONTENT')
  }
  try {
    const stored = await attachments.readImage(block.attachment, signal)
    return {
      type: 'image',
      source: { type: 'base64', media_type: stored.ref.mediaType, data: Buffer.from(stored.data).toString('base64') },
    }
  } catch (error) {
    if (error instanceof LlmError) throw error
    throw new LlmError(error instanceof Error ? error.message : '读取图片附件失败', 'ATTACHMENT', { cause: error })
  }
}

/** Harness 内容块数组（文本 + 图片）→ Anthropic content parts。 */
async function contentParts(blocks, attachments, signal) {
  const parts = []
  for (const block of blocks) {
    if (block.type === 'text') {
      if (block.text.length > 0) parts.push({ type: 'text', text: block.text })
    } else if (block.type === 'image') {
      parts.push(await imagePart(block, attachments, signal))
    }
  }
  return parts
}

/** Harness tool-result 块 → Anthropic tool_result 块。 */
async function toolResultPart(result, attachments, signal) {
  const hasImage = result.content.some((block) => block.type === 'image')
  let content
  if (!hasImage) {
    content = flattenText(result.content) || '(no output)'
  } else {
    const parts = await contentParts(result.content, attachments, signal)
    content = parts.length > 0 ? parts : [{ type: 'text', text: '(no output)' }]
  }
  return {
    type: 'tool_result',
    tool_use_id: result.toolCallId,
    ...(result.isError ? { is_error: true } : {}),
    content,
  }
}

/** Harness user 消息 → 扁平的 Anthropic content parts。 */
async function userParts(message, attachments, signal) {
  const parts = []
  for (const block of message.content) {
    if (block.type === 'text') {
      if (block.text.length > 0) parts.push({ type: 'text', text: block.text })
    } else if (block.type === 'image') {
      parts.push(await imagePart(block, attachments, signal))
    } else if (block.type === 'tool-result') {
      parts.push(await toolResultPart(block, attachments, signal))
    }
  }
  return parts
}

/** parts → Anthropic user content：纯文本时用字符串，否则合并相邻文本块。 */
function userContentFromParts(parts) {
  if (parts.every((part) => part.type === 'text')) return parts.map((part) => part.text).join('')
  const merged = []
  for (const part of parts) {
    if (part.type === 'text') {
      const last = merged[merged.length - 1]
      if (last !== undefined && last.type === 'text') last.text += part.text
      else merged.push({ type: 'text', text: part.text })
    } else {
      merged.push(part)
    }
  }
  return merged
}

/** 把新的 parts 并进已有的 Anthropic user content。 */
function mergeUserContent(existing, newParts) {
  const existingParts = typeof existing === 'string'
    ? (existing === '' ? [] : [{ type: 'text', text: existing }])
    : [...existing]
  return userContentFromParts([...existingParts, ...newParts])
}

/** system：options.system + system 角色消息合并。 */
function collectSystem(options) {
  const parts = []
  if (options.system !== undefined && options.system.length > 0) parts.push(options.system)
  for (const message of options.messages) {
    if (message.role === 'system') parts.push(flattenText(message.content))
  }
  return parts.length === 0 ? undefined : parts.join('\n\n')
}

/** Harness 消息列表 → Anthropic wire 消息（合并连续同角色）。 */
async function serializeMessages(messages, attachments, signal) {
  const wire = []
  for (const message of messages) {
    if (message.role === 'system') continue
    if (message.role === 'assistant') {
      const content = assistantContent(message)
      if (content === '' || (Array.isArray(content) && content.length === 0)) continue
      wire.push({ role: 'assistant', content })
      continue
    }
    const parts = await userParts(message, attachments, signal)
    if (parts.length === 0) continue
    const previous = wire[wire.length - 1]
    if (previous !== undefined && previous.role === 'user') previous.content = mergeUserContent(previous.content, parts)
    else wire.push({ role: 'user', content: userContentFromParts(parts) })
  }
  return wire
}

/** 完整的 Anthropic Messages 请求体（不含 stream 字段，由调用方补）。 */
export async function serializeRequest(options, connection, attachments, signal) {
  const messages = await serializeMessages(options.messages, attachments, signal)
  const system = collectSystem(options)
  const tools = options.tools?.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters,
  }))
  const thinkingEnabled = connection.thinking === 'enabled'
  const configured = connection.models.find((entry) => entry.id === options.model)
  const ceiling = (configured?.maxTokens ?? connection.maxTokens) + (thinkingEnabled ? connection.thinkingBudgetTokens : 0)
  const requested = options.maxTokens ?? (configured?.maxTokens ?? connection.maxTokens)
  const maxTokens = thinkingEnabled ? Math.max(requested, connection.thinkingBudgetTokens + 1) : requested

  return {
    model: options.model,
    max_tokens: Math.min(maxTokens, ceiling),
    messages,
    ...(system !== undefined ? { system } : {}),
    ...(tools !== undefined && tools.length > 0 ? { tools } : {}),
    ...(!thinkingEnabled && options.temperature !== undefined ? { temperature: options.temperature } : {}),
    ...(options.stop !== undefined && options.stop.length > 0 ? { stop_sequences: options.stop } : {}),
    ...(thinkingEnabled ? { thinking: { type: 'enabled', budget_tokens: connection.thinkingBudgetTokens } } : {}),
  }
}

// ── 响应翻译 ──────────────────────────────────────────────────────────────────

function mapStopReason(reason) {
  switch (reason) {
    case 'end_turn':
    case 'stop_sequence':
    case 'pause_turn':
      return { kind: 'stop' }
    case 'tool_use':
      return { kind: 'tool-calls' }
    case 'max_tokens':
      return { kind: 'max-tokens' }
    case 'refusal':
      return { kind: 'error', failure: { message: 'model refused the request', code: 'REFUSAL' } }
    default:
      return { kind: 'stop' }
  }
}

/** 关闭一个已打开的块，产出 Harness 的结束块。 */
function closeBlock(block) {
  switch (block.kind) {
    case 'text':
      return { type: 'text', text: block.text }
    case 'reasoning':
      return { type: 'reasoning', text: block.text }
    case 'tool-call':
      return { type: 'tool-call', id: ToolCallId(block.toolId ?? ''), name: block.toolName ?? '', arguments: block.toolArgs }
    default:
      return undefined
  }
}

/**
 * Anthropic SSE 事件 → Harness StreamChunk 的有状态翻译器。
 * 逐事件 push()，流结束时 finalize()。
 */
export function createTranslator() {
  let nextIndex = 0
  const order = []
  const byWireIndex = new Map()
  let inputTokens = 0
  let outputTokens = 0
  let cacheReadTokens
  let cacheWriteTokens
  let stopReason
  let messageId
  let model
  let finalized = false

  function open(kind, wireIndex) {
    const block = { index: nextIndex++, kind, text: '', signature: undefined, toolId: undefined, toolName: undefined, toolArgs: '' }
    order.push(block)
    byWireIndex.set(wireIndex, block)
    return block
  }

  function finalize() {
    if (finalized) return []
    finalized = true
    const chunks = []
    chunks.push({
      type: 'usage',
      usage: {
        inputTokens,
        outputTokens,
        ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
        ...(cacheWriteTokens !== undefined ? { cacheWriteTokens } : {}),
      },
    })
    const reason = mapStopReason(stopReason ?? 'end_turn')
    if (reason.kind === 'stop' && order.length === 0) {
      chunks.push({
        type: 'finish',
        reason: {
          kind: 'error',
          failure: { message: '上游返回了空响应（没有任何内容块）', code: EMPTY_RESPONSE_CODE },
        },
      })
      return chunks
    }
    const blocks = order.map((block) => (block.kind === 'reasoning' ? { signature: block.signature ?? null } : null))
    const replayState = { response: { messageId, model, stopReason: stopReason ?? null }, blocks }
    chunks.push({
      type: 'finish',
      reason,
      ...(reason.kind !== 'error' && reason.kind !== 'aborted' ? { replayState } : {}),
    })
    return chunks
  }

  function push(event) {
    const chunks = []
    switch (event.type) {
      case 'message_start': {
        const usage = event.message?.usage
        if (usage !== undefined && usage !== null) {
          inputTokens = usage.input_tokens ?? 0
          outputTokens = usage.output_tokens ?? 0
          cacheReadTokens = usage.cache_read_input_tokens ?? undefined
          cacheWriteTokens = usage.cache_creation_input_tokens ?? undefined
        }
        messageId = event.message?.id
        model = event.message?.model
        break
      }
      case 'content_block_start': {
        const contentBlock = event.content_block ?? {}
        const wireIndex = event.index
        if (contentBlock.type === 'text') {
          const block = open('text', wireIndex)
          chunks.push({ type: 'block-start', index: block.index, blockType: 'text' })
        } else if (contentBlock.type === 'thinking') {
          const block = open('reasoning', wireIndex)
          block.signature = contentBlock.signature
          chunks.push({ type: 'block-start', index: block.index, blockType: 'reasoning' })
        } else if (contentBlock.type === 'redacted_thinking') {
          const block = open('reasoning', wireIndex)
          block.text = contentBlock.data ?? ''
          chunks.push({ type: 'block-start', index: block.index, blockType: 'reasoning' })
          chunks.push({ type: 'reasoning-delta', index: block.index, text: block.text })
        } else if (contentBlock.type === 'tool_use') {
          const block = open('tool-call', wireIndex)
          block.toolId = contentBlock.id
          block.toolName = contentBlock.name
          chunks.push({ type: 'block-start', index: block.index, blockType: 'tool-call' })
          chunks.push({
            type: 'tool-call-delta',
            index: block.index,
            id: ToolCallId(contentBlock.id ?? ''),
            name: contentBlock.name,
            argumentsDelta: '',
          })
        }
        // 未识别的块类型（server_tool_use / web_search_tool_result…）直接跳过
        break
      }
      case 'content_block_delta': {
        const block = byWireIndex.get(event.index)
        if (block === undefined) break
        const delta = event.delta ?? {}
        if (delta.type === 'text_delta' && block.kind === 'text') {
          block.text += delta.text
          chunks.push({ type: 'text-delta', index: block.index, text: delta.text })
        } else if (delta.type === 'thinking_delta' && block.kind === 'reasoning') {
          block.text += delta.thinking
          chunks.push({ type: 'reasoning-delta', index: block.index, text: delta.thinking })
        } else if (delta.type === 'signature_delta' && block.kind === 'reasoning') {
          block.signature = (block.signature ?? '') + delta.signature
        } else if (delta.type === 'input_json_delta' && block.kind === 'tool-call') {
          block.toolArgs += delta.partial_json
          chunks.push({
            type: 'tool-call-delta',
            index: block.index,
            id: ToolCallId(block.toolId ?? ''),
            name: block.toolName,
            argumentsDelta: delta.partial_json,
          })
        }
        break
      }
      case 'content_block_stop': {
        const block = byWireIndex.get(event.index)
        if (block === undefined) break
        chunks.push({ type: 'block-end', index: block.index, block: closeBlock(block) })
        break
      }
      case 'message_delta': {
        const usage = event.usage
        if (usage !== undefined && usage !== null) outputTokens = usage.output_tokens ?? outputTokens
        stopReason = event.delta?.stop_reason ?? stopReason
        break
      }
      default:
        // message_stop / ping / 未知事件：这里不产生块，收尾由 finalize() 统一处理
        break
    }
    return chunks
  }

  return { push, finalize }
}

// ── SSE 解析 ──────────────────────────────────────────────────────────────────

/** 解析一条 SSE data 载荷；心跳和无 type 的载荷返回 undefined。 */
function parseEventPayload(payload) {
  const text = payload.trim()
  if (text === '' || text === '[DONE]') return undefined
  let event
  try {
    event = JSON.parse(text)
  } catch {
    return undefined
  }
  if (event === null || typeof event !== 'object') return undefined
  if (event.type === 'error') {
    const detail = event.error ?? {}
    throw new LlmError(
      typeof detail.message === 'string' && detail.message !== '' ? detail.message : '上游返回了错误事件',
      errorCodeOf(undefined, `${detail.type ?? ''} ${detail.message ?? ''}`),
    )
  }
  return typeof event.type === 'string' ? event : undefined
}

/**
 * Web ReadableStream<Uint8Array> → Anthropic 事件对象。
 *
 * 只认 `data:` 行：Anthropic 的每个 data 载荷都自带 `type` 字段，`event:` 行是冗余的。
 */
export async function* sseEvents(body) {
  if (body === null || body === undefined) return
  const decoder = new TextDecoder()
  let buffer = ''
  let dataLines = []
  const flush = () => {
    if (dataLines.length === 0) return undefined
    const payload = dataLines.join('\n')
    dataLines = []
    return parseEventPayload(payload)
  }
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true })
    let newline = buffer.indexOf('\n')
    while (newline !== -1) {
      let line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      if (line.endsWith('\r')) line = line.slice(0, -1)
      newline = buffer.indexOf('\n')
      if (line === '') {
        const event = flush()
        if (event !== undefined) yield event
      } else if (line.startsWith(':')) {
        continue // SSE 注释（保活心跳）
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).replace(/^ /, ''))
      }
      // event: / id: / retry: 行忽略
    }
  }
  buffer += decoder.decode()
  if (buffer.trim() !== '') {
    const tail = buffer.endsWith('\r') ? buffer.slice(0, -1) : buffer
    if (tail.startsWith('data:')) dataLines.push(tail.slice(5).replace(/^ /, ''))
  }
  const event = flush()
  if (event !== undefined) yield event
}

// ── 错误映射 ──────────────────────────────────────────────────────────────────

function errorCodeOf(status, detail) {
  if (status === 401 || status === 403) return 'AUTH'
  if (status === 413) return 'INVALID_REQUEST'
  if (isQuotaExceededError(detail)) return QUOTA_EXCEEDED_CODE
  if (status === 402) return QUOTA_EXCEEDED_CODE
  if (status === 429) return 'RATE_LIMIT'
  if (status === 503) return QUOTA_EXCEEDED_CODE
  if (status === 400) {
    if (isContextWindowExceededError(detail)) return CONTEXT_WINDOW_EXCEEDED_CODE
    return 'INVALID_REQUEST'
  }
  if (status !== undefined && status >= 500) return 'SERVER'
  if (status === undefined) return 'PROVIDER'
  return `HTTP_${status}`
}

/** 网关 / 上游的错误响应 → LlmError（带可读的中文提示）。 */
function upstreamError(status, text) {
  let body
  try {
    body = JSON.parse(text)
  } catch {
    body = undefined
  }
  const error = body?.error ?? body
  const message = typeof error?.message === 'string' ? error.message : text.slice(0, 500)
  const type = typeof error?.type === 'string' ? error.type : ''
  if (QUOTA_LIKE_TYPES.has(type)) {
    return new LlmError(
      `zcode2api: ${message || type}（打开 http://127.0.0.1:<port>/admin 检查账号池：新增账号 / 查看额度）`,
      QUOTA_EXCEEDED_CODE,
      { status },
    )
  }
  const detail = [type, message].filter(Boolean).join(' ')
  return new LlmError(message || `zcode2api 网关返回 HTTP ${status}`, errorCodeOf(status, detail), { status })
}

// ── 适配器 ────────────────────────────────────────────────────────────────────

/** 空闲看门狗：超过 ms 没有新数据就 abort 掉本次请求。 */
function idleWatchdog(onIdle, ms) {
  let tripped = false
  let handle
  const arm = () => {
    handle = setTimeout(() => {
      tripped = true
      onIdle()
    }, ms)
    handle.unref?.()
  }
  arm()
  return {
    pulse() {
      clearTimeout(handle)
      arm()
    },
    tripped: () => tripped,
    dispose() {
      clearTimeout(handle)
    },
  }
}

function modelInfo(provider, model) {
  return {
    provider,
    id: model.id,
    name: model.name ?? model.id,
    ...(model.description === undefined ? {} : { description: model.description }),
    inputModalities: model.inputModalities ?? ['text'],
  }
}

export class Zcode2ApiAdapter extends LlmAdapter {
  constructor(config) {
    super()
    this.config = config
  }

  providerInfo(provider) {
    return { id: provider, name: 'ZCode (zcode2api)' }
  }

  providerRetryPolicy() {
    return this.config.options().retryPolicy
  }

  listModels(provider) {
    return Promise.resolve(this.config.options().models.map((model) => modelInfo(provider, model)))
  }

  resolveModel(provider, model) {
    const connection = this.config.options()
    const configured = connection.models.find((entry) => entry.id === model)
    if (configured === undefined) {
      return Promise.resolve({
        provider,
        id: model,
        name: model,
        inputModalities: ['text'],
        context: { contextWindow: connection.defaultContextWindow },
        defaultMaxTokens: connection.maxTokens,
      })
    }
    return Promise.resolve({
      ...modelInfo(provider, configured),
      context: { contextWindow: configured.contextWindow ?? connection.defaultContextWindow },
      defaultMaxTokens: configured.maxTokens ?? connection.maxTokens,
    })
  }

  async *stream(options) {
    const connection = this.config.options()
    const hasImages = options.messages.some((message) => contentHasImage(message.content))
    let attachments
    let body
    const abortByConsumer = new AbortController()
    const signal = options.signal === undefined
      ? abortByConsumer.signal
      : AbortSignal.any([options.signal, abortByConsumer.signal])
    const watchdog = idleWatchdog(() => abortByConsumer.abort('zcode2api: 流式响应空闲超时'), connection.streamIdleTimeoutMs)

    try {
      if (hasImages) {
        const configured = connection.models.find((entry) => entry.id === options.model)
        if (configured !== undefined && !(configured.inputModalities ?? ['text']).includes('image')) {
          throw new LlmError(`zcode2api 模型 "${options.model}" 不接受图片输入`, 'UNSUPPORTED_CONTENT')
        }
        attachments = this.config.resolveAttachments?.()
        if (attachments === undefined) {
          throw new LlmError('zcode2api: 发送图片需要持久附件服务（attachments）', 'UNSUPPORTED_CONTENT')
        }
      }
      const apiKey = await this.config.resolveApiKey(connection)
      body = await serializeRequest(options, connection, attachments, signal)
      const endpoint = `${connection.baseURL.replace(/\/+$/, '')}/v1/messages`
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'text/event-stream',
          'anthropic-version': connection.anthropicVersion,
          ...(apiKey === undefined || apiKey === '' ? {} : { 'x-api-key': apiKey, authorization: `Bearer ${apiKey}` }),
          ...(connection.userAgent === undefined ? {} : { 'user-agent': connection.userAgent }),
        },
        body: JSON.stringify({ ...body, stream: true }),
        signal,
      })
      if (!response.ok) {
        const text = await response.text().catch(() => '')
        throw upstreamError(response.status, text)
      }
      if (response.body === null) throw new LlmError('zcode2api 网关没有返回响应体', 'TRANSPORT')

      const translator = createTranslator()
      for await (const event of sseEvents(response.body)) {
        watchdog.pulse()
        for (const chunk of translator.push(event)) yield chunk
      }
      for (const chunk of translator.finalize()) yield chunk
    } catch (error) {
      if (watchdog.tripped()) {
        throw new LlmError(
          `zcode2api 流式响应超过 ${connection.streamIdleTimeoutMs}ms 没有新数据`,
          STREAM_IDLE_TIMEOUT_CODE,
          { cause: error },
        )
      }
      if (options.signal?.aborted === true) throw new LlmError('zcode2api 请求被调用方中止', 'ABORTED', { cause: error })
      if (error instanceof LlmError) throw error
      throw new LlmError(`zcode2api 网关请求失败：${connection.baseURL}`, 'TRANSPORT', { cause: error })
    } finally {
      abortByConsumer.abort('zcode2api stream consumer stopped')
      watchdog.dispose()
    }
  }
}
