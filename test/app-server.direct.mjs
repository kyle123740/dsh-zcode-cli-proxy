/**
 * 直接实例化 app-server 适配器跑一轮，打印真实错误（绕开 DSH）。
 *   node test/app-server.direct.mjs
 */
import { ZcodeAppServerAdapter } from '../lib/app-server.js'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const candidates = [
  process.env.ZCODE_CLI_PATH,
  path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'ZCode', 'resources', 'glm', 'zcode.cjs'),
].filter(Boolean)

const options = () => ({
  zcodeCliPath: candidates.find((p) => fs.existsSync(p)) ?? '',
  zcodeCliNode: 'node',
  cliMode: 'yolo',
  cliCwd: 'C:\\Users\\zy\\ZCodeProject',
  cliModels: [{ id: 'glm-5.3-flash', name: 'GLM-5.3-Flash (ZCode CLI)', contextWindow: 200000, maxTokens: 64000 }],
  defaultContextWindow: 200000,
  maxTokens: 32768,
  useAppServer: true,
  appServerTimeoutMs: 120000,
  zcodeCliTimeoutMs: 240000,
  retryPolicy: {},
})

const logger = {
  info: (m) => console.log('[info]', m),
  warn: (m) => console.log('[warn]', m),
  error: (m) => console.log('[error]', m),
  debug: (m) => console.log('[debug]', String(m).slice(0, 200)),
}

const adapter = new ZcodeAppServerAdapter({ options, logger })

// 原始通知监听：看清回合期间到底发生了什么
let notificationCount = 0
adapter.client.onNotification((message) => {
  notificationCount += 1
  const payload = message.params?.payload ?? {}
  const interesting =
    payload.type === 'turn.completed' ||
    payload.type === 'turn.started' ||
    payload.type === 'session.updated' ||
    payload.type === 'model.streaming' ||
    /error|fail|permission|approval|request/i.test(String(message.method)) ||
    /error|fail/i.test(String(payload.type ?? ''))
  if (interesting || notificationCount <= 5) {
    console.log(`[通知 #${notificationCount}]`, message.method, JSON.stringify(payload ?? message.params).slice(0, 260))
  }
})

const optionsArg = {
  provider: 'zcode-cli',
  model: 'glm-5.3-flash',
  system: 'You are a helpful assistant.',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'Reply with exactly: first' }] }],
  sessionId: 'test-session-1',
}

try {
  for await (const chunk of adapter.stream(optionsArg)) {
    if (chunk.type === 'text-delta') process.stdout.write(chunk.text)
    else console.log('\n[chunk]', JSON.stringify(chunk).slice(0, 300))
  }
  console.log('\n--- 第一轮完成 ---')

  // 第二轮：同一 DSH 会话，应该走 resume
  const options2 = { ...optionsArg, sessionId: 'test-session-1', messages: [{ role: 'user', content: [{ type: 'text', text: 'Reply with exactly: second' }] }] }
  for await (const chunk of adapter.stream(options2)) {
    if (chunk.type === 'text-delta') process.stdout.write(chunk.text)
    else console.log('\n[chunk]', JSON.stringify(chunk).slice(0, 300))
  }
  console.log('\n--- 第二轮完成 ---')
} catch (error) {
  console.error('\n失败:', error?.stack ?? error)
  process.exit(1)
}
