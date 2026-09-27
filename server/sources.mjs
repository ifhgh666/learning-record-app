/**
 * 页面一的数据源：全部走公开 API / RSS，不需要任何密钥。
 *
 * 已实测（2026-09-24，本机 Node fetch）：
 *  - GitHub Search API：200，未认证限速 10 次/分钟（够用：一天一轮只打 2~4 次）
 *  - Hacker News 最佳（hnrss）：200
 *  - V2EX 热门讨论：200，返回真实回复数
 *  - 掘金推荐：必须用 POST（GET 返回空），带 id_type/sort_type 才出数据
 *
 * 已放弃的数据源（都实测过，别再试）：
 *  - X/Twitter：免费层不能读时间线；RSSHub twitter 路由 404；7 个 Nitter 实例全部
 *    403/451/Cloudflare 挑战页；官方 oEmbed 404。——想要推特内容只能上付费 API。
 *  - 知乎（热榜 401 要登录、RSS 返回 0 字节）、微博热搜（403）、CSDN（RSS 404）、
 *    小红书（返回 HTML 但需登录才见笔记）、36氪（200 但 0 条目）。
 *
 * 注意：PowerShell 的 Invoke-WebRequest 在本机会因系统代理（127.0.0.1:7897）
 * 失败，Node 的 fetch 不受影响。抓取逻辑只能用 Node 的 fetch。
 */
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const UA = 'learning-record/0.1 (personal local notes)'
const TIMEOUT = 20_000

/** 用正则从 XML 里抠出条目，避免为一个小工具引入完整 XML 解析器。 */
function parseRssItems(xml, limit = 200) {
  const items = []
  const re = /<item[\s>][\s\S]*?<\/item>/gi
  for (const m of xml.match(re) ?? []) {
    const pick = (tag) => {
      const r = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i')
      const v = r.exec(m)?.[1] ?? ''
      return v
        .replace(/<!\[CDATA\[|\]\]>/g, '')
        .replace(/<[^>]+>/g, '')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .trim()
    }
    const title = pick('title')
    const link = pick('link') || /<link[^>]*href="([^"]+)"/i.exec(m)?.[1] || ''
    if (title) items.push({ title, link, summary: pick('description').slice(0, 400) })
    if (items.length >= limit) break
  }
  return items
}

async function getJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT) })
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
  return res.json()
}

async function getText(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(TIMEOUT) })
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
  return res.text()
}

/**
 * 说明：这里原本有一套 looksAi() 关键词过滤（含短词词边界修复），
 * 是给 arXiv cs.AI 那 637KB RSS 做筛选用的。后来按用户要求把 arXiv 换成了
 * V2EX + 掘金（都是结构化 API，不需要关键词过滤），所以那套逻辑已整体删除——
 * 留着就是没有调用者的死代码。
 */

/**
 * GitHub：找一个"当天值得看的仓库"。
 *
 * 这里踩过一个真实的坑：早先用 `pushed:>45天 + sort=stars` 选出来的全是
 * 建站 400~3000 天、20 万 star 的老牌巨头（hermes-agent 之类），
 * 那不是"今天值得看的新东西"，而是历史总榜。实测对照后改成以
 * 「近期创建 + 近期活跃 + 排除巨星」为主，并保留一个活跃老项目的兜底查询
 * （新项目枯竭的日子不至于空手）。
 */
