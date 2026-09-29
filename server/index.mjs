/**
 * 学习记录本 —— 本机 API 服务（Hono + Node）。
 *
 * 约束（来自需求拷问的决策）：
 *  - 只绑 127.0.0.1，不做登录（留 requireAuth 钩子备用）。
 *  - 文件是唯一真相来源；搜索用启动时构建的内存索引，写盘后增量更新。
 *  - 页面一抓公开 API，当天首次打开抓一次并落快照，当天后续读缓存。
 *  - 每次保存笔记后自动 git commit（只提交 data/）。
 */
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { existsSync, createReadStream } from 'node:fs'
import { readFile, writeFile, mkdir, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'

import {
  listWallpapers,
  assetPath as wallpaperAssetPath,
  status as wallpaperStatus,
  isAvailable as wallpaperAvailable,
} from './wallpaper.mjs'

import {
  CATEGORIES,
  CACHE_DIR,
  DATA_DIR,
  RECOMMEND_DIR,
  ROOT,
  assertDate,
  computeStreak,
  listDates,
  newBlockId,
  readDay,
  readProfile,
  todayLocal,
  writeDay,
  writeProfile,
} from './storage.mjs'
import { commitData, isGitRepo } from './git.mjs'
import { fetchAll } from './sources.mjs'
import {
  aiStatus,
  saveAiConfig,
  listChats,
  readChat,
  writeChat,
  deleteChat,
  callDeepSeek,
} from './ai.mjs'

const PORT = Number(process.env.PORT ?? 3777)
const HOST = '127.0.0.1' // 只本机。想开局域网访问再改成 0.0.0.0 并打开 requireAuth。

const app = new Hono()
app.use('/api/*', cors({ origin: ['http://127.0.0.1:5173', 'http://localhost:5173'] }))

/**
 * 登录钩子：当前恒放行（决策第 17 条）。若以后要开局域网访问，
 * 把这里改成校验请求头 token 即可，其它代码不用动。
 */
app.use('/api/*', async (_c, next) => next())

/** 统一错误出口：带 status 的错误如实返回，其余算 500 并打日志。 */
app.onError((err, c) => {
  const status = err.status && err.status >= 400 ? err.status : 500
  if (status >= 500) console.error('[api] 未处理错误：', err)
  return c.json({ error: err.message ?? '服务器内部错误' }, status)
})

/* ------------------------------------------------------------------ *
 * 搜索索引（内存）：日期 → 块，标签/分类倒排。
 * 数据量小（一年 365 个文件、几千块），启动全扫一次足够快。
 * ------------------------------------------------------------------ */

const index = { days: [], byTag: new Map(), byCategory: { memory: [], writing: [] } }

async function rebuildIndex() {
  const dates = await listDates()
  index.days = []
  index.byTag = new Map()
  index.byCategory = { memory: [], writing: [] }
  for (const date of dates) {
    try {
      const day = await readDay(date)
      const entry = { date, blocks: day.blocks }
      index.days.push(entry)
      for (const b of day.blocks) {
        if (!b.content.trim() && !b.title) continue // 空块不进索引
        for (const tag of b.tags) {
          if (!index.byTag.has(tag)) index.byTag.set(tag, [])
          index.byTag.get(tag).push({ date, id: b.id })
        }
        index.byCategory[b.category]?.push({ date, id: b.id })
      }
    } catch (err) {
      // 单个文件坏掉不能让整个索引挂掉——如实记录，其它日期照常可用。
      console.warn(`[index] 跳过无法解析的文件 ${date}.md：${err.message}`)
    }
  }
  index.days.sort((a, b) => b.date.localeCompare(a.date))
  return { days: index.days.length, tags: index.byTag.size }
}

/** 把某一天的块写回索引（保存后调用，避免全量重扫）。 */
function updateIndexDay(date, blocks) {
  index.days = index.days.filter((d) => d.date !== date)
  index.days.push({ date, blocks })
  index.days.sort((a, b) => b.date.localeCompare(a.date))
  for (const [tag, list] of index.byTag) {
    const rest = list.filter((e) => e.date !== date)
    if (rest.length) index.byTag.set(tag, rest)
    else index.byTag.delete(tag)
  }
  for (const key of Object.keys(index.byCategory)) {
    index.byCategory[key] = index.byCategory[key].filter((e) => e.date !== date)
  }
  for (const b of blocks) {
    if (!b.content.trim() && !b.title) continue
    for (const tag of b.tags) {
      if (!index.byTag.has(tag)) index.byTag.set(tag, [])
      index.byTag.get(tag).push({ date, id: b.id })
    }
    index.byCategory[b.category]?.push({ date, id: b.id })
  }
}

/* ------------------------------------------------------------------ *
 * 页面二 / 页面三：笔记读写与检索
 * ------------------------------------------------------------------ */

app.get('/api/health', (c) =>
  c.json({
    ok: true,
    today: todayLocal(),
    port: PORT,
    git: isGitRepo(),
    categories: CATEGORIES,
    index: { days: index.days.length, tags: index.byTag.size },
  }),
)

app.get('/api/days', async (c) => {
  const dates = await listDates()
  const profile = await readProfile()
  const streak = computeStreak(dates)
  const perDay = dates.map((date) => {
    const entry = index.days.find((d) => d.date === date)
    const blocks = entry?.blocks ?? []
    return {
      date,
      blockCount: blocks.length,
      categories: [...new Set(blocks.map((b) => b.category))],
      tags: [...new Set(blocks.flatMap((b) => b.tags))],
    }
  })
  return c.json({ today: todayLocal(), profile, streak, totalDays: dates.length, days: perDay })
})

app.get('/api/day/:date', async (c) => c.json(await readDay(c.req.param('date'))))

app.put('/api/day/:date', async (c) => {
  const date = assertDate(c.req.param('date'))
  const body = await c.req.json().catch(() => null)
  if (!body || !Array.isArray(body.blocks)) {
    return c.json({ error: '请求体必须包含 blocks 数组' }, 400)
  }
  const saved = await writeDay(date, body.blocks)
  updateIndexDay(date, saved.blocks)
  const git = await commitData(`notes: ${date} (${saved.blocks.length} 块)`)
  return c.json({ ...saved, git })
})

app.post('/api/day/:date/blocks', async (c) => {
  const date = assertDate(c.req.param('date'))
  const day = await readDay(date)
  const body = await c.req.json().catch(() => ({}))
  day.blocks.push({
    id: newBlockId(),
    title: body.title ?? '',
    category: body.category === 'memory' ? 'memory' : 'writing',
    tags: [],
    content: '',
    order: day.blocks.length,
  })
  const saved = await writeDay(date, day.blocks)
  updateIndexDay(date, saved.blocks)
  await commitData(`notes: ${date} 新增一块`)
  return c.json(saved)
})

app.get('/api/search', async (c) => {
  const q = (c.req.query('q') ?? '').trim().toLowerCase()
  const tag = (c.req.query('tag') ?? '').trim().toLowerCase()
  const category = (c.req.query('category') ?? '').trim()
  const from = c.req.query('from') ?? ''
  const to = c.req.query('to') ?? ''

  const results = []
  for (const day of index.days) {
    if (from && day.date < from) continue
    if (to && day.date > to) continue
    for (const b of day.blocks) {
      if (category && b.category !== category) continue
      if (tag && !b.tags.some((t) => t.toLowerCase() === tag)) continue
      const haystack = `${b.title}\n${b.content}\n${b.tags.join(' ')}`.toLowerCase()
      if (q && !haystack.includes(q)) continue
      results.push({
        date: day.date,
        id: b.id,
        title: b.title,
        category: b.category,
        tags: b.tags,
        excerpt: makeExcerpt(b.content, q),
      })
    }
  }
  return c.json({
    query: { q, tag, category, from, to },
    total: results.length,
    results: results.slice(0, 300),
  })
})

app.get('/api/tags', (c) => {
  const tags = [...index.byTag.entries()]
    .map(([name, entries]) => ({ name, count: entries.length }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
  return c.json({ tags, categories: CATEGORIES })
})

app.get('/api/profile', async (c) => c.json(await readProfile()))
app.put('/api/profile', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const saved = await writeProfile(body)
  await commitData('profile: 更新个人档案')
  return c.json(saved)
})

/** 命中位置前后截一段，让搜索结果里能看到关键词上下文。 */
function makeExcerpt(content, q, span = 90) {
  const text = String(content ?? '').replace(/\s+/g, ' ').trim()
  if (!text) return ''
  if (!q) return text.slice(0, span * 2)
  const at = text.toLowerCase().indexOf(q)
  if (at < 0) return text.slice(0, span * 2)
  const start = Math.max(0, at - span)
  const end = Math.min(text.length, at + q.length + span)
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`
}

/* ------------------------------------------------------------------ *
 * 页面一：每日 AI 推荐（当天首次抓取 → 落快照 → 当天读缓存）
 * ------------------------------------------------------------------ */

const recommendStateFile = path.join(RECOMMEND_DIR, 'state.json')

function recommendSnapshotFile(date) {
  const [y, m] = date.split('-')
  return path.join(RECOMMEND_DIR, `${y}-${m}`, `${date}.json`)
}

async function readJson(file, fallback = null) {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch {
    return fallback
  }
}

async function writeJson(file, data) {
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify(data, null, 2), 'utf8')
}

/**
 * 读出最近 N 天推荐过的仓库名，用于让 GitHub 推荐"跨天不重复"。
 * 读取失败（首次运行没有历史快照）就返回空数组，退化为纯按日期轮换。
 */
const RECENT_PUSH_DAYS = 7

async function recentlyPushedRepos(date) {
  const names = []
  for (let i = 1; i <= RECENT_PUSH_DAYS; i += 1) {
    const d = new Date(`${date}T00:00:00Z`)
    d.setUTCDate(d.getUTCDate() - i)
    const snap = await readJson(recommendSnapshotFile(d.toISOString().slice(0, 10)))
    for (const r of snap?.github ?? []) {
      if (r?.fullName) names.push(r.fullName)
    }
  }
  return names
}

/** 读取（或首次抓取）某天的推荐快照。force=true 时忽略缓存重抓。 */
async function ensureSnapshot(date, { force = false } = {}) {
  const file = recommendSnapshotFile(date)
  const cached = await readJson(file)
  if (cached && !force && cached.date === date) {
    return { ...cached, fromCache: true }
  }
  try {
    // 把最近几天推过的仓库告诉数据源，避免今天又推同一个
    const recentPushedNames = await recentlyPushedRepos(date)
    const data = await fetchAll({ recentPushedNames })
    const snapshot = { date, ...data, fromCache: false }
    await writeJson(file, snapshot)
    await commitData(`recommend: ${date} 每日推荐快照`)
    return snapshot
  } catch (err) {
    // 抓取全挂时不要清空已有快照——宁可给用户昨天的，也不要给空白。
    if (cached) return { ...cached, fromCache: true, stale: true, error: String(err.message) }
    return {
      date,
      github: [], news: [], v2ex: [], juejin: [],
      sources: [{ name: '全部数据源', ok: false, error: String(err.message) }],
      fetchedAt: null,
      fetchedError: String(err.message),
    }
  }
}

app.get('/api/recommend/today', async (c) => {
  const date = c.req.query('date') ? assertDate(c.req.query('date')) : todayLocal()
  const force = c.req.query('refresh') === '1'
  const snapshot = await ensureSnapshot(date, { force })
  const state = await readJson(recommendStateFile, { marks: {}, favorites: [] })
  return c.json({ ...snapshot, marks: state.marks ?? {}, favorites: state.favorites ?? [] })
})

/** 标记某个仓库：值得看 / 已看完 / 收藏。状态独立于快照，改标记不重抓。 */
app.post('/api/recommend/mark', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const fullName = String(body.fullName ?? '').trim()
  const status = String(body.status ?? '').trim()
  const allowed = ['worth', 'read', 'none']
  if (!fullName) return c.json({ error: '缺少 fullName' }, 400)
  if (!allowed.includes(status)) return c.json({ error: `status 必须是 ${allowed.join(' / ')}` }, 400)

  const state = await readJson(recommendStateFile, { marks: {}, favorites: [] })
  state.marks ??= {}
  state.favorites ??= []
  if (status === 'none') delete state.marks[fullName]
  else state.marks[fullName] = status
  if (body.favorite === true && !state.favorites.includes(fullName)) state.favorites.push(fullName)
  if (body.favorite === false) state.favorites = state.favorites.filter((n) => n !== fullName)
  await writeJson(recommendStateFile, state)
  await commitData(`recommend: 标记 ${fullName} → ${status}${body.favorite === true ? ' +收藏' : ''}`)
  return c.json({ marks: state.marks, favorites: state.favorites })
})

/** 历史推荐：列出所有快照日期 + 收藏汇总（页面三用）。 */
app.get('/api/recommend/history', async (c) => {
  const dates = []
  if (existsSync(RECOMMEND_DIR)) {
    for (const dir of await readdir(RECOMMEND_DIR, { withFileTypes: true })) {
      if (!dir.isDirectory()) continue
      for (const f of await readdir(path.join(RECOMMEND_DIR, dir.name))) {
        if (/^\d{4}-\d{2}-\d{2}\.json$/.test(f)) dates.push(f.replace(/\.json$/, ''))
      }
    }
  }
  dates.sort().reverse()
  const state = await readJson(recommendStateFile, { marks: {}, favorites: [] })
  const favorites = []
  for (const date of dates) {
    const snap = await readJson(recommendSnapshotFile(date))
    for (const repo of snap?.github ?? []) {
      if ((state.favorites ?? []).includes(repo.fullName)) {
        favorites.push({ ...repo, date, mark: state.marks?.[repo.fullName] ?? 'none' })
      }
    }
  }
  return c.json({ dates, favorites, marks: state.marks ?? {} })
})

/* ------------------------------------------------------------------ *
 * Wallpaper Engine 集成（读本机壁纸库 → 右侧栏显示预览图）
 * ------------------------------------------------------------------ */

/**
 * 提供壁纸的预览图（右侧栏显示用）。
 *
 * 这里刻意不做 HTTP Range、也不暴露原始媒体文件：只展示预览图（用户明确不要
 * 视频/动态背景），预览图都是几百 KB 的 jpg/gif，直接整文件返回最简单可靠。
 */
const IMAGE_MIME = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
}

app.get('/wallpaper-asset/:id/:kind', async (c) => {
  const abs = await wallpaperAssetPath(c.req.param('id'), c.req.param('kind'))
  const st = await stat(abs)
  const ext = path.extname(abs).toLowerCase()
  const type = IMAGE_MIME[ext] ?? 'application/octet-stream'
  c.header('Content-Type', type)
  c.header('Content-Length', String(st.size))
  c.header('Cache-Control', 'private, max-age=3600')
  return c.body(Readable.toWeb(createReadStream(abs)))
})

app.get('/api/wallpaper/status', (c) => c.json({ ...wallpaperStatus(), available: wallpaperAvailable() }))

app.get('/api/wallpaper/list', async (c) => {
  if (!wallpaperAvailable()) {
    return c.json({ available: false, wallpapers: [], status: wallpaperStatus() })
  }
  const wallpapers = await listWallpapers()
  return c.json({ available: true, count: wallpapers.length, wallpapers, status: wallpaperStatus() })
})

/* ------------------------------------------------------------------ *
 * 名言（壁纸栏底部显示）
 * ------------------------------------------------------------------ */

const QUOTES_FILE = path.join(DATA_DIR, 'quotes.json')

/**
 * 返回名言库。
 * 只做"读文件 + 归一化"，不在这里挑某一条——挑选逻辑放前端，
 * 这样切换壁纸或刷新时不必再打一次网络请求。
 */
app.get('/api/quotes', async (c) => {
  try {
    const raw = JSON.parse(await readFile(QUOTES_FILE, 'utf8'))
    const quotes = (Array.isArray(raw?.quotes) ? raw.quotes : [])
      .filter((q) => q && typeof q.text === 'string' && q.text.trim())
      .map((q) => ({ text: q.text.trim(), author: typeof q.author === 'string' ? q.author.trim() : '' }))
    return c.json({ count: quotes.length, quotes })
  } catch (err) {
    if (err.code === 'ENOENT') {
      // 文件被删掉不算错误：如实告知，界面会隐藏这一块
      return c.json({ count: 0, quotes: [], note: 'data/quotes.json 不存在' })
    }
    return c.json({ error: `读取名言库失败：${err.message}` }, 500)
  }
})

/* ------------------------------------------------------------------ *
 * AI 对话（DeepSeek）
 *
 * Key 只存在服务端（环境变量或 data/ai.json），浏览器永远拿不到；
 * 所有请求由这里代理转发，流式响应原样透传。
 * ------------------------------------------------------------------ */

app.get('/api/ai/status', async (c) => c.json(await aiStatus()))

app.put('/api/ai/config', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const status = await saveAiConfig(body)
  return c.json(status)
})

app.get('/api/ai/chats', async (c) => c.json({ chats: await listChats() }))

app.get('/api/ai/chat/:id', async (c) => c.json(await readChat(c.req.param('id'))))

app.put('/api/ai/chat/:id', async (c) => {
  const id = c.req.param('id')
  const body = await c.req.json().catch(() => ({}))
  const saved = await writeChat(id, {
    title: body.title,
    model: body.model,
    createdAt: body.createdAt,
    messages: Array.isArray(body.messages) ? body.messages : [],
  })
  await commitData(`chat: ${id} 保存对话`)
  return c.json(saved)
})

app.delete('/api/ai/chat/:id', async (c) => {
  const id = c.req.param('id')
  const r = await deleteChat(id)
  await commitData(`chat: ${id} 删除对话`)
  return c.json(r)
})

/**
 * 发送对话：把完整消息历史交给 DeepSeek，差量转发响应。
 *
 * 两种模式：
 *  - stream=1（默认）：上游 SSE 原样透传，前端逐字显示。
 *  - stream=0：等完整回复再返回 JSON（便于调试与脚本调用）。
 */
app.post('/api/ai/chat', async (c) => {
  const body = await c.req.json().catch(() => ({}))
  const wantStream = body.stream !== false
  const upstream = await callDeepSeek({
    messages: Array.isArray(body.messages) ? body.messages : [],
    stream: wantStream,
  })

  if (!wantStream) {
    const data = await upstream.json()
    const text = data?.choices?.[0]?.message?.content ?? ''
    return c.json({ content: text, usage: data?.usage ?? null, model: data?.model ?? null })
  }

  // 流式：直接透传 body，并带上 SSE 所需的响应头
  return new Response(upstream.body, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  })
})

/* ------------------------------------------------------------------ *
 * 生产模式：托管构建好的前端（npm start 走这条）
 * ------------------------------------------------------------------ */

const distDir = path.join(ROOT, 'dist')
if (existsSync(path.join(distDir, 'index.html'))) {
  app.use('/*', serveStatic({ root: path.relative(process.cwd(), distDir) }))
  // SPA 兜底：非 /api 路径一律回 index.html
  app.get('*', async (c, next) => {
    if (c.req.path.startsWith('/api/')) return next()
    const html = await readFile(path.join(distDir, 'index.html'), 'utf8')
    return c.html(html)
  })
}

// 启动：先建索引再监听，避免刚打开时搜索返回空。
const built = await rebuildIndex()
serve({ fetch: app.fetch, port: PORT, hostname: HOST }, (info) => {
  console.log(`学习记录本已启动 → http://${HOST}:${info.port}`)
  console.log(`索引：${built.days} 天记录 / ${built.tags} 个标签${isGitRepo() ? ' · git 自动提交已启用' : ' · 未初始化 git，自动提交关闭'}`)
})
