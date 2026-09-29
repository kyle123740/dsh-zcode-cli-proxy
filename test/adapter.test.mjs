/**
 * 适配器离线测试：用本地 mock 的 Anthropic SSE 服务验证
 * 「Harness options → Anthropic wire 请求」和「Anthropic SSE → Harness StreamChunk」
 * 两个方向的翻译，不碰真实上游、不需要 ZCode 账号。
 *
 *   node test/adapter.test.mjs
 *
 * 退出码非 0 表示有断言失败。
 */

import http from 'node:http'
import assert from 'node:assert/strict'

import { LlmError, QUOTA_EXCEEDED_CODE } from '@deepseek-ai/dsh-llm'
import { Zcode2ApiAdapter, sseEvents } from '../lib/anthropic-adapter.js'

const MODEL = 'GLM-5.2'

function baseOptions(overrides = {}) {
  return {
    baseURL: 'http://127.0.0.1:1', // 每个用例里替换
    anthropicVersion: '2023-06-01',
    models: [{
      id: MODEL,
      name: MODEL,
      contextWindow: 200000,
      maxTokens: 32768,
      inputModalities: ['text'],
    }],
    maxTokens: 32768,
    defaultContextWindow: 200000,
    thinking: 'disabled',
    thinkingBudgetTokens: 8192,
    streamIdleTimeoutMs: 30000,
    userAgent: 'test-agent/1.0',
    retryPolicy: { maxRetries: 0 },
    ...overrides,
  }
}

function adapterFor(options) {
  return new Zcode2ApiAdapter({
    options: () => options,
    resolveApiKey: async () => undefined,
    resolveAttachments: () => undefined,
  })
}

