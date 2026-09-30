/**
 * 端到端验证：app-server 通道 + Start Plan 账户注入 + OAuth 鉴权。
 *   node test/appserver-startplan.mjs
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
  cliModels: [
    { id: 'GLM-5.3-Flash', name: 'GLM-5.3-Flash (Start Plan)', contextWindow: 1000000, maxTokens: 128000 },
  ],
  defaultContextWindow: 1000000,
  maxTokens: 32768,
  appServerTimeoutMs: 120000,
  zcodeCliTimeoutMs: 300000,
  retryPolicy: {},
  injectStartPlanAccount: true,
  zcodeDataBaseDir: '',
})

const adapter = new ZcodeAppServerAdapter({ options, logger })

console.log('=== 端到端：Start Plan 额度调用 ===')
try {
  let text = ''
  let usage = undefined
  let finish = undefined
  for await (const chunk of adapter.stream({
    provider: 'zcode-cli',
    model: 'GLM-5.3-Flash',
    messages: [{ role: 'user', content: [{ type: 'text', text: '只回复两个字：就绪' }] }],
    sessionId: 'startplan-test',
  })) {
    if (chunk.type === 'text-delta') {
      process.stdout.write(chunk.text)
      text += chunk.text
    }
    if (chunk.type === 'usage') usage = chunk.usage
    if (chunk.type === 'finish') finish = chunk.reason
  }
  console.log('\n\n--- 完成 ---')
  console.log('答复:', text.slice(0, 120))
  console.log('用量:', JSON.stringify(usage))
  console.log('结束:', JSON.stringify(finish))
} catch (error) {
  console.error('\n失败:', error?.message ?? error)
  process.exitCode = 1
} finally {
  adapter.dispose()
}
