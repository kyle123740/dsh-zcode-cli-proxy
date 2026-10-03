/**
 * 回合锁恢复的端到端验证（跑的是 lib/app-server.js 真身 + test/fake-app-server.cjs 假 CLI）。
 *
 *   node test/turn-lock.mjs
 *
 * 覆盖六个场景：
 *   A 撞锁恢复：session/send 被拒 "A prompt is already running for this session"
 *              → 补发 session/stop → 重试成功（不再把错误抛给 DSH）
 *   B 回合串行化：同一 DSH 会话并发两轮 → 第二轮排队，不会撞出第二条 send
 *   C 中止补刀：回合没正常结束（被调用方中止）→ finally 一定发出 session/stop
 *   D 进程重启：app-server 退出 → 缓存会话全部作废，下一轮重新 create
 *   E 会话失效：send 被回 "session … not found" → 重建会话并重放整段对话
 *   F 退出快败：回合在途时进程退出 → 在途流立刻失败收尾，不干等回合超时
 *   G 会话分叉：DSH 侧编辑历史 → 前缀指纹对不上 → 重建会话重放新分支
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { ZcodeAppServerAdapter } from '../lib/app-server.js'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const FAKE_PATH = path.join(HERE, 'fake-app-server.cjs')
const NODE = process.execPath
const VERBOSE = process.env.VERBOSE === '1'
const TEST_LOGGER = {
  info: (message) => { if (VERBOSE) console.log('  [info]', message) },
  warn: (message) => { if (VERBOSE) console.log('  [warn]', message) },
  debug: (message) => { if (VERBOSE) console.log('  [debug]', message) },
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const results = []
function check(name, ok, detail) {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : `  — ${detail}`}`)
}

/** 造一个指向假 CLI 的适配器（不注入 Start Plan、不读凭证，纯协议层）。 */
function makeAdapter(mode) {
  process.env.FAKE_MODE = mode
  const runtimeDir = path.join(HERE, '.runtime')
  fs.mkdirSync(runtimeDir, { recursive: true })
  const logPath = path.join(runtimeDir, `fake-${mode}.log`)
  fs.rmSync(logPath, { force: true })
  process.env.FAKE_LOG = logPath
  const options = () => ({
    enabled: true,
    zcodeCliPath: FAKE_PATH,
    zcodeCliNode: NODE,
    zcodeCliTimeoutMs: 20000,
    appServerTimeoutMs: 20000,
    cliModels: [{ id: 'glm-test', name: 'glm-test', contextWindow: 1000, maxTokens: 100 }],
    cliCwd: '',
    injectStartPlanAccount: false,
    zcodeDataBaseDir: '',
    // 假 CLI 靠 FAKE_MODE / FAKE_LOG 环境变量驱动：顺带验证 childEnvAllow 白名单放行
    childEnvAllow: ['FAKE_MODE', 'FAKE_LOG'],
    maxTokens: 100,
    defaultContextWindow: 1000,
    retryPolicy: {},
  })
  const adapter = new ZcodeAppServerAdapter({ options, resolveAttachments: () => undefined, logger: TEST_LOGGER })
  // 子进程收到第一条消息才会建日志文件，所以「还没有文件」= 还没有任何收发
  const readLog = () => (fs.existsSync(logPath)
    ? fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
    : [])
  return { adapter, readLog, logPath }
}

/** 跑一轮，返回 { text, error }（不抛）。messages 可覆盖默认的单条用户消息。 */
async function runTurn(adapter, sessionId, text, signal, messages) {
  const parts = []
  try {
    for await (const item of adapter.stream({
      sessionId,
      model: 'glm-test',
      system: '',
      signal,
      messages: messages ?? [{ role: 'user', content: [{ type: 'text', text }] }],
    })) {
      if (item.type === 'text-delta') parts.push(item.text ?? '')
      if (item.type === 'finish' && item.reason?.kind === 'error') return { error: item.reason.failure?.message, text: parts.join('') }
    }
    return { text: parts.join('') }
  } catch (error) {
    return { error: String(error?.message ?? error), text: parts.join('') }
  }
}

const sendsOf = (entries) => entries.filter((entry) => entry.method === 'session/send')
const stopsOf = (entries) => entries.filter((entry) => entry.method === 'session/stop')
const indexesOf = (entries, method) => entries.map((entry, index) => (entry.method === method ? index : -1)).filter((index) => index !== -1)

/** 轮询等一个条件成立（子进程写日志是异步的，刚发完 stop 立刻读会读不到）。 */
async function waitFor(predicate, ms = 5000) {
  const until = Date.now() + ms
  let value = predicate()
  while (!value && Date.now() < until) {
    await sleep(100)
    value = predicate()
  }
  return value
}

