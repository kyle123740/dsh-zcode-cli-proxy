/**
 * 在 ZCode 客户端自己的页面里发一次上游请求（结论性测试）。
 *
 * 与 Python 直连对比：这条路径带着客户端的 Chromium TLS 指纹、来源与会话，
 * 如果它 200 而 Python 直连 3012，就说明风控卡在“请求不是客户端发的”。
 *
 * 凭证与参数通过环境变量传入，不打印：
 *   ZCODE2API_JWT    账号 JWT
 *   ZCODE2API_PARAM  X-Aliyun-Captcha-Verify-Param
 *   ZCODE2API_MODEL  默认 GLM-5.3-Flash
 */
const puppeteer = require('puppeteer-core')

const CDP_URL = process.env.ZCODE_CDP_URL || 'http://127.0.0.1:9222'
const JWT = process.env.ZCODE2API_JWT || ''
const PARAM = process.env.ZCODE2API_PARAM || ''
const MODEL = process.env.ZCODE2API_MODEL || 'GLM-5.3-Flash'

;(async () => {
  if (!JWT || !PARAM) {
    console.error('缺少 ZCODE2API_JWT / ZCODE2API_PARAM')
    process.exit(2)
  }
  const browser = await puppeteer.connect({ browserURL: CDP_URL, defaultViewport: null })
  const pages = await browser.pages()
  const page = pages.find((p) => /renderer\/index\.html/.test(p.url())) || pages[0]

  try {
    const result = await page.evaluate(
      async (jwt, param, model) => {
        try {
          const res = await fetch('https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages', {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              authorization: 'Bearer ' + jwt,
              'anthropic-version': '2023-06-01',
              'x-zcode-app-version': '3.14.3',
              'x-zcode-agent': 'glm',
              'x-aliyun-captcha-verify-param': param,
            },
            body: JSON.stringify({
              model,
              max_tokens: 24,
              messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
              stream: false,
            }),
          })
          const text = await res.text()
          return { status: res.status, text: text.slice(0, 400), origin: location.origin }
        } catch (e) {
          return { error: String((e && e.message) || e), origin: location.origin }
        }
      },
      JWT,
      PARAM,
      MODEL,
    )
    console.log('页面来源:', result.origin)
    if (result.error) console.log('页面内请求异常:', result.error)
    else console.log(`客户端内请求 -> HTTP ${result.status}  ${String(result.text).replace(/\s+/g, ' ')}`)
    browser.disconnect()
    process.exit(0)
  } catch (error) {
    console.error('测试失败:', (error && error.message) || error)
    try {
      browser.disconnect()
    } catch {}
    process.exit(3)
  }
})()
