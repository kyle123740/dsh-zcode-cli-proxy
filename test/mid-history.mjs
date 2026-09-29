/**
 * 回归：中等长度历史（不触发附件路径）应正常工作。
 *   node test/mid-history.mjs
 */
import { ZcodeCliAdapter } from '../lib/cli-provider.js'

const logger = { info: (m) => console.log('[info]', m), warn: (m) => console.log('[warn]', m), error: (m) => console.log('[error]', m), debug: () => {} }
const options = () => ({
  zcodeCliPath: 'C:\\Users\\zy\\AppData\\Local\\Programs\\ZCode\\resources\\glm\\zcode.cjs',
  zcodeCliNode: 'node',
  cliMode: 'yolo',
  cliCwd: 'C:\\Users\\zy\\ZCodeProject',
  cliModels: [{ id: 'glm-5.3-flash', contextWindow: 200000, maxTokens: 64000 }],
  defaultContextWindow: 200000,
  maxTokens: 32768,
  zcodeCliTimeoutMs: 300000,
  retryPolicy: {},
})

const adapter = new ZcodeCliAdapter({ options, logger })

const messages = []
for (let turn = 0; turn < 3; turn++) {
  messages.push({ role: 'user', content: [{ type: 'text', text: `第 ${turn} 轮问题：项目 ${turn} 的下载量查询` }] })
  messages.push({ role: 'assistant', content: [{ type: 'text', text: `第 ${turn} 轮回答：已处理。` }] })
}
messages.push({ role: 'user', content: [{ type: 'text', text: '请用一句话总结我们聊了什么' }] })

try {
  for await (const chunk of adapter.stream({
    provider: 'zcode-cli',
    model: 'glm-5.3-flash',
    messages,
    sessionId: 'mid-history-test',
  })) {
    if (chunk.type === 'text-delta') process.stdout.write(chunk.text)
  }
  console.log('\n--- 完成 ---')
} catch (error) {
  console.error('失败:', error?.message ?? error)
  process.exit(1)
}
