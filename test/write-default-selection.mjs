/**
 * 重新写入 provider_config.json 的 defaultModelSelection（无 BOM、UTF-8）。
 * 与 zcode.cjs 的 Ipe 序列化格式一致。
 *   node test/write-default-selection.mjs
 */
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs'
import { homedir } from 'node:os'

const path = `${homedir()}\\.zcode\\v2\\provider_config.json`
copyFileSync(path, path + '.bak-before-selection')

const config = JSON.parse(readFileSync(path, 'utf8'))
config.config.defaultModelSelection = {
  providerId: 'account:zai-start-plan',
  modelId: 'GLM-5.3-Flash',
  options: { reasoningLevel: 'max' },
}
// JSON.stringify 无 BOM；与 CLI 的 qL（JSON.stringify(o, null, 2)）一致
writeFileSync(path, JSON.stringify(config, null, 2), 'utf8')

// 验证无 BOM
const bytes = readFileSync(path)
console.log('前3字节:', bytes[0], bytes[1], bytes[2], bytes[0] === 123 ? '（无 BOM ✓）' : '（有 BOM ✗）')
const check = JSON.parse(readFileSync(path, 'utf8'))
console.log('JSON 有效 ✓  defaultModelSelection =', JSON.stringify(check.config.defaultModelSelection))