export async function fetchGithubPick({ freshDays = 30, activeDays = 45 } = {}) {
  const fresh = new Date(Date.now() - freshDays * 86400_000).toISOString().slice(0, 10)
  const active = new Date(Date.now() - activeDays * 86400_000).toISOString().slice(0, 10)
  const queries = [
    // 主力：最近创建的智能体/LLM 项目（star 上限挡掉老巨头混入）
    `topic:ai-agent created:>${fresh} stars:>50 stars:<8000`,
    `topic:llm-agent created:>${fresh} stars:>30 stars:<8000`,
    `topic:agent created:>${fresh} stars:>80 stars:<8000`,
  ]
  const candidates = []
  for (const q of queries) {
    try {
      const data = await getJson(
        `https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&sort=stars&order=desc&per_page=10`,
      )
      for (const it of data.items ?? []) {
        candidates.push({
          fullName: it.full_name,
          url: it.html_url,
          description: it.description ?? '',
          stars: it.stargazers_count ?? 0,
          language: it.language ?? '',
          topics: it.topics ?? [],
          createdAt: it.created_at ?? '',
          pushedAt: it.pushed_at ?? '',
        })
      }
    } catch (err) {
      console.warn(`[sources] GitHub 查询失败：${q} -> ${err.message}`)
    }
    if (candidates.length >= 15) break
  }

  // 兜底：新项目枯竭时（例如限速或确实没有新仓库），用近期活跃的老项目补位
  if (candidates.length < 3) {
    for (const q of [`topic:ai-agent pushed:>${active} stars:>300 stars:<8000`]) {
      try {
        const data = await getJson(
          `https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&sort=updated&order=desc&per_page=10`,
        )
        for (const it of data.items ?? []) {
          candidates.push({
            fullName: it.full_name, url: it.html_url, description: it.description ?? '',
            stars: it.stargazers_count ?? 0, language: it.language ?? '',
            topics: it.topics ?? [], createdAt: it.created_at ?? '', pushedAt: it.pushed_at ?? '',
          })
        }
      } catch (err) {
        console.warn(`[sources] GitHub 兜底查询失败：${err.message}`)
      }
    }
  }

  // 去重后排序：新仓库优先，同新建时长内 star 高的优先。
  const seen = new Set()
  const uniq = candidates.filter((c) => (seen.has(c.fullName) ? false : (seen.add(c.fullName), true)))
  const ageDays = (c) => (c.createdAt ? (Date.now() - new Date(c.createdAt).getTime()) / 86400_000 : 9999)
  return uniq
    .sort((a, b) => ageDays(a) - ageDays(b) || b.stars - a.stars)
    .slice(0, 8)
    .map((c) => ({ ...c, ageDays: Math.max(0, Math.round(ageDays(c))) }))
}

/** HackerNews：最佳文章（真·人类讨论，免费）。 */
export async function fetchHackerNews({ limit = 6 } = {}) {
  const xml = await getText('https://hnrss.org/best')
  const items = parseRssItems(xml, 60)
  return items.slice(0, limit).map((it) => {
    // hnrss 的 description 里带 "Article URL / Comments URL / Points / # Comments" 结构
    const points = /Points:\s*(\d+)/i.exec(it.summary)?.[1]
    const comments = /#\s*Comments:\s*(\d+)/i.exec(it.summary)?.[1]
    const articleUrl = /Article URL:\s*(\S+)/i.exec(it.summary)?.[1] ?? it.link
    return {
      title: it.title,
      url: articleUrl,
      discussionUrl: it.link,
      score: points ? Number(points) : null,
      comments: comments ? Number(comments) : null,
    }
  })
}

const CN_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
  'Accept-Language': 'zh-CN,zh;q=0.9',
}

/**
 * V2EX 热门讨论：公开 API，无需密钥，返回真实回复数。
 * 话题偏程序员日常与工具，正是"热门讨论"的语感。
 */
export async function fetchV2ex({ limit = 6 } = {}) {
  const res = await fetch('https://www.v2ex.com/api/topics/hot.json', {
    headers: { ...CN_HEADERS, Accept: 'application/json' },
    signal: AbortSignal.timeout(TIMEOUT),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status} for v2ex hot`)
  const data = await res.json()
  return (Array.isArray(data) ? data : []).slice(0, limit).map((t) => ({
    title: t.title ?? '',
    url: t.url ?? `https://www.v2ex.com/t/${t.id}`,
    replies: t.replies ?? 0,
    node: t.node?.title ?? '',
    author: t.member?.username ?? '',
  }))
}

