/**
 * 诊断：app-server + Start Plan 注入后，回合内所有原始事件。
 *   node test/appserver-verbose.mjs
 */
import { ZcodeAppServerAdapter } from '../lib/app-server.js'

const logger = {
  info: (m) => console.log('[info]', m),
  warn: (m) => console.log('[warn]', m),
  error: (m) => console.log('[error]', m),
  debug: () => {},
}
const options = () => ({
  zcodeCliPath: 'C:\\Users\\zy\\AppData\\Local\\Programs\\ZCode\\resources\\glm\\zcode.cjs',
  zcodeCliNode: 'node',
  cliMode: 'yolo',
  cliCwd: '',
  cliModels: [{ id: 'GLM-5.3-Flash', contextWindow: 1000000, maxTokens: 128000 }],
  defaultContextWindow: 1000000,
  maxTokens: 32768,
  appServerTimeoutMs: 120000,
  zcodeCliTimeoutMs: 180000,
  retryPolicy: {},
  injectStartPlanAccount: true,
  zcodeDataBaseDir: '',
})

const adapter = new ZcodeAppServerAdapter({ options, logger })

// 原始通知监听：打印所有事件（含 turn.failed / 崩溃前的事件）
adapter.client.onNotification((message) => {
  const payload = message.params?.payload ?? {}
  const label = payload.type ?? message.method ?? '?'
  console.log(`[event]`, label, JSON.stringify(payload).slice(0, 220))
})

console.log('=== 诊断：原始事件流 ===')
try {
  let text = ''
  for await (const chunk of adapter.stream({
    provider: 'zcode-cli',
    model: 'GLM-5.3-Flash',
    messages: [{ role: 'user', content: [{ type: 'text', text: '只回复两个字：就绪' }] }],
    sessionId: 'verbose-test',
  })) {
    if (chunk.type === 'text-delta') {
      process.stdout.write(chunk.text)
      text += chunk.text
    }
    if (chunk.type === 'finish') console.log('\n[finish]', JSON.stringify(chunk.reason).slice(0, 300))
    if (chunk.type === 'usage') console.log('[usage]', JSON.stringify(chunk.usage))
  }
  console.log('\n答复:', text.slice(0, 200))
} catch (error) {
  console.error('\n失败:', error?.message ?? error)
  process.exitCode = 1
} finally {
  adapter.dispose()
}