/** 起一个 mock 网关，返回 { baseURL, requests, close }。 */
async function mockGateway(handler) {
  const requests = []
  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      const record = { method: req.method, url: req.url, headers: req.headers, body: raw === '' ? undefined : JSON.parse(raw) }
      requests.push(record)
      handler(record, res)
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    baseURL: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

/** 把一组 SSE 事件写成响应体。 */
function sse(events) {
  return events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('')
}

async function collect(adapter, options) {
  const chunks = []
  for await (const chunk of adapter.stream(options)) chunks.push(chunk)
  return chunks
}

const userMessage = { role: 'user', content: [{ type: 'text', text: '你好' }] }

const cases = []
function test(title, fn) {
  cases.push({ title, fn })
}

// ── 1. 文本流 ────────────────────────────────────────────────────────────────
test('文本流：请求体正确、增量合并、finish=stop', async () => {
  const gateway = await mockGateway((_record, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(sse([
      { type: 'message_start', message: { id: 'msg_1', model: MODEL, usage: { input_tokens: 11, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '你' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '好' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
      { type: 'message_stop' },
    ]))
  })
  try {
    const adapter = adapterFor(baseOptions({ baseURL: gateway.baseURL }))
    const chunks = await collect(adapter, {
      provider: 'zcode2api',
      model: MODEL,
      system: '你是帮手',
      messages: [userMessage],
      tools: [{ name: 'read_file', description: '读文件', parameters: { type: 'object', properties: { path: { type: 'string' } } } }],
      temperature: 0.3,
    })

    assert.equal(chunks.filter((chunk) => chunk.type === 'text-delta').map((chunk) => chunk.text).join(''), '你好')
    const usage = chunks.find((chunk) => chunk.type === 'usage')
    assert.deepEqual({ input: usage.usage.inputTokens, output: usage.usage.outputTokens }, { input: 11, output: 2 })
    const finish = chunks.at(-1)
    assert.equal(finish.type, 'finish')
    assert.equal(finish.reason.kind, 'stop')
    assert.equal(finish.replayState.response.messageId, 'msg_1')

    const sent = gateway.requests[0]
    assert.equal(sent.method, 'POST')
    assert.equal(sent.url, '/v1/messages')
    assert.equal(sent.headers['x-api-key'], undefined, '未配置网关 Key 时不应发鉴权头')
    assert.equal(sent.headers['anthropic-version'], '2023-06-01')
    assert.equal(sent.body.model, MODEL)
    assert.equal(sent.body.stream, true)
    assert.equal(sent.body.system, '你是帮手')
    assert.equal(sent.body.temperature, 0.3)
    assert.deepEqual(sent.body.messages, [{ role: 'user', content: '你好' }])
    assert.deepEqual(sent.body.tools, [{
      name: 'read_file',
      description: '读文件',
      input_schema: { type: 'object', properties: { path: { type: 'string' } } },
    }])
    assert.equal(sent.body.max_tokens, 32768)
  } finally {
    await gateway.close()
  }
})

// ── 2. 工具调用流 ────────────────────────────────────────────────────────────
test('工具调用流：input_json_delta 拼装 + finish=tool-calls', async () => {
  const gateway = await mockGateway((_record, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(sse([
      { type: 'message_start', message: { id: 'msg_2', model: MODEL, usage: { input_tokens: 5, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'read_file', input: {} } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"path":' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '"a.txt"}' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 9 } },
      { type: 'message_stop' },
    ]))
  })
  try {
    const adapter = adapterFor(baseOptions({ baseURL: gateway.baseURL }))
    const chunks = await collect(adapter, { provider: 'zcode2api', model: MODEL, messages: [userMessage] })
    const end = chunks.find((chunk) => chunk.type === 'block-end')
    assert.equal(end.block.type, 'tool-call')
    assert.equal(end.block.name, 'read_file')
    assert.equal(end.block.arguments, '{"path":"a.txt"}')
    assert.equal(chunks.at(-1).reason.kind, 'tool-calls')
  } finally {
    await gateway.close()
  }
})

// ── 3. 思考块 ────────────────────────────────────────────────────────────────
test('思考块：thinking_delta + signature 回放', async () => {
  const gateway = await mockGateway((_record, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(sse([
      { type: 'message_start', message: { id: 'msg_3', model: MODEL, usage: { input_tokens: 1, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '想' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig-1' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
      { type: 'message_stop' },
    ]))
  })
  try {
    const adapter = adapterFor(baseOptions({ baseURL: gateway.baseURL }))
    const chunks = await collect(adapter, { provider: 'zcode2api', model: MODEL, messages: [userMessage] })
    assert.equal(chunks.filter((chunk) => chunk.type === 'reasoning-delta').map((chunk) => chunk.text).join(''), '想')
    assert.equal(chunks.at(-1).replayState.blocks[0].signature, 'sig-1')
  } finally {
    await gateway.close()
  }
})

// ── 4. 空响应 ────────────────────────────────────────────────────────────────
test('空响应：finish 报 EMPTY_RESPONSE', async () => {
  const gateway = await mockGateway((_record, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(sse([
      { type: 'message_start', message: { id: 'msg_4', model: MODEL, usage: { input_tokens: 1, output_tokens: 0 } } },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 0 } },
      { type: 'message_stop' },
    ]))
  })
  try {
    const adapter = adapterFor(baseOptions({ baseURL: gateway.baseURL }))
    const chunks = await collect(adapter, { provider: 'zcode2api', model: MODEL, messages: [userMessage] })
    const finish = chunks.at(-1)
    assert.equal(finish.reason.kind, 'error')
    assert.equal(finish.reason.failure.code, 'EMPTY_RESPONSE')
  } finally {
    await gateway.close()
  }
})

// ── 5. 额度用尽（网关 503 no_available_account）─────────────────────────────
test('网关 503 no_available_account → QUOTA 错误', async () => {
  const gateway = await mockGateway((_record, res) => {
    res.writeHead(503, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message: '所有账号均不可用或额度已用完', type: 'no_available_account' } }))
  })
  try {
    const adapter = adapterFor(baseOptions({ baseURL: gateway.baseURL }))
    await assert.rejects(
      () => collect(adapter, { provider: 'zcode2api', model: MODEL, messages: [userMessage] }),
      (error) => {
        assert.ok(error instanceof LlmError, `期望 LlmError，得到 ${error}`)
        assert.equal(error.code, QUOTA_EXCEEDED_CODE)
        assert.match(error.message, /账号|额度/)
        return true
      },
    )
  } finally {
    await gateway.close()
  }
})

// ── 6. 流内错误事件 ──────────────────────────────────────────────────────────
test('SSE error 事件 → LlmError', async () => {
  const gateway = await mockGateway((_record, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(sse([
      { type: 'message_start', message: { id: 'msg_6', model: MODEL, usage: { input_tokens: 1, output_tokens: 0 } } },
      { type: 'error', error: { type: 'overloaded_error', message: '上游过载' } },
    ]))
  })
  try {
    const adapter = adapterFor(baseOptions({ baseURL: gateway.baseURL }))
    await assert.rejects(
      () => collect(adapter, { provider: 'zcode2api', model: MODEL, messages: [userMessage] }),
      (error) => {
        assert.ok(error instanceof LlmError)
        assert.match(error.message, /上游过载/)
        return true
      },
    )
  } finally {
    await gateway.close()
  }
})

// ── 7. SSE 解析边界：分片、CRLF、注释、多行 data ─────────────────────────────
test('SSE 解析：跨 chunk 分片 / CRLF / 心跳注释', async () => {
  const payload = [
    'event: message_start\r\n',
    `data: {"type":"message_start","message":{"id":"m","usage":{"input_tokens":3,"output_tokens":0}}}\r\n`,
    '\r\n',
    ': keep-alive\r\n',
    '\r\n',
    'event: content_block_start\r\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\r\n\r\n',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta",\r\n',
    'data: "text":"拆分"}}\r\n\r\n',
    'data: {"type":"content_block_stop","index":0}\r\n\r\n',
  ].join('')
  const bytes = Buffer.from(payload, 'utf8')
  const stream = new ReadableStream({
    start(controller) {
      // 故意按 7 字节切开，制造随机分片
      for (let offset = 0; offset < bytes.length; offset += 7) controller.enqueue(bytes.subarray(offset, offset + 7))
      controller.close()
    },
  })
  const events = []
  for await (const event of sseEvents(stream)) events.push(event)
  assert.deepEqual(events.map((event) => event.type), ['message_start', 'content_block_start', 'content_block_delta', 'content_block_stop'])
  assert.equal(events[2].delta.text, '拆分')
})

// ── 8. 模型目录 ──────────────────────────────────────────────────────────────
test('listModels / resolveModel', async () => {
  const adapter = adapterFor(baseOptions({ baseURL: 'http://127.0.0.1:1' }))
  const models = await adapter.listModels('zcode2api')
  assert.deepEqual(models, [{ provider: 'zcode2api', id: MODEL, name: MODEL, inputModalities: ['text'] }])
  const resolved = await adapter.resolveModel('zcode2api', MODEL)
  assert.equal(resolved.context.contextWindow, 200000)
  assert.equal(resolved.defaultMaxTokens, 32768)
})

// ── 运行 ─────────────────────────────────────────────────────────────────────
let failures = 0
for (const { title, fn } of cases) {
  try {
    await fn()
    console.log(`  ✔ ${title}`)
  } catch (error) {
    failures += 1
    console.error(`  ✘ ${title}\n    ${error?.stack ?? error}`)
  }
}
console.log(`\n${cases.length - failures}/${cases.length} 通过`)
process.exit(failures === 0 ? 0 : 1)
