/**
 * 客户端会话版无痕验证求解器：通过 CDP 连进正在运行的 ZCode 客户端（Electron），
 * 在它自己的 renderer 页面里跑阿里云 SDK 求解 verifyParam。
 *
 * 与另两个求解器的区别：
 *   - solver.js          jsdom 模拟环境 → 阿里云判 F001
 *   - solver-browser.js  另开一个 Chrome → 能拿到参数，但 zcode 服务端复核 3007
 *   - 本文件             用客户端自己的页面/会话/设备上下文 → 最可能通过服务端复核
 *
 * 前提：ZCode 以 --remote-debugging-port=9222 启动（见 scripts/start-zcode-with-debug.cmd）。
 *
 * 用法：node solver-client-cdp.js [sceneId] [region] [prefix]
 * 成功：stdout 打印 VERIFY_PARAM=<...> 退出 0
 * 失败：4 验证未过 / 5 onError / 6 连不上客户端 / 7 页面里没有 SDK
 */
const https = require('https')
const puppeteer = require('puppeteer-core')

const SCENE = process.argv[2] || '11xygtvd'
const REGION = process.argv[3] || 'cn'
const PREFIX = process.argv[4] || 'no8xfe'
const CDP_URL = process.env.ZCODE_CDP_URL || 'http://127.0.0.1:9222'
const SDK_URL = 'https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js'

function fetchText(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}`))
          res.resume()
          return
        }
        let data = ''
        res.setEncoding('utf8')
        res.on('data', (chunk) => (data += chunk))
        res.on('end', () => resolve(data))
      })
      .on('error', reject)
  })
}

;(async () => {
  let browser
  try {
    browser = await puppeteer.connect({ browserURL: CDP_URL, defaultViewport: null })
  } catch (error) {
    console.error('连不上 ZCode 客户端调试端口：', (error && error.message) || error)
    process.exit(6)
  }

  try {
    const pages = await browser.pages()
    const page = pages.find((p) => /renderer\/index\.html/.test(p.url())) || pages[0]
    if (!page) {
      console.error('客户端里没有可用页面')
      process.exit(6)
    }

    let hasSdk = await page.evaluate(() => typeof window.initAliyunCaptcha === 'function')
    if (!hasSdk) {
      try {
        await page.addScriptTag({ url: SDK_URL, timeout: 30000 })
      } catch {
        // file:// 页面可能有 CSP：退回到手工注入 SDK 源码
        const source = await fetchText(SDK_URL)
        await page.evaluate((code) => {
          const el = document.createElement('script')
          el.textContent = code
          document.head.appendChild(el)
        }, source)
      }
      hasSdk = await page.evaluate(() => typeof window.initAliyunCaptcha === 'function')
    }
    if (!hasSdk) {
      console.error('客户端页面里没有 initAliyunCaptcha（SDK 注入失败）')
      process.exit(7)
    }

    const param = await page.evaluate(
      (scene, region, prefix) =>
        new Promise((resolve, reject) => {
          const host = document.createElement('div')
          host.id = '__zcode2api_cap'
          host.style.cssText = 'position:fixed;left:-9999px;top:-9999px;width:1px;height:1px;'
          const button = document.createElement('button')
          button.id = '__zcode2api_btn'
          host.appendChild(button)
          document.body.appendChild(host)

          const timer = setTimeout(() => reject(new Error('timeout')), 30000)
          const done = (fn, arg) => {
            clearTimeout(timer)
            try {
              host.remove()
            } catch {}
            fn(arg)
          }

          window.initAliyunCaptcha({
            SceneId: scene,
            mode: 'popup',
            region,
            prefix,
            element: '#__zcode2api_cap',
            button: '#__zcode2api_btn',
            captchaLogoImg: '',
            showErrorTip: false,
            getInstance: (inst) => {
              try {
                ;(inst.startTracelessVerification || inst.show).call(inst)
              } catch (e) {
                console.error('start failed', e && e.message)
              }
            },
            success: (p) => done(resolve, p),
            fail: (e) => done(reject, new Error('fail:' + JSON.stringify(e))),
            onError: (e) => done(reject, new Error('error:' + JSON.stringify(e))),
          })
        }),
      SCENE,
      REGION,
      PREFIX,
    )

    console.log('VERIFY_PARAM=' + param)
    browser.disconnect() // 注意：只断开，不关掉用户的客户端
    process.exit(0)
  } catch (error) {
    console.error('客户端内求解失败：', (error && error.message) || error)
    try {
      browser.disconnect()
    } catch {}
    process.exit(4)
  }
})()
