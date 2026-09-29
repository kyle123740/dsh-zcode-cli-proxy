/**
 * 调试版求解器：与 solver.js 同样的环境，但把阿里云 SDK 的 console / jsdom 错误
 * 全部打出来，用来定位 fail() 的原因。不改动 solver.js 本身。
 *
 *   node debug-solver.js [sceneId] [region] [prefix]
 */
const { JSDOM, VirtualConsole } = require('jsdom')

const SCENE = process.argv[2] || '11xygtvd'
const REGION = process.argv[3] || 'cn'
const PREFIX = process.argv[4] || 'no8xfe'

const vc = new VirtualConsole()
vc.on('jsdomError', (e) => console.error('[jsdomError]', e.message, e.detail && String(e.detail).slice(0, 300)))
for (const level of ['error', 'warn', 'log', 'info', 'debug']) {
  vc.on(level, (...args) => console.error(`[sdk:${level}]`, ...args.map((a) => (typeof a === 'string' ? a : (() => { try { return JSON.stringify(a).slice(0, 300) } catch { return String(a) } })()))))
}

const html = `<!DOCTYPE html><html><head></head><body>
<div id="cap"></div><button id="btn"></button>
<script src="https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js"></script>
</body></html>`

const dom = new JSDOM(html, {
  url: 'https://zcode.z.ai/',
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  runScripts: 'dangerously',
  resources: 'usable',
  pretendToBeVisual: true,
  virtualConsole: vc,
  beforeParse(window) {
    // 真实浏览器指纹：jsdom 默认 UA 里带 "jsdom" 字样，阿里云风控直接判 F001
    const define = (obj, key, value) => Object.defineProperty(obj, key, { value, configurable: true, writable: true })
    define(window.navigator, 'userAgent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36')
    define(window.navigator, 'appVersion', '5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36')
    define(window.navigator, 'vendor', 'Google Inc.')
    define(window.navigator, 'platform', 'Win32')
    define(window.navigator, 'language', 'zh-CN')
    define(window.navigator, 'languages', ['zh-CN', 'zh', 'en-US', 'en'])
    define(window.navigator, 'hardwareConcurrency', 8)
    define(window.navigator, 'deviceMemory', 8)
    define(window.navigator, 'webdriver', false)
    define(window.navigator, 'maxTouchPoints', 0)
    window.chrome = { runtime: {}, app: { isInstalled: false } }
    // jsdom 24 不提供 fetch：用 XHR 兜一个最小实现
    if (typeof window.fetch !== 'function') {
      window.fetch = (input, init = {}) => new Promise((resolve, reject) => {
        const url = typeof input === 'string' ? input : (input && input.url) || String(input)
        const xhr = new window.XMLHttpRequest()
        xhr.open((init.method || 'GET').toUpperCase(), url, true)
        for (const [k, v] of Object.entries(init.headers || {})) { try { xhr.setRequestHeader(k, v) } catch {} }
        xhr.onload = () => resolve({ ok: xhr.status >= 200 && xhr.status < 300, status: xhr.status, statusText: xhr.statusText, text: () => Promise.resolve(xhr.responseText), json: () => Promise.resolve(JSON.parse(xhr.responseText)), headers: { get: (n) => xhr.getResponseHeader(n) } })
        xhr.onerror = () => reject(new TypeError('fetch failed'))
        xhr.send(init.body === undefined ? null : init.body)
      })
    }
    window.matchMedia = () => ({ matches: false, media: '', onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent() { return false } })
    const proto = window.HTMLCanvasElement.prototype
    proto.getContext = function (type) {
      if (/webgl/i.test(type)) return { canvas: this, getParameter: () => 'Intel', getExtension: () => null, getSupportedExtensions: () => ['WEBGL_debug_renderer_info'], getContextAttributes: () => ({}), getShaderPrecisionFormat: () => ({ precision: 23, rangeMin: 127, rangeMax: 127 }) }
      return { canvas: this, fillRect() {}, clearRect() {}, getImageData: (x, y, w = 1, h = 1) => ({ data: new Uint8ClampedArray(w * h * 4) }), putImageData() {}, createImageData: (w = 1, h = 1) => ({ data: new Uint8ClampedArray(w * h * 4) }), setTransform() {}, transform() {}, drawImage() {}, save() {}, restore() {}, beginPath() {}, moveTo() {}, lineTo() {}, bezierCurveTo() {}, quadraticCurveTo() {}, closePath() {}, clip() {}, stroke() {}, fill() {}, arc() {}, rect() {}, ellipse() {}, translate() {}, scale() {}, rotate() {}, fillText() {}, strokeText() {}, measureText: (t) => ({ width: ('' + t).length * 8 }), createLinearGradient: () => ({ addColorStop() {} }), createRadialGradient: () => ({ addColorStop() {} }), createPattern: () => ({}), isPointInPath: () => false, font: '10px sans-serif', textBaseline: 'alphabetic', textAlign: 'start', fillStyle: '#000', strokeStyle: '#000', globalAlpha: 1, lineWidth: 1, shadowBlur: 0, shadowColor: '' }
    }
    proto.toDataURL = () => 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
    proto.toBlob = (cb) => cb && cb(null)
    window.Worker = class { constructor() {} postMessage() {} terminate() {} addEventListener() {} removeEventListener() {} onmessage = null; onerror = null }
    window.OffscreenCanvas = window.OffscreenCanvas || class { constructor(w, h) { this.width = w; this.height = h } getContext() { return proto.getContext.call(this) } }
  },
})

