/**
 * Wallpaper Engine 集成测试：真实读取本机壁纸库、真实校验资源路径安全性。
 *
 * 不测"换桌面壁纸是否肉眼生效"——那需要人眼确认（见 README 的诚实说明）。
 * 网页背景只做静态预览图（用户明确不要视频背景），所以这里也不再测视频播放。
 */
import assert from 'node:assert/strict'
import { listWallpapers, assetPath, status, isAvailable } from '../server/wallpaper.mjs'

let pass = 0
let fail = 0
const t = async (name, fn) => {
  try {
    await fn()
    pass += 1
    console.log(`  ✓ ${name}`)
  } catch (err) {
    fail += 1
    console.log(`  ✗ ${name}\n      ${err.message}`)
  }
}

console.log('\nWallpaper Engine 集成测试\n')
const st = status()
console.log('环境：')
console.log(`  安装目录存在: ${st.installed}`)
console.log(`  创意工坊目录存在: ${st.workshopFound}`)
console.log(`  使用的 exe: ${st.exe}`)
console.log('')

if (!isAvailable()) {
  console.log('本机没有检测到 Wallpaper Engine 或创意工坊目录，跳过后续测试（功能会在界面上自动隐藏）。\n')
  process.exit(0)
}

const list = await listWallpapers()
console.log(`扫描到 ${list.length} 个壁纸\n`)

await t('扫描到壁纸（>0）', () => {
  assert.ok(list.length > 0, '应该至少有一个壁纸')
})

await t('每个壁纸都有 id 和 title', () => {
  for (const w of list) {
    assert.match(w.id, /^\d+$/, `id 必须是数字：${w.id}`)
    assert.ok(w.title, `缺 title：${w.id}`)
  }
})

await t('type 已统一为小写（本机同时存在 scene/Scene、video/Video）', () => {
  const bad = list.filter((w) => w.type !== w.type.toLowerCase())
  assert.equal(bad.length, 0, `仍有大写 type：${bad.map((w) => `${w.id}=${w.type}`).join(', ')}`)
  const kinds = [...new Set(list.map((w) => w.type))].sort()
  console.log(`      类型分布: ${kinds.join(', ')}`)
})

await t('列表项不再暴露视频相关字段（已按需求移除动态背景）', () => {
  for (const w of list) {
    assert.ok(!('playable' in w), `${w.id} 仍带 playable 字段`)
    assert.ok(!('renderMode' in w), `${w.id} 仍带 renderMode 字段`)
  }
})

await t('每个壁纸都能取到预览图路径，且路径落在该壁纸目录内', async () => {
  let ok = 0
  for (const w of list) {
    if (!w.previewName) continue
    const p = await assetPath(w.id, 'preview')
    assert.ok(p.includes(w.id), `预览路径不在该壁纸目录：${p}`)
    ok += 1
  }
  console.log(`      有预览图: ${ok}/${list.length}`)
  assert.ok(ok > 0, '至少应该有一个预览图')
})

await t('默认 kind=preview（不传参数也能取到预览图）', async () => {
  const withPreview = list.find((w) => w.previewName)
  const p = await assetPath(withPreview.id)
  assert.ok(p, '默认参数应返回预览图路径')
})

await t('拒绝非预览图资源（media 等已不再支持）', async () => {
  const any = list[0]
  await assert.rejects(() => assetPath(any.id, 'media'), /只提供预览图/)
  await assert.rejects(() => assetPath(any.id, 'whatever'), /只提供预览图/)
})

await t('拒绝路径穿越：id 必须是纯数字', async () => {
  await assert.rejects(() => assetPath('../../etc/passwd', 'preview'), /必须是数字/)
  await assert.rejects(() => assetPath('..\\..\\windows', 'preview'), /必须是数字/)
  await assert.rejects(() => assetPath('1618542411/../../x', 'preview'), /必须是数字/)
})

await t('不存在的 id 返回 404 语义', async () => {
  await assert.rejects(
    () => assetPath('999999999999', 'preview'),
    (err) => err.status === 404,
  )
})

await t('没有预览图的壁纸返回 404 语义（而不是抛未处理错误）', async () => {
  const noPreview = list.find((w) => !w.previewName)
  if (!noPreview) {
    console.log('      （本机所有壁纸都有预览图，跳过）')
    return
  }
  await assert.rejects(
    () => assetPath(noPreview.id, 'preview'),
    (err) => err.status === 404,
  )
})

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`)
process.exit(fail ? 1 : 0)
