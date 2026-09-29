/**
 * 真实浏览器版无痕验证求解器：puppeteer-core 驱动本机 Chrome / Edge。
 *
 * 为什么需要它：jsdom 版（solver.js）把阿里云 SDK 跑在模拟环境里，风控侧
 * 返回 verifyCode=F001（验证不通过）——补 UA 等指纹也过不了。真实 Chromium 的
 * 指纹与 ZCode 客户端（Electron/Chromium）一致，可以正常拿到 verifyParam。
 *
 * 用法（与 solver.js 同接口）：
 *   node solver-browser.js [sceneId] [region] [prefix]
 * 成功：stdout 打印 VERIFY_PARAM=<...>，退出码 0
 * 失败：4（验证未通过）/ 5（onError）/ 6（找不到浏览器）/ 3（异常）
 *
 * 环境变量：
 *   ZCODE_BROWSER_PATH  指定浏览器可执行文件
 *   ZCODE_BROWSER_HEADFUL=1  用有界面模式（headless 被风控拦时再试）
 */
const fs = require('fs')
const puppeteer = require('puppeteer-core')

const SCENE = process.argv[2] || '11xygtvd'
const REGION = process.argv[3] || 'cn'
const PREFIX = process.argv[4] || 'no8xfe'
const HEADFUL = process.env.ZCODE_BROWSER_HEADFUL === '1'

const CANDIDATES = [
  process.env.ZCODE_BROWSER_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  process.env.LOCALAPPDATA && `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean)

const executablePath = CANDIDATES.find((p) => {
  try {
    return fs.existsSync(p)
  } catch {
    return false
  }
})
if (!executablePath) {
  console.error('找不到可用浏览器（可用 ZCODE_BROWSER_PATH 指定）')
  process.exit(6)
}

;(async () => {
  const browser = await puppeteer.launch({
    executablePath,
    headless: !HEADFUL,
    args: [
      '--no-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-features=IsolateOrigins,site-per-process',
      '--window-size=1280,860',
      '--lang=zh-CN',
    ],
  })
  try {
    const page = await browser.newPage()
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36',
    )
    await page.setViewport({ width: 1280, height: 860, deviceScaleFactor: 1 })
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined })
      Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh', 'en'] })
      window.chrome = window.chrome || { runtime: {} }
    })
    // 先落到 zcode 源，再换掉文档内容 —— 保持 origin/referrer 与真实客户端一致
    await page.goto('https://zcode.z.ai/', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {})
    await page.setContent('<!DOCTYPE html><html><head></head><body><div id="cap"></div><button id="btn"></button></body></html>', {
      waitUntil: 'domcontentloaded',
    })
    await page.addScriptTag({ url: 'https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js', timeout: 30000 })

    const param = await page.evaluate(
      (scene, region, prefix) =>
        new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('timeout')), 30000)
          if (typeof window.initAliyunCaptcha !== 'function') {
            clearTimeout(timer)
            reject(new Error('AliyunCaptcha 未加载'))
            return
          }
          window.initAliyunCaptcha({
            SceneId: scene,
            mode: 'popup',
            region,
            prefix,
            element: '#cap',
            button: '#btn',
            captchaLogoImg: '',
            showErrorTip: false,
            getInstance: (inst) => {
              try {
                ;(inst.startTracelessVerification || inst.show).call(inst)
              } catch (e) {
                console.error('start 失败:', e && e.message)
              }
            },
            success: (p) => {
              clearTimeout(timer)
              resolve(p)
            },
            fail: (e) => {
              clearTimeout(timer)
              reject(new Error('fail:' + JSON.stringify(e)))
            },
            onError: (e) => {
              clearTimeout(timer)
              reject(new Error('error:' + JSON.stringify(e)))
            },
          })
        }),
      SCENE,
      REGION,
      PREFIX,
    )

    console.log('VERIFY_PARAM=' + param)
    await browser.close()
    process.exit(0)
  } catch (error) {
    console.error('求解失败:', (error && error.message) || error)
    try {
      await browser.close()
    } catch {}
    process.exit(4)
  }
})()
