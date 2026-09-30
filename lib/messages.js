/**
 * app-server 通道共用的消息序列化工具：图片落盘、对话拍平、取最后一条用户消息。
 *
 * 从原 cli-provider.js（一次性 CLI 通道，已移除）里拆出来的纯函数，
 * 供 lib/app-server.js 使用。
 *
 * @module lib/messages.js
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { offloadedImageText } from '@deepseek-ai/dsh-llm'

/** 临时图片文件的扩展名（CLI 端同时按魔数嗅探，扩展名只是兜底）。 */
const IMAGE_EXTENSIONS = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
}

/**
 * 把消息里的图片块落成本地可读的图片文件，返回 { imageText, files, tempFiles }。
 *   - imageText：Map<image 块, 占位文本>，flatten 时替换 `type:'image'` 块；
 *   - files：图片文件列表（顺序即占位符编号），agent 用 Read 读它们转成视觉输入；
 *   - tempFiles：files 里属于本函数新建的临时文件（调用后删除）；
 *     imageHostPath 直读后端给出的是 attachment 服务的宿主文件，只附不删。
 *
 * DSH 的 image 块持有 durable attachment 引用（block.attachment），不直接带字节：
 *   - offloaded 块已经是文本形态 → offloadedImageText 占位，不产生附件；
 *   - 宿主文件直读后端 → imageHostPath 拿现成路径（零拷贝）；
 *   - 否则 readImage 读字节 → 写临时文件。
 */
export async function materializeImages(messages, { attachments, logger }) {
  const imageText = new Map()
  const files = []
  const tempFiles = []
  if (attachments === undefined) return { imageText, files, tempFiles }
  let index = 0
  for (const message of messages ?? []) {
    for (const block of message?.content ?? []) {
      if (block === null || typeof block !== 'object' || block.type !== 'image') continue
      if (block.offloaded === true) {
        imageText.set(block, offloadedImageText(block.attachment))
        continue
      }
      try {
        let file = attachments.imageHostPath?.(block.attachment)
        if (file === undefined) {
          const stored = await attachments.readImage(block.attachment)
          const ext = IMAGE_EXTENSIONS[stored.ref?.mediaType] ?? '.png'
          file = path.join(os.tmpdir(), `dsh-zcode-img-${Date.now()}-${index + 1}${ext}`)
          fs.writeFileSync(file, Buffer.from(stored.data))
          tempFiles.push(file)
        }
        index += 1
        files.push(file)
        imageText.set(block, `[图片 #${index}]`)
      } catch (error) {
        logger?.warn?.(`zcode: 读取图片附件失败（${error?.message ?? error}）`)
        imageText.set(block, '[图片（读取失败）]')
      }
    }
  }
  return { imageText, files, tempFiles }
}

/** 删除临时图片文件（尽力而为）。 */
export function removeFiles(files) {
  for (const file of files ?? []) {
    try {
      fs.unlinkSync(file)
    } catch {
      /* 清理失败无妨（临时目录） */
    }
  }
}

function flattenContent(content, imageText) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => {
      if (block === null || typeof block !== 'object') return ''
      if (block.type === 'text') return block.text ?? ''
      if (block.type === 'image') return imageText?.get(block) ?? '[图片]'
      if (block.type === 'tool-call') return `[调用工具 ${block.name}]`
      if (block.type === 'reasoning') return ''
      return ''
    })
    .filter((text) => text !== '')
    .join('\n')
}

/** 把 DSH 的对话拍平成一段可读文本（新会话首轮使用）。 */
export function flattenConversation(messages, system, imageText) {
  const parts = []
  if (typeof system === 'string' && system.trim() !== '') parts.push(`# 系统提示\n${system.trim()}`)
  for (const message of messages ?? []) {
    const content = message.content ?? []
    if (message.role === 'system') {
      const text = flattenContent(content, imageText)
      if (text !== '') parts.push(`# 系统提示\n${text}`)
      continue
    }
    if (message.role === 'assistant') {
      const text = flattenContent(content, imageText)
      const calls = content
        .filter((block) => block !== null && typeof block === 'object' && block.type === 'tool-call')
        .map((block) => `[调用工具 ${block.name}(${block.arguments ?? ''})]`)
      const body = [text, ...calls].filter((value) => value !== '').join('\n')
      if (body !== '') parts.push(`# 助手\n${body}`)
      continue
    }
    const toolResults = content.filter((block) => block !== null && typeof block === 'object' && block.type === 'tool-result')
    for (const result of toolResults) {
      parts.push(`# 工具结果\n${flattenContent(result.content, imageText)}`)
    }
    const text = flattenContent(content, imageText)
    if (text !== '') parts.push(`# 用户\n${text}`)
  }
  return parts.join('\n\n')
}

/** 取最后一条用户消息（续接会话时只发这一条）。 */
export function lastUserText(messages, imageText) {
  for (let index = (messages?.length ?? 0) - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role === 'user') {
      const text = flattenContent(message.content, imageText)
      if (text !== '') return text
    }
  }
  return ''
}
