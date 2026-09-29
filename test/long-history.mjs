/**
 * 复现旧会话长历史 → spawn ENAMETOOLONG
 *   node test/long-history.mjs
 */
import { ZcodeCliAdapter } from '../lib/cli-provider.js'

const logger = { info: () => {}, warn: (m) => console.log('[warn]', m), error: (m) => console.log('[error]', m), debug: () => {} }

const options = () => ({
  zcodeCliPath: 'C:\\Users\\zy\\AppData\\Local\\Programs\\ZCode\\resources\\glm\\zcode.cjs',
  zcodeCliNode: 'node',
  cliMode: 'yolo',
  cliCwd: 'C:\\Users\\zy\\ZCodeProject',
  cliModels: [{ id: 'glm-5.3-flash', contextWindow: 200000, maxTokens: 64000 }],
  defaultContextWindow: 200000,
  maxTokens: 32768,
  retryPolicy: {},
})

const adapter = new ZcodeCliAdapter({ options, logger })

// 模拟一个旧会话的长历史：多轮 + 长工具结果
const filler = 'x'.repeat(4000)
const messages = []
for (let turn = 0; turn < 8; turn++) {
  messages.push({ role: 'user', content: [{ type: 'text', text: `第 ${turn} 轮问题：${filler.slice(0, 200)}` }] })
  messages.push({ role: 'assistant', content: [{ type: 'text', text: `第 ${turn} 轮回答：${filler}` }] })
  messages.push({ role: 'user', content: [{ type: 'tool-result', toolCallId: `call_${turn}`, content: [{ type: 'text', text: filler.slice(0, 3000) }] }] })
}
messages.push({ role: 'user', content: [{ type: 'text', text: '查一下现在我这个项目的下载量怎么样' }] })

const prompt = `# 系统提示\nYou are a helpful assistant.\n\n` +
  messages.map((m) => `# ${m.role}\n${m.content.map((b) => b.text ?? '').join('\n')}`).join('\n\n')

console.log('拍平后的 prompt 长度:', prompt.length, '字符')
console.log('Windows 命令行上限: 32767 字符')
console.log('超限:', prompt.length > 32767)

console.log('\n--- 调用 provider（应报 ENAMETOOLONG） ---')
try {
  for await (const chunk of adapter.stream({
    provider: 'zcode-cli',
    model: 'glm-5.3-flash',
    messages,
    sessionId: 'long-history-test',
  })) {
    console.log('[chunk]', JSON.stringify(chunk).slice(0, 150))
  }
  console.log('（居然成功了）')
} catch (error) {
  console.log('失败:', error?.message ?? error)
}
