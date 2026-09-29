/**
 * 网关端到端冒烟测试：真的把 zcode2api 的 Python 网关拉起来，验证
 *   1. 进程托管（启动 → 就绪 → 停止，端口释放）
 *   2. 后台管理 API（鉴权、账号增删查、设置）
 *   3. `/v1/messages` 的协议行为（没有可用账号时返回结构化错误）
 *
 * 用独立的临时数据目录和端口，不碰插件正式运行时的 data/。
 *
 *   node test/gateway.smoke.mjs
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { GatewayClient } from '../lib/gateway-client.js'
import { GATEWAY_STATE, GatewaySupervisor } from '../lib/supervisor.js'

const PLUGIN_DIR = fileURLToPath(new URL('..', import.meta.url))
const RUNTIME_HOME = path.join(PLUGIN_DIR, 'test', '.runtime')
const PORT = 3999

const logger = {
  info: (message) => console.log(`[info] ${message}`),
  warn: (message) => console.log(`[warn] ${message}`),
  error: (message) => console.log(`[error] ${message}`),
  debug: () => {},
}

function options() {
  return {
    enabled: true,
    autoStart: true,
    manageProcess: true,
    restartOnExit: false,
    maxRestarts: 0,
    host: '127.0.0.1',
    port: PORT,
    baseUrl: `http://127.0.0.1:${PORT}`,
    adminKey: 'smoke-test-key',
    gatewayKey: '',
    gatewayKeyEnv: 'ZCODE2API_GATEWAY_KEY',
    pythonPath: '',
    projectDir: path.join(PLUGIN_DIR, 'vendor', 'zcode2api'),
    pluginDir: PLUGIN_DIR,
    runtimeHome: RUNTIME_HOME,
    dataDir: path.join(RUNTIME_HOME, 'data'),
    venvPython: path.join(RUNTIME_HOME, 'venv', 'Scripts', 'python.exe'),
    logFile: path.join(RUNTIME_HOME, 'logs', 'gateway.log'),
    nodePath: 'node',
    quotaRefreshInterval: 0,
    coolingSeconds: 60,
    startTimeoutMs: 90000,
    models: [{ id: 'GLM-5.2', name: 'GLM-5.2', contextWindow: 200000, maxTokens: 32768, inputModalities: ['text'] }],
    anthropicVersion: '2023-06-01',
    maxTokens: 32768,
    defaultContextWindow: 200000,
    thinking: 'disabled',
    thinkingBudgetTokens: 8192,
    streamIdleTimeoutMs: 300000,
    retryPolicy: { maxRetries: 0 },
  }
}

// 临时 runtime 里没有 venv → 指向真实装配好的那个（用 junction 不如直接复用配置）
const realRuntime = path.join(os.homedir(), '.dsh', 'zcode2api')
const realVenvPython = path.join(realRuntime, 'venv', 'Scripts', 'python.exe')
const configured = options()
if (!fs.existsSync(realVenvPython)) {
  console.error(`跳过：找不到已装配的 Python 运行时 ${realVenvPython}，请先执行 scripts/setup.ps1`)
  process.exit(2)
}
configured.venvPython = realVenvPython
fs.mkdirSync(path.join(RUNTIME_HOME, 'logs'), { recursive: true })
// 每次冒烟都从干净的数据库开始，保证“空账号池”的断言稳定
fs.rmSync(path.join(RUNTIME_HOME, 'data'), { recursive: true, force: true })

const supervisor = new GatewaySupervisor({ options: () => configured, logger })
const client = new GatewayClient({ options: () => configured, logger })

let failed = 0
async function check(title, fn) {
  try {
    const detail = await fn()
    console.log(`  ✔ ${title}${detail === undefined ? '' : ` — ${detail}`}`)
  } catch (error) {
    failed += 1
    console.error(`  ✘ ${title}\n    ${error?.stack ?? error}`)
  }
}

console.log(`使用端口 ${PORT}，运行时 ${RUNTIME_HOME}`)

await check('启动网关并就绪', async () => {
  const snapshot = await supervisor.ensureRunning()
  assert.equal(snapshot.state, GATEWAY_STATE.RUNNING, `状态 ${snapshot.state}：${snapshot.lastError}`)
  assert.ok(snapshot.pid > 0)
  return `pid=${snapshot.pid}`
})

await check('探活 /v1/models', async () => {
  const health = await client.health()
  assert.equal(health.ok, true, health.error)
  const response = await fetch(`http://127.0.0.1:${PORT}/v1/models`)
  const payload = await response.json()
  assert.equal(response.status, 200)
  assert.deepEqual(payload.data.map((model) => model.id), ['GLM-5.2', 'GLM-5-Turbo'])
  return payload.data.map((model) => model.id).join(', ')
})

await check('后台鉴权：错误密码被拒', async () => {
  const wrong = new GatewayClient({ options: () => ({ ...configured, adminKey: 'wrong-key' }), logger })
  await assert.rejects(() => wrong.verify(), /401/)
  return '401'
})

await check('后台鉴权：正确密码通过', async () => {
  const payload = await client.verify()
  assert.equal(payload.status, 'ok')
  return JSON.stringify(payload)
})

await check('账号池：新增 → 列表 → 禁用 → 删除', async () => {
  const added = await client.addAccounts({ provider: 'zai', tokens: 'smoke-fake-api-key-1234567890', name: 'smoke' })
  assert.equal(added.count, 1)
  const id = added.ids[0]

  const listed = await client.accounts()
  const account = listed.accounts.find((entry) => entry.id === id)
  assert.ok(account, '新增的账号应出现在列表里')
  assert.equal(account.mode, 'apiKey')
  assert.match(account.token_masked, /^smoke-fa/)

  await client.setEnabled(id, false)
  const disabled = (await client.accounts()).accounts.find((entry) => entry.id === id)
  assert.equal(disabled.enabled, false)
  assert.equal(disabled.status, 'disabled')

  const removed = await client.removeAccounts([id])
  assert.equal(removed.deleted, 1)
  assert.equal((await client.accounts()).accounts.length, 0)
  return `${id} 增删改查通过`
})

await check('设置：读写后台设置', async () => {
  const before = await client.settings()
  assert.equal(typeof before.gateway_key, 'string')
  await client.updateSettings({ gateway_key: 'smoke-gateway-key' })
  const after = await client.settings()
  assert.equal(after.gateway_key, 'smoke-gateway-key')
  // 设了网关 Key 之后，/v1/models 必须带 Key
  const anonymous = await fetch(`http://127.0.0.1:${PORT}/v1/models`)
  assert.equal(anonymous.status, 401)
  const authorized = await fetch(`http://127.0.0.1:${PORT}/v1/models`, { headers: { 'x-api-key': 'smoke-gateway-key' } })
  assert.equal(authorized.status, 200)
  await client.updateSettings({ gateway_key: '' })
  return '网关 Key 校验生效'
})

await check('协议：空账号池时 /v1/messages 返回结构化错误', async () => {
  const response = await fetch(`http://127.0.0.1:${PORT}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'GLM-5.2', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] }),
  })
  const payload = await response.json()
  assert.equal(response.status, 503)
  assert.equal(payload.error.type, 'no_available_account')
  return `HTTP ${response.status} ${payload.error.type}`
})

await check('停止网关并释放端口', async () => {
  const snapshot = await supervisor.stop({ reason: 'smoke test' })
  assert.equal(snapshot.state, GATEWAY_STATE.STOPPED)
  const health = await client.health()
  assert.equal(health.ok, false, '停止后端口不应再响应')
  return '端口已释放'
})

await check('日志文件有内容', async () => {
  const log = supervisor.tailLines(300)
  assert.ok(log.trim().length > 0)
  assert.match(log, /zcode2api|Uvicorn|startup complete/i)
  return `${log.split('\n').length} 行`
})

await check('端口被占用时快速失败并说明原因', async () => {
  const net = await import('node:net')
  // 自己占住一个端口：连接进来立刻 RST —— 探活失败、试绑端口 EADDRINUSE，
  // 网关应当立刻报“被占用”而不是等 startTimeoutMs 超时。
  const blocker = net.createServer((socket) => socket.destroy())
  await new Promise((resolve) => blocker.listen(0, '127.0.0.1', resolve))
  const busyPort = blocker.address().port
  try {
    const blocked = { ...configured, port: busyPort, baseUrl: `http://127.0.0.1:${busyPort}` }
    const blockedSupervisor = new GatewaySupervisor({
      options: () => blocked,
      logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    })
    const started = Date.now()
    const snapshot = await blockedSupervisor.start()
    const elapsed = Date.now() - started
    assert.equal(snapshot.state, GATEWAY_STATE.FAILED, `期望 failed，得到 ${snapshot.state}`)
    assert.match(snapshot.lastError, /保留|占用/)
    assert.ok(elapsed < 10_000, `应该立刻失败，实际等了 ${elapsed}ms`)
    return `${elapsed}ms：${snapshot.lastError}`
  } finally {
    await new Promise((resolve) => blocker.close(resolve))
  }
})

console.log(`\n${failed === 0 ? '冒烟测试全部通过' : `${failed} 项失败`}`)
process.exit(failed === 0 ? 0 : 1)
