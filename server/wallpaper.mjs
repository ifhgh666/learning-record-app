/**
 * Wallpaper Engine 集成。
 *
 * 两条能力（都已实测确认）：
 *  1. 读取本机已订阅的创意工坊壁纸（Steam 431960 目录）——直接读文件，无需 API、
 *     不需要登录、不碰 Wallpaper Engine 的程序或数据库。
 *  2. 把壁纸的**预览图**提供给网页右侧栏显示。
 *     为什么只用预览图：用户明确不要动态/视频背景；而且 scene 型（本机 30/41）是
 *     Wallpaper Engine 私有格式（.pkg），浏览器根本无法渲染，只有预览图可用。
 *
 * 曾经还有"通过官方 CLI 把壁纸设为 Windows 桌面壁纸"的能力
 * （wallpaper64.exe -control openWallpaper），按用户要求去做掉
 * 「应用到桌面」后已整体删除；需要时见 git 历史。
 *
 * 环境变量（装到非 Steam 默认位置时用）：WALLPAPER_ENGINE_DIR、WALLPAPER_WORKSHOP_DIR
 */
import { readdir, readFile, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'

/** 默认安装路径；可用环境变量覆盖（装到别的盘或非 Steam 版）。 */export const WE_DIR =
  process.env.WALLPAPER_ENGINE_DIR ??
  'C:\\Program Files (x86)\\Steam\\steamapps\\common\\wallpaper_engine'

/** Steam 创意工坊内容目录。431960 = Wallpaper Engine 的 Steam AppID。 */
export const WORKSHOP_DIR =
  process.env.WALLPAPER_WORKSHOP_DIR ??
  'C:\\Program Files (x86)\\Steam\\steamapps\\workshop\\content\\431960'

/** CLI 可执行文件（优先 64 位）。 */
function cliExe() {
  const x64 = path.join(WE_DIR, 'wallpaper64.exe')
  const x86 = path.join(WE_DIR, 'wallpaper32.exe')
  if (existsSync(x64)) return x64
  if (existsSync(x86)) return x86
  return null
}

/** 本机是否装了 Wallpaper Engine（没装则该功能整体隐藏，而不是报错）。 */
export function isAvailable() {
  return cliExe() !== null && existsSync(WORKSHOP_DIR)
}

export function status() {
  const exe = cliExe()
  return {
    installed: exe !== null,
    workshopFound: existsSync(WORKSHOP_DIR),
    weDir: WE_DIR,
    workshopDir: WORKSHOP_DIR,
    exe: exe ? path.basename(exe) : null,
  }
}

/**
 * 扫描已订阅壁纸。
 *
 * 注意两个实测踩到的坑：
 *  - `type` 字段大小写不统一（同一台机器上同时存在 `scene` 和 `Scene`、`video` 和
 *    `Video`），所以必须统一转小写再比较，否则会把 5 个壁纸错分类。
 *  - 部分壁纸目录里没有 project.json（下载不完整/被清理），要跳过而不是抛错。
 */
export async function listWallpapers() {
  if (!existsSync(WORKSHOP_DIR)) return []
  const entries = await readdir(WORKSHOP_DIR, { withFileTypes: true })
  const out = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const dir = path.join(WORKSHOP_DIR, entry.name)
    let pj
    try {
      pj = JSON.parse(await readFile(path.join(dir, 'project.json'), 'utf8'))
    } catch {
      continue // 没有或坏的 project.json：跳过
    }
    const type = String(pj.type ?? '').toLowerCase()
    const file = typeof pj.file === 'string' ? pj.file : ''
    const preview = typeof pj.preview === 'string' ? pj.preview : ''
    // 预览图实际文件名可能与 project.json 声明的不一致，回退到目录里的候选
    const previewName = await pickPreview(dir, preview)

    out.push({
      id: entry.name,
      title: pj.title ?? entry.name,
      type: type || 'unknown',
      file,
      previewName,
      tags: Array.isArray(pj.tags) ? pj.tags.slice(0, 8) : [],
    })
  }
  out.sort((a, b) => a.title.localeCompare(b.title, 'zh-Hans-CN'))
  return out
}

async function isFile(p) {
  try {
    return (await stat(p)).isFile()
  } catch {
    return false
  }
}

/** 找预览图：优先 project.json 里声明的，否则扫目录里的 preview.* 或第一张图。 */
async function pickPreview(dir, declared) {
  const candidates = []
  if (declared) candidates.push(declared)
  candidates.push('preview.jpg', 'preview.gif', 'preview.png')
  for (const c of candidates) {
    if (await isFile(path.join(dir, c))) return c
  }
  // 兜底：目录里的第一张图（部分壁纸把预览命名成别的）
  try {
    const files = await readdir(dir)
    const img = files.find((f) => /\.(jpe?g|png|gif|webp)$/i.test(f))
    return img ?? ''
  } catch {
    return ''
  }
}

/** 由壁纸 id 定位其目录（不接受任意路径，防目录穿越）。 */
function dirOf(id) {
  if (!/^\d+$/.test(String(id))) {
    const err = new Error('壁纸 id 必须是数字（Steam 创意工坊 ID）')
    err.status = 400
    throw err
  }
  const dir = path.join(WORKSHOP_DIR, String(id))
  if (!existsSync(dir)) {
    const err = new Error(`没有找到壁纸 ${id}`)
    err.status = 404
    throw err
  }
  return dir
}

/**
 * 解析出可安全对外提供的壁纸资源绝对路径。
 *
 * 目前只提供预览图：用户明确不要视频背景，而 scene 型（占多数）浏览器根本无法渲染，
 * 所以不需要"原始媒体"这条路。
 */
export async function assetPath(id, kind = 'preview') {
  const dir = dirOf(id)
  if (kind !== 'preview') {
    const err = new Error(`只提供预览图，不支持资源类型：${kind}`)
    err.status = 400
    throw err
  }
  const pj = JSON.parse(await readFile(path.join(dir, 'project.json'), 'utf8'))
  const name = await pickPreview(dir, pj.preview)
  if (!name) {
    const err = new Error('这个壁纸没有预览图')
    err.status = 404
    throw err
  }
  return path.join(dir, name)
}

/**
 * 说明：本模块是**只读**的——只读 Steam 创意工坊目录里的文件，
 * 不修改 Wallpaper Engine 的设置，也不改桌面壁纸。
 */

