/**
 * 诊断：跑一次浏览器求解，并把与阿里云/验证相关的网络响应打出来，
 * 弄清服务端 VerifyIntelligentCaptcha 的 verifyResult 是什么。
 *
 *   node debug-captcha-net.js [scene] [region] [prefix]
 */
const puppeteer = require('puppeteer-core')
const fs = require('fs')

const SCENE = process.argv[2] || '11xygtvd'
const REGION = process.argv[3] || 'cn'
const PREFIX = process.argv[4] || 'no8xfe'

const candidates = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].filter((p) => fs.existsSync(p))

;(async () => {
  const browser = await puppeteer.launch({
    executablePath: candidates[0],
    headless: true,
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled', '--lang=zh-CN'],
  })
  const page = await browser.newPage()
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36')
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined })
  })

  page.on('response', async (res) => {
    const url = res.url()
    if (!/aliyun|captcha|verify|feilin/i.test(url)) return
    let body = ''
    try {
      body = (await res.text()).slice(0, 400)
    } catch {}
    console.log(`[net] ${res.status()} ${url.slice(0, 150)}`)
    if (body) console.log(`      ${body.replace(/\s+/g, ' ')}`)
  })

  await page.goto('https://zcode.z.ai/', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {})
  await page.setContent('<!DOCTYPE html><html><head></head><body><div id="cap"></div><button id="btn"></button></body></html>', { waitUntil: 'domcontentloaded' })
  await page.addScriptTag({ url: 'https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js', timeout: 30000 })

  const param = await page.evaluate(
    (scene, region, prefix) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timeout')), 30000)
        window.initAliyunCaptcha({
          SceneId: scene, mode: 'popup', region, prefix,
          element: '#cap', button: '#btn', captchaLogoImg: '', showErrorTip: true,
          getInstance: (inst) => { try { (inst.startTracelessVerification || inst.show).call(inst) } catch {} },
          success: (p) => { clearTimeout(timer); resolve(p) },
          fail: (e) => { clearTimeout(timer); reject(new Error('fail:' + JSON.stringify(e))) },
          onError: (e) => { clearTimeout(timer); reject(new Error('error:' + JSON.stringify(e))) },
        })
      }),
    SCENE, REGION, PREFIX,
  )
  console.log('VERIFY_PARAM=' + param)
  await browser.close()
  process.exit(0)
})().catch(async (e) => {
  console.error('失败:', (e && e.message) || e)
  process.exit(4)
})