/** 等第 n 条 send 出现在日志里（假 CLI 的 gate 模式要手动放行回合）。 */
async function waitForSend(readLog, n) {
  for (let i = 0; i < 300; i += 1) {
    const sends = sendsOf(readLog())
    if (sends.length >= n) return sends[n - 1]
    await sleep(100)
  }
  throw new Error(`等不到第 ${n} 条 session/send（子进程没起来？spawn 被沙箱拦成 EPERM？）`)
}

// ── A 撞锁恢复 ────────────────────────────────────────────────────────────────
{
  const { adapter, readLog, logPath } = makeAdapter('stuck-once')
  const first = await runTurn(adapter, 'sess-a', '第一条')
  const entries = readLog()
  const stopIndex = indexesOf(entries, 'session/stop')[0]
  const secondSendIndex = indexesOf(entries, 'session/send')[1]
  check('A 首轮撞锁后自愈（没把 already running 抛给 DSH）',
    first.error === undefined && first.text === 'hello-2', `text=${JSON.stringify(first.text)} error=${first.error ?? 'none'}`)
  check('A 恢复时补发了 session/stop', stopsOf(entries).length === 1, `stops=${stopsOf(entries).length}`)
  check('A 先 stop 再重试 send', stopIndex !== undefined && secondSendIndex !== undefined && stopIndex < secondSendIndex,
    `stopIndex=${stopIndex} secondSendIndex=${secondSendIndex}`)
  check('A 复用同一个 app-server 会话（没有白重建）',
    new Set(sendsOf(entries).map((entry) => entry.params.sessionId)).size === 1)
  adapter.dispose()
  fs.rmSync(logPath, { force: true })
}

// ── B 回合串行化 ──────────────────────────────────────────────────────────────
{
  const { adapter, readLog, logPath } = makeAdapter('gate')
  const turnOne = runTurn(adapter, 'sess-b', '第一轮')
  const firstSend = await waitForSend(readLog, 1)
  const turnTwo = runTurn(adapter, 'sess-b', '第二轮')
  await sleep(1500)
  check('B 第二轮排队，没有并发 send（并发就是 already running）',
    sendsOf(readLog()).length === 1, `sends=${sendsOf(readLog()).length}`)

  adapter.client.notify('test/finish', { sessionId: firstSend.params.sessionId })
  const one = await turnOne
  const secondSend = await waitForSend(readLog, 2)
  adapter.client.notify('test/finish', { sessionId: secondSend.params.sessionId })
  const two = await turnTwo
  check('B 第一轮正常收尾', one.error === undefined && one.text === 'hello-1', JSON.stringify(one))
  check('B 放行后第二轮跑通', two.error === undefined && two.text === 'hello-2', JSON.stringify(two))
  await sleep(50)
  check('B 闸门队列用完即清', adapter.turnLocks.size === 0, `turnLocks=${adapter.turnLocks.size}`)
  adapter.dispose()
  fs.rmSync(logPath, { force: true })
}

// ── C 中止补刀 ────────────────────────────────────────────────────────────────
{
  const { adapter, readLog, logPath } = makeAdapter('hold')
  const controller = new AbortController()
  const running = runTurn(adapter, 'sess-c', '会被中止的一轮', controller.signal)
  await waitForSend(readLog, 1)
  await sleep(300)
  controller.abort()
  const aborted = await running
  const stops = await waitFor(() => stopsOf(readLog()).length)
  check('C 中止后按 ABORTED 报出', /中止/.test(aborted.error ?? ''), aborted.error ?? 'no error')
  check('C 中止时补发 session/stop（否则锁永远不释放）', stops >= 1, `stops=${stops ?? 0}`)
  adapter.dispose()
  fs.rmSync(logPath, { force: true })
}

