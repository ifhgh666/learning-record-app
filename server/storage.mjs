/**
 * 存储层：一天一篇 Markdown 文件，块用 `## ` 标题分隔，分类/标签存在 frontmatter。
 *
 * 文件格式（data/daily/2026-09-24.md）：
 * ---
 * date: 2026-09-24
 * blocks:
 *   - id: k3f9a2
 *     category: memory
 *     tags: [英语, 单词]
 * ---
 *
 * ## 背单词
 *
 * 正文自由 Markdown……
 *
 * ## 一个概念
 *
 * 正文……
 *
 * 设计要点：
 *  - 文件是唯一真相来源（可 grep、可拖进任意编辑器），没有数据库。
 *  - 块级分类/标签存在 frontmatter（机器读），正文标题存人写的标题（人读）。
 *  - 手改文件后能被正确解析；解析失败会明确报错而不是静默丢数据。
 */
import { readFile, writeFile, readdir, mkdir, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import matter from 'gray-matter'

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const DATA_DIR = path.join(ROOT, 'data')
export const DAILY_DIR = path.join(DATA_DIR, 'daily')
export const RECOMMEND_DIR = path.join(DATA_DIR, 'recommend')
export const CACHE_DIR = path.join(DATA_DIR, 'cache')
export const PROFILE_FILE = path.join(DATA_DIR, 'profile.json')

/** 合法的块分类。改这里等于改数据契约，前后端都要同步。 */
export const CATEGORIES = Object.freeze({
  memory: '记忆类',
  writing: '纯写类',
})

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
/** 块标题分隔符：正文里 `## ` 开头的行即新块开始。 */
const BLOCK_HEADING_RE = /^##[ \t]+(.*)$/
/**
 * 无标题块的分隔标记。
 *
 * 为什么需要它：块用 `## 标题` 分隔，那"没有标题的块"就没法表示为独立块——
 * 它的正文会被并进上一块（实测丢过一个块）。用 HTML 注释当分隔符：
 * Markdown 预览里不可见，但解析时边界确定。
 * 用 `## ` 当分隔符、`<!--block-->` 当分隔符这两种写法可以混用。
 */
const BLOCK_MARKER = '<!--block-->'
const BLOCK_MARKER_RE = /^<!--\s*block\s*-->[ \t]*$/i

/** 校验日期字符串，防止把路径穿越（../）当作日期传进来。 */
export function assertDate(date) {
  if (typeof date !== 'string' || !DATE_RE.test(date)) {
    const err = new Error(`日期格式必须是 YYYY-MM-DD，收到：${JSON.stringify(date)}`)
    err.status = 400
    throw err
  }
  const d = new Date(`${date}T00:00:00Z`)
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== date) {
    const err = new Error(`日期不存在：${date}`)
    err.status = 400
    throw err
  }
  return date
}