const { window } = dom

function waitFor(cond, t = 12000) {
  return new Promise((res, rej) => {
    const s = Date.now()
    const i = setInterval(() => {
      let ok = false
      try { ok = cond() } catch {}
      if (ok) { clearInterval(i); res() } else if (Date.now() - s > t) { clearInterval(i); rej(new Error('timeout waiting for ' + cond)) }
    }, 80)
  })
}

function dumpEnv() {
  const w = window
  console.error('--- 环境 ---')
  console.error('initAliyunCaptcha:', typeof w.initAliyunCaptcha)
  console.error('UA:', w.navigator.userAgent)
  console.error('crypto:', typeof w.crypto, 'getRandomValues:', typeof w.crypto?.getRandomValues)
  console.error('fetch:', typeof w.fetch, 'XMLHttpRequest:', typeof w.XMLHttpRequest)
  console.error('performance.now:', typeof w.performance?.now)
  console.error('WebGL stub:', typeof w.HTMLCanvasElement.prototype.getContext)
  console.error('-------------')
}

;(async () => {
  await waitFor(() => typeof window.initAliyunCaptcha === 'function')
  console.error('AliyunCaptcha 已加载')
  dumpEnv()
  window.initAliyunCaptcha({
    SceneId: SCENE,
    mode: 'popup',
    region: REGION,
    prefix: PREFIX,
    element: '#cap',
    button: '#btn',
    captchaLogoImg: '',
    showErrorTip: true,
    getInstance: (inst) => {
      console.error('getInstance 拿到实例，方法：', Object.keys(inst || {}).slice(0, 20).join(','))
      try {
        const fn = inst.startTracelessVerification || inst.show
        console.error('调用', fn === inst.startTracelessVerification ? 'startTracelessVerification' : 'show')
        fn.call(inst)
      } catch (e) {
        console.error('start 抛错:', e && e.message)
      }
    },
    success: (param) => { console.log('VERIFY_PARAM=' + param); process.exit(0) },
    fail: (e) => { console.error('fail() 被调用，参数:', JSON.stringify(e)); process.exit(4) },
    onError: (e) => { console.error('onError() 被调用，参数:', JSON.stringify(e)); process.exit(5) },
  })
  setTimeout(() => { console.error('25s 超时，未收到 success/fail'); process.exit(2) }, 25000)
})().catch((e) => { console.error('外层异常:', e && e.stack || e); process.exit(3) })
