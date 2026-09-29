/**
 * 端到端复刻测试（最完整的一次）：
 *   同一浏览器上下文里
 *     1. 访问 https://zcode.z.ai/ 过阿里云 WAF、建立会话 cookie
 *     2. 在该页面里跑无痕验证拿到 verifyParam
 *     3. 从该页面同源 fetch 计划端点（Bearer JWT + 全部客户端头）
 *     4. 顺带试 api.z.ai + x-api-key(JWT)
 *
 * 凭证通过环境变量传入，不打印：
 *   ZCODE2API_JWT   账号池 JWT
 *   ZCODE2API_JWT2  客户端当前 JWT（可选）
 *   ZCODE2API_MODEL 默认 GLM-5.3-Flash
 */
const fs = require('fs')
const puppeteer = require('puppeteer-core')

const SCENE = '11xygtvd'
const REGION = 'cn'
const PREFIX = 'no8xfe'
const MODEL = process.env.ZCODE2API_MODEL || 'GLM-5.3-Flash'
const JWT = process.env.ZCODE2API_JWT || ''
const JWT2 = process.env.ZCODE2API_JWT2 || ''

const browsers = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].filter((p) => fs.existsSync(p))

;(async () => {
  const browser = await puppeteer.launch({
    executablePath: browsers[0],
    headless: true,
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled', '--lang=zh-CN'],
  })
  const context = await browser.createBrowserContext()
  const page = await context.newPage()
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ZCode/3.14.3 Chrome/146.0.7680.80 Electron/41.0.3 Safari/537.36',
  )
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'zh-CN,zh;q=0.9' })
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined })
  })

  // ── 1. 过 WAF ──
  const nav = await page
    .goto('https://zcode.z.ai/', { waitUntil: 'networkidle2', timeout: 45000 })
    .then((r) => `HTTP ${r.status()}`)
    .catch((e) => `失败 ${e.message}`)
  const cookies = await context.cookies()
  console.log(`1) 首页: ${nav}   cookie: ${cookies.map((c) => c.name).join(', ') || '(无)'}`)
  if (cookies.length === 0) console.log('   ⚠️ 没拿到 WAF cookie')

  // ── 2. 同源解验证码 ──
  await page.addScriptTag({ url: 'https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js', timeout: 30000 })
  const param = await page.evaluate(
    (scene, region, prefix) =>
      new Promise((resolve, reject) => {
        const host = document.createElement('div')
        host.style.cssText = 'position:fixed;left:-9999px;top:-9999px;'
        const btn = document.createElement('button')
        host.appendChild(btn)
        document.body.appendChild(host)
        const timer = setTimeout(() => reject(new Error('timeout')), 30000)
        window.initAliyunCaptcha({
          SceneId: scene, mode: 'popup', region, prefix,
          element: host, button: btn, captchaLogoImg: '', showErrorTip: false,
          getInstance: (inst) => { try { (inst.startTracelessVerification || inst.show).call(inst) } catch {} },
          success: (p) => { clearTimeout(timer); resolve(p) },
          fail: (e) => { clearTimeout(timer); reject(new Error('fail:' + JSON.stringify(e))) },
          onError: (e) => { clearTimeout(timer); reject(new Error('error:' + JSON.stringify(e))) },
        })
      }),
    SCENE, REGION, PREFIX,
  )
  console.log(`2) 验证码: 已取得 (长度 ${param.length})`)

  // ── 3. 同源发请求 ──
  const attempt = async (label, url, token, useApiKey) =>
    page.evaluate(
      async (label, url, token, model, param, useApiKey) => {
        const headers = {
          'content-type': 'application/json',
          'anthropic-version': '2023-06-01',
          'x-aliyun-captcha-verify-param': param,
          'x-title': 'Z Code@electron',
          'x-platform': 'win32-x64',
          'x-zcode-app-version': '3.14.3',
          'x-release-channel': 'production',
          'x-client-language': 'zh-CN',
          'x-client-timezone': 'Asia/Shanghai',
          'x-os-category': 'windows',
        }
        if (useApiKey) headers['x-api-key'] = token
        else headers['authorization'] = 'Bearer ' + token
        try {
          const res = await fetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify({
              model,
              max_tokens: 24,
              messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
              stream: false,
            }),
          })
          const text = await res.text()
          return `${label} -> HTTP ${res.status}  ${text.slice(0, 260).replace(/\s+/g, ' ')}`
        } catch (e) {
          return `${label} -> 异常 ${String((e && e.message) || e)}`
        }
      },
      label, url, token, MODEL, param, useApiKey,
    )

  const PLAN = 'https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages'
  const API = 'https://api.z.ai/api/anthropic/v1/messages'
  const tokens = [['账号池JWT', JWT], ...(JWT2 ? [['客户端JWT', JWT2]] : [])]
  for (const [name, token] of tokens) {
    if (!token) continue
    console.log('3) ' + (await attempt(`plan  Bearer(${name})`, PLAN, token, false)))
    console.log('   ' + (await attempt(`apiz  x-api-key(${name})`, API, token, true)))
  }

  await browser.close()
  process.exit(0)
})().catch((e) => {
  console.error('测试异常:', (e && e.message) || e)
  process.exit(1)
})
