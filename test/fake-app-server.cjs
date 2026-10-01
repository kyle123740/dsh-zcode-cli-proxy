/**
 * 假的 `zcode app-server`：只讲 lib/app-server.js 用到的那几条 JSON-RPC，
 * 用来验证回合锁的恢复逻辑（不需要真的 ZCode 客户端与额度）。
 *
 * 环境变量：
 *   FAKE_LOG   把收到的每条消息按行写进这个文件（测试用断言就看它）
 *   FAKE_MODE  normal     send 后 80ms 正常结束回合
 *              stuck-once 第一次 send 回 "A prompt is already running for this session"，之后正常
 *              stale-once 第一次 send 回 "session … not found"（会话被回收），之后正常
 *              hold       send 永远不结束（测被中止时有没有补发 session/stop）
 *              gate       send 不结束，直到收到 notify test/finish {sessionId}
 */

const fs = require('node:fs')
const readline = require('node:readline')

const LOG = process.env.FAKE_LOG
const MODE = process.env.FAKE_MODE || 'normal'

const write = (message) => process.stdout.write(JSON.stringify(message) + '\n')
const log = (entry) => {
  if (LOG) fs.appendFileSync(LOG, JSON.stringify(entry) + '\n')
}

let sendCount = 0
let sessionCount = 0
const pendingFinish = new Map() // sessionId → resolve

write({ method: 'startup/runtime', params: { phase: 'ready' } })

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let message
  try {
    message = JSON.parse(line)
  } catch {
    return
  }
  log({ ...message, sendCount, sessionCount })
  if (message.method === undefined) return // 我方请求的响应，CLI 不需要处理

  // 通知（没有 id）
  if (message.id === undefined) {
    if (message.method === 'test/finish') {
      const sessionId = message.params?.sessionId
      const finish = pendingFinish.get(sessionId)
      if (finish !== undefined) {
        pendingFinish.delete(sessionId)
        finish()
      }
    }
    return
  }

  switch (message.method) {
    case 'session/create':
      sessionCount += 1
      write({ id: message.id, result: { session: { sessionId: `fake-sess-${sessionCount}` } } })
      break
    case 'session/send': {
      sendCount += 1
      const sessionId = message.params.sessionId
      if (MODE === 'stuck-once' && sendCount === 1) {
        write({ id: message.id, error: { message: 'A prompt is already running for this session' } })
        break
      }
      if (MODE === 'stale-once' && sendCount === 1) {
        write({ id: message.id, error: { message: `session ${sessionId} not found` } })
        break
      }
      write({ id: message.id, result: { accepted: true, seq: sendCount } })
      const emit = (payload) => write({ method: 'session/event', params: { sessionId, ...payload } })
      const complete = () => {
        emit({ type: 'model.streaming', payload: { kind: 'text_delta', delta: `hello-${sendCount}`, done: false } })
        emit({
          type: 'turn.completed',
          payload: { response: `hello-${sendCount}`, resultType: 'success', usage: { inputTokens: 1, outputTokens: 2 } },
        })
      }
      if (MODE === 'hold') break
      if (MODE === 'gate') {
        pendingFinish.set(sessionId, complete)
        break
      }
      setTimeout(complete, 80)
      break
    }
    default:
      write({ id: message.id, result: {} })
  }
})
