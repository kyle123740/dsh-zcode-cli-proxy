/**
 * 图片端到端（适配器真路径）：mock 附件服务给宿主文件路径，
 * 走 ZcodeAppServerAdapter.stream() —— 验证 B2 路径（Read 读图转视觉输入）。
 * 长截止（图片回合含工具循环 + max 推理，实测可能 >180s）。
 *   node test/image-adapter-e2e.mjs
 */
import { ZcodeAppServerAdapter } from '../lib/app-server.js'

const IMG = 'C:\\Users\\zy\\AppData\\Local\\Temp\\zcode-img-test.png'

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
  zcodeCliTimeoutMs: 480000,
  retryPolicy: {},
  injectStartPlanAccount: true,
  zcodeDataBaseDir: '',
})

const attachments = {
  // 宿主文件直读路径（零拷贝形态，DSH 的 imageHostPath 同款）
  imageHostPath: (attachment) => (attachment === 'test-img' ? IMG : undefined),
  readImage: async () => { throw new Error('mock: 不该走到 readImage') },
}

const adapter = new ZcodeAppServerAdapter({ options, resolveAttachments: () => attachments, logger })

console.log('=== 适配器图片端到端（zcodeCliTimeoutMs=480s） ===')
try {
  let text = ''
  let usage
  let finish
  const t0 = Date.now()
  for await (const chunk of adapter.stream({
    provider: 'zcode-cli',
    model: 'GLM-5.3-Flash',
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: '这张图片里写的什么字符？只回答图片里的字符本身。' },
        { type: 'image', attachment: 'test-img' },
      ],
    }],
    sessionId: 'img-adapter-e2e',
  })) {
    if (chunk.type === 'text-delta') { process.stdout.write(chunk.text); text += chunk.text }
    if (chunk.type === 'usage') usage = chunk.usage
    if (chunk.type === 'finish') finish = chunk.reason
    if (chunk.type === 'text-delta' && text.length % 80 === 0) process.stdout.write('')
  }
  console.log(`\n\n--- 完成（${Math.round((Date.now() - t0) / 1000)}s） ---`)
  console.log('答复:', JSON.stringify(text.slice(0, 300)))
  console.log('用量:', JSON.stringify(usage))
  console.log('结束:', JSON.stringify(finish))
  console.log(/7391/.test(text) ? '\n✓✓ 图片视觉输入打通（模型读出了 ZCODE-7391）' : '\n✗ 模型答复里没有 7391 —— 视觉输入未生效')
} catch (error) {
  console.error('\n失败:', error?.message ?? error)
  process.exitCode = 1
} finally {
  adapter.dispose()
}