/**
 * 掘金推荐文章：需要 POST（GET 返回空）。实测 POST 带 id_type/sort_type 才出数据。
 */
export async function fetchJuejin({ limit = 6 } = {}) {
  const res = await fetch('https://api.juejin.cn/recommend_api/v1/article/recommend_all_feed', {
    method: 'POST',
    headers: { ...CN_HEADERS, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ id_type: 2, client_type: 2608, sort_type: 200, cursor: '0', limit }),
    signal: AbortSignal.timeout(TIMEOUT),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status} for juejin`)
  const data = await res.json()
  if (data?.err_no !== 0) throw new Error(`掘金返回错误：${data?.err_msg ?? '未知'}`)
  return (data.data ?? [])
    .map((row) => row?.item_info?.article_info)
    .filter(Boolean)
    .slice(0, limit)
    .map((a) => ({
      title: a.title ?? '',
      url: `https://juejin.cn/post/${a.article_id}`,
      views: a.view_count ? Number(a.view_count) : null,
      digs: a.digg_count ? Number(a.digg_count) : null,
      comments: a.comment_count ? Number(a.comment_count) : null,
      brief: (a.brief_content ?? '').slice(0, 160),
    }))
}

/**
 * 抓一轮全部数据源。单个源失败不影响其它源——返回里带每个源的状态，
 * 前端据此如实展示"某个源今天没抓到"，而不是假装有内容。
 */
export async function fetchAll() {
  const [github, hn, v2ex, juejin] = await Promise.allSettled([
    fetchGithubPick(),
    fetchHackerNews(),
    fetchV2ex(),
    fetchJuejin(),
  ])
  const pick = (r) => (r.status === 'fulfilled' ? r.value : [])
  const status = (r, name) => ({
    name,
    ok: r.status === 'fulfilled' && Array.isArray(r.value) && r.value.length > 0,
    error: r.status === 'rejected' ? String(r.reason?.message ?? r.reason) : null,
  })
  return {
    github: pick(github),
    news: pick(hn),      // 字段名沿用 news，内容是 HN 最佳文章
    v2ex: pick(v2ex),
    juejin: pick(juejin),
    sources: [
      status(github, 'GitHub'),
      status(hn, 'Hacker News'),
      status(v2ex, 'V2EX'),
      status(juejin, '掘金'),
    ],
    fetchedAt: new Date().toISOString(),
  }
}

/**
 * 单独运行本文件时的行为：抓一轮并把结果打到 stdout。
 * 用途是预热/自检数据源（见 scripts/prewarm.mjs），日常服务不走这里。
 */
const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href

if (invokedDirectly) {
  const started = Date.now()
  const data = await fetchAll()
  console.log(`数据源状态：${data.sources.map((s) => `${s.name}=${s.ok ? 'OK' : `失败(${s.error ?? '无结果'})`}`).join(', ')}`)
  console.log(`耗时 ${((Date.now() - started) / 1000).toFixed(1)}s · 仓库 ${data.github.length} / HN ${data.news.length} / V2EX ${data.v2ex.length} / 掘金 ${data.juejin.length}`)
  console.log('\n-- 今日仓库 --')
  for (const r of data.github.slice(0, 3)) console.log(`  ★${r.stars}  ${r.fullName}（建站 ${r.ageDays} 天）`)
  console.log('\n-- V2EX 热门 --')
  for (const t of data.v2ex.slice(0, 4)) console.log(`  [${t.replies} 回复] ${t.title.slice(0, 40)}`)
  console.log('\n-- 掘金推荐 --')
  for (const a of data.juejin.slice(0, 4)) console.log(`  [${a.digs ?? '?'} 赞] ${a.title.slice(0, 40)}`)
  console.log('\n-- HN 最佳 --')
  for (const n of data.news.slice(0, 3)) console.log(`  [${n.score ?? '?'} 分] ${n.title.slice(0, 50)}`)
}