/** 今天（本机时区，不是 UTC）——用户说“今天”时指的是他桌上的日历。 */
export function todayLocal() {
  const now = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`
}

/** 生成短块 id（6 位 base36）。 */
export function newBlockId() {
  return Math.random().toString(36).slice(2, 8)
}

function dailyPath(date) {
  return path.join(DAILY_DIR, `${assertDate(date)}.md`)
}

/** 去掉标签里的首尾空白与开头的 #，去重，限制长度，最多 20 个。 */
export function normalizeTags(input) {
  const raw = Array.isArray(input) ? input : String(input ?? '').split(',')
  const seen = new Set()
  const out = []
  for (const item of raw) {
    const tag = String(item ?? '').trim().replace(/^#+/, '').trim()
    if (!tag) continue
    const clipped = tag.slice(0, 24)
    const key = clipped.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(clipped)
    if (out.length >= 20) break
  }
  return out
}

/** 归一化一个块：分类必须是已知枚举，id 缺了要补，正文必须是字符串。 */
function normalizeBlock(raw, index) {
  const category = raw?.category === 'memory' || raw?.category === 'writing' ? raw.category : 'writing'
  return {
    id: typeof raw?.id === 'string' && raw.id.trim() ? raw.id.trim().slice(0, 32) : newBlockId(),
    title: typeof raw?.title === 'string' ? raw.title.trim().slice(0, 120) : '',
    category,
    tags: normalizeTags(raw?.tags),
    content: typeof raw?.content === 'string' ? raw.content : '',
    order: Number.isFinite(raw?.order) ? raw.order : index,
  }
}

/**
 * 把文件正文按块切分。两种分隔符等价：
 *   `## 标题`     —— 有标题的块（标题也会作为块的标题显示）
 *   `<!--block-->` —— 无标题的块（标记本身不出现在内容里）
 * 第一个分隔符之前的内容（前言）归入首块，避免手写前言被丢掉。
 */
function splitBlocks(body) {
  const lines = body.split('\n')
  const blocks = []
  let current = null
  const preamble = []

  for (const line of lines) {
    const m = BLOCK_HEADING_RE.exec(line)
    if (m) {
      if (current) blocks.push(current)
      current = { title: m[1].trim(), lines: [] }
      continue
    }
    if (BLOCK_MARKER_RE.test(line)) {
      if (current) blocks.push(current)
      current = { title: '', lines: [] }
      continue
    }
    if (current) current.lines.push(line)
    else preamble.push(line)
  }
  if (current) blocks.push(current)

  const text = (arr) => arr.join('\n').replace(/^\s+|\s+$/g, '')
  const result = blocks.map((b) => ({ title: b.title, content: text(b.lines) }))

  const pre = text(preamble)
  if (pre) result.unshift({ title: '', content: pre })
  return result
}

/**
 * 把块序列化回文件正文。
 *  - 有标题：`## 标题`
 *  - 无标题：`<!--block-->` 标记 + 正文（用标记而不是留空标题，
 *    否则读回时无法区分"新的无标题块"和"上一块的续写"）
 */
function serializeBlocks(blocks) {
  return blocks
    .map((b) => {
      const title = (b.title || '').trim()
      const body = (b.content || '').replace(/\s+$/, '')
      const head = title ? `## ${title}` : BLOCK_MARKER
      return body ? `${head}\n\n${body}` : head
    })
    .join('\n\n')
    .replace(/^\s+|\s+$/g, '')
}

/**
 * 读某天的日记。文件不存在返回空日记（而不是 404）——前端要能直接开写。
 */
export async function readDay(date) {
  assertDate(date)
  const file = dailyPath(date)
  if (!existsSync(file)) {
    return { date, exists: false, blocks: [], updatedAt: null }
  }
  const raw = await readFile(file, 'utf8')
  let parsed
  try {
    parsed = matter(raw)
  } catch (err) {
    const e = new Error(`解析 ${date}.md 的 frontmatter 失败：${err.message}`)
    e.status = 500
    throw e
  }
  const bodyBlocks = splitBlocks(parsed.content ?? '')
  const metaBlocks = Array.isArray(parsed.data?.blocks) ? parsed.data.blocks : []

  // 合并：frontmatter 的元数据 + 正文分出来的内容，按顺序一一对应。
  // 正文块多于元数据时补默认元数据；元数据多于正文时丢弃多余的（避免幽灵块）。
  const blocks = bodyBlocks.map((body, i) => normalizeBlock({ ...(metaBlocks[i] ?? {}), ...body }, i))

  const st = await stat(file)
  return { date, exists: true, blocks, updatedAt: st.mtime.toISOString() }
}

/**
 * 写某天的日记。入参 blocks 会先归一化再落盘；返回落盘后的真实状态。
 */
export async function writeDay(date, blocks) {
  assertDate(date)
  await mkdir(DAILY_DIR, { recursive: true })
  const list = (Array.isArray(blocks) ? blocks : []).map(normalizeBlock)

  const frontmatter = {
    date,
    // 块的分类/标签存这里（机器读）；块标题存在正文的 `## ` 里（人读）。
    blocks: list.map((b, i) => ({
      id: b.id,
      category: b.category,
      tags: b.tags,
      order: i,
    })),
  }

  const body = serializeBlocks(list)
  const file = dailyPath(date)
  const content = matter.stringify(body ? `\n${body}\n` : '\n', frontmatter)
  await writeFile(file, content, 'utf8')
  return readDay(date)
}

/** 列出所有有记录的日期（倒序）。 */
export async function listDates() {
  if (!existsSync(DAILY_DIR)) return []
  const names = await readdir(DAILY_DIR)
  return names
    .filter((n) => DATE_RE.test(n.replace(/\.md$/, '')))
    .map((n) => n.replace(/\.md$/, ''))
    .sort()
    .reverse()
}

/** 读个人档案；不存在给默认值。 */
export async function readProfile() {
  if (!existsSync(PROFILE_FILE)) return { nickname: '', bio: '', startedAt: null }
  try {
    return JSON.parse(await readFile(PROFILE_FILE, 'utf8'))
  } catch {
    return { nickname: '', bio: '', startedAt: null }
  }
}

export async function writeProfile(patch) {
  const current = await readProfile()
  const next = {
    nickname: typeof patch?.nickname === 'string' ? patch.nickname.slice(0, 40) : current.nickname,
    bio: typeof patch?.bio === 'string' ? patch.bio.slice(0, 300) : current.bio,
    startedAt: current.startedAt ?? todayLocal(),
  }
  await mkdir(DATA_DIR, { recursive: true })
  await writeFile(PROFILE_FILE, JSON.stringify(next, null, 2), 'utf8')
  return next
}

/**
 * 统计连续记录天数（从今天或昨天往前数）。
 * 今天还没写不算断——否则每天早上打开都会看到连续天数归零，体验很差。
 */
export function computeStreak(dates, today = todayLocal()) {
  const set = new Set(dates)
  const shift = (dateStr, delta) => {
    const d = new Date(`${dateStr}T00:00:00Z`)
    d.setUTCDate(d.getUTCDate() + delta)
    return d.toISOString().slice(0, 10)
  }
  let cursor = set.has(today) ? today : shift(today, -1)
  if (!set.has(cursor)) return { current: 0, lastDate: dates[0] ?? null }
  let current = 0
  while (set.has(cursor)) {
    current += 1
    cursor = shift(cursor, -1)
  }
  return { current, lastDate: dates[0] ?? null }
}