// ── D 进程重启后缓存会话作废 ──────────────────────────────────────────────────
{
  const { adapter, readLog, logPath } = makeAdapter('gate')
  const turnOne = runTurn(adapter, 'sess-d', '第一轮')
  const sendOne = await waitForSend(readLog, 1)
  adapter.client.notify('test/finish', { sessionId: sendOne.params.sessionId })
  await turnOne
  adapter.client.child.kill()
  for (let i = 0; i < 100 && adapter.sessions.size > 0; i += 1) await sleep(50)
  check('D app-server 退出即清空缓存会话', adapter.sessions.size === 0, `sessions=${adapter.sessions.size}`)
  const turnTwo = runTurn(adapter, 'sess-d', '第二轮')
  const sendTwo = await waitForSend(readLog, 2)
  adapter.client.notify('test/finish', { sessionId: sendTwo.params.sessionId })
  const two = await turnTwo
  const creates = readLog().filter((entry) => entry.method === 'session/create')
  check('D 重启后重新 create 会话并跑通', two.error === undefined && creates.length === 2,
    `creates=${creates.length} ${JSON.stringify(two)}`)
  check('D 新会话按首轮语义重放（拍平整段对话，而不是裸发最后一条）',
    typeof sendTwo.params.content === 'string' && sendTwo.params.content.includes('# 用户') && sendTwo.params.content.includes('第二轮'),
    JSON.stringify(sendTwo.params.content?.slice(0, 20)))
  adapter.dispose()
  fs.rmSync(logPath, { force: true })
}

// ── E 会话被回收 → 重建并重放 ─────────────────────────────────────────────────
{
  const { adapter, readLog, logPath } = makeAdapter('stale-once')
  const first = await runTurn(adapter, 'sess-e', '第一条')
  const entries = readLog()
  const creates = entries.filter((entry) => entry.method === 'session/create')
  const sends = sendsOf(entries)
  check('E 会话失效后自愈（重建会话跑通，没抛给 DSH）',
    first.error === undefined && first.text === 'hello-2', `text=${JSON.stringify(first.text)} error=${first.error ?? 'none'}`)
  check('E 换了新会话（2 次 create，send 落在新 sessionId 上）',
    creates.length === 2 && sends.length === 2 && sends[0].params.sessionId !== sends[1].params.sessionId,
    `creates=${creates.length} sends=${sends.length}`)
  check('E 新会话重放整段对话（拍平，而不是裸发最后一条）',
    typeof sends[1]?.params?.content === 'string' && sends[1].params.content.includes('# 用户') && sends[1].params.content.includes('第一条'))
  check('E 会话失效不该发 session/stop', stopsOf(entries).length === 0, `stops=${stopsOf(entries).length}`)
  adapter.dispose()
  fs.rmSync(logPath, { force: true })
}

// ── F 进程退出 → 在途流立刻失败（不干等回合超时）───────────────────────────────
{
  const { adapter, readLog, logPath } = makeAdapter('hold')
  const running = runTurn(adapter, 'sess-f', '进程退出前的一轮')
  await waitForSend(readLog, 1)
  await sleep(300)
  const startedAt = Date.now()
  adapter.client.child.kill() // 回合在途时干掉 app-server
  const dead = await running
  const elapsed = Date.now() - startedAt
  check('F 回合在途时进程退出 → 流立刻失败（不等回合超时）',
    /进程已退出/.test(dead.error ?? '') && elapsed < 10000,
    `error=${dead.error ?? 'none'} elapsed=${elapsed}ms`)
  const stops = await waitFor(() => stopsOf(readLog()).length, 1000)
  check('F 退出收尾不再向已死进程发 stop', stops === 0, `stops=${stops ?? 0}`)
  adapter.dispose()
  fs.rmSync(logPath, { force: true })
}

// ── G 会话分叉（DSH 侧编辑历史）→ 重建并重放新分支 ────────────────────────────
{
  const { adapter, readLog, logPath } = makeAdapter('normal')
  await runTurn(adapter, 'sess-g', '原始第一条')
  // 模拟 DSH 侧编辑历史：第一条消息的文本被改掉，随后追加第二轮。
  // 续接前的前缀指纹（第 1 条消息）对不上上一轮 send 时的指纹 → 必须重建会话。
  const edited = [
    { role: 'user', content: [{ type: 'text', text: '改过的第一条' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'hello-1' }] },
    { role: 'user', content: [{ type: 'text', text: '第二条' }] },
  ]
  const second = await runTurn(adapter, 'sess-g', '', undefined, edited)
  const entries = readLog()
  const creates = entries.filter((entry) => entry.method === 'session/create')
  const sends = sendsOf(entries)
  check('G 历史被编辑 → 检测到分叉并重建会话',
    second.error === undefined && creates.length === 2,
    `creates=${creates.length} error=${second.error ?? 'none'}`)
  check('G 重建后按首轮语义重放新分支（含改过的历史）',
    typeof sends[1]?.params?.content === 'string'
      && sends[1].params.content.includes('改过的第一条') && sends[1].params.content.includes('第二条'))
  adapter.dispose()
  fs.rmSync(logPath, { force: true })
}

const failed = results.filter((result) => !result.ok)
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
process.exit(failed.length === 0 ? 0 : 1)
