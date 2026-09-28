/**
 * 页面一的数据源：全部走公开 API，不需要任何密钥。
 *
 * 已实测（2026-09-24，本机 Node fetch）：
 *  - GitHub Search API：200，未认证限速 10 次/分钟（够用：一天一轮只打 2~4 次）
 *  - V2EX 热门讨论：200，返回真实回复数
 *  - 掘金：必须用 POST（GET 返回空）；且必须用 recommend_cate_feed + sort_type=300，
 *    否则拿到的是固定热门榜（详见下面 fetchJuejin 的注释）
 *
 * 已放弃的数据源（都实测过，别再试）：
 *  - X/Twitter：免费层不能读时间线；RSSHub twitter 路由 404；7 个 Nitter 实例全部
 *    403/451/Cloudflare 挑战页；官方 oEmbed 404。——想要推特内容只能上付费 API。
 *  - Hacker News（hnrss）：RSS 抓取可用，但按用户要求已移除该板块（2026-09-28），
 *    随之删掉了 RSS 解析工具 parseRssItems/getText（不再有调用者）。
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

async function getJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT) })
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
  return res.json()
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
 * 掘金推荐：**按分类取当天最新**。
 *
 * 这里踩过一个坑，值得记下来：最早用的是 recommend_all_feed + sort_type=200，
 * 结果用户反馈"昨天看的今天还是这些"。实测发现那个接口返回的是一批**固定榜单**——
 * 连续两次调用返回完全相同的文章，文章创建时间是 5 月、6 月、7 月的旧文。
 *
 * 换成 recommend_cate_feed + **sort_type=300** 后，返回的是当天发布的文章
 * （实测拿到 2026-09-28 当天的多篇）。所以是接口的选择问题，不是缓存问题。
 *
 * 分类取「人工智能」与「开发工具」两个，与这个项目的使用场景相关；
 * 拉完合并去重再截取。
 */
const JUEJIN_CATES = [
  { id: '6809637773935378440', name: '人工智能' },
  { id: '6809637771511070734', name: '开发工具' },
]

/** 掘金的 ctime 是**秒**，不是毫秒（按毫秒算会得到 1970 年）。 */
function juejinTime(sec) {
  const n = Number(sec)
  if (!n) return null
  return new Date(n > 1e12 ? n : n * 1000).toISOString()
}

async function fetchJuejinCate(cate, limit) {
  const res = await fetch('https://api.juejin.cn/recommend_api/v1/article/recommend_cate_feed', {
    method: 'POST',
    headers: { ...CN_HEADERS, 'Content-Type': 'application/json', Accept: 'application/json' },
    // sort_type=300 = 最新（200 是固定热门榜，会一直返回同一批）
    body: JSON.stringify({ id_type: 2, client_type: 2608, sort_type: 300, cursor: '0', limit, cate_id: cate.id }),
    signal: AbortSignal.timeout(TIMEOUT),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status} for juejin cate ${cate.name}`)
  const data = await res.json()
  if (data?.err_no !== 0) throw new Error(`掘金(${cate.name})返回错误：${data?.err_msg ?? '未知'}`)
  return (data.data ?? [])
    // 注意：cate_feed 的 article_info 直接在 row 上；all_feed 才套一层 item_info
    .map((row) => row?.article_info)
    .filter(Boolean)
    .map((a) => ({
      title: a.title ?? '',
      url: `https://juejin.cn/post/${a.article_id}`,
      cate: cate.name,
      publishedAt: juejinTime(a.ctime),
      views: a.view_count ? Number(a.view_count) : null,
      digs: a.digg_count ? Number(a.digg_count) : null,
      comments: a.comment_count ? Number(a.comment_count) : null,
      brief: (a.brief_content ?? '').slice(0, 160),
    }))
}

export async function fetchJuejin({ limit = 6 } = {}) {
  const settled = await Promise.allSettled(JUEJIN_CATES.map((c) => fetchJuejinCate(c, limit)))
  const merged = settled.flatMap((r) => (r.status === 'fulfilled' ? r.value : []))
  if (!merged.length) {
    const err = settled.find((r) => r.status === 'rejected')?.reason
    throw new Error(`掘金全部分类都没抓到${err ? `：${err.message}` : ''}`)
  }
  // 按发布时间倒序（最新的在前），同一篇只留一次
  const seen = new Set()
  return merged
    .filter((a) => (seen.has(a.url) ? false : (seen.add(a.url), true)))
    .sort((a, b) => String(b.publishedAt ?? '').localeCompare(String(a.publishedAt ?? '')))
    .slice(0, limit)
}

/**
 * 抓一轮全部数据源。单个源失败不影响其它源——返回里带每个源的状态，
 * 前端据此如实展示"某个源今天没抓到"，而不是假装有内容。
 */
export async function fetchAll() {
  const [github, v2ex, juejin] = await Promise.allSettled([
    fetchGithubPick(),
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
    v2ex: pick(v2ex),
    juejin: pick(juejin),
    sources: [
      status(github, 'GitHub'),
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
  console.log(`耗时 ${((Date.now() - started) / 1000).toFixed(1)}s · 仓库 ${data.github.length} / V2EX ${data.v2ex.length} / 掘金 ${data.juejin.length}`)
  console.log('\n-- 今日仓库 --')
  for (const r of data.github.slice(0, 3)) console.log(`  ★${r.stars}  ${r.fullName}（建站 ${r.ageDays} 天）`)
  console.log('\n-- V2EX 热门 --')
  for (const t of data.v2ex.slice(0, 4)) console.log(`  [${t.replies} 回复] ${t.title.slice(0, 40)}`)
  console.log('\n-- 掘金最新（检查时效性：日期应是今天）--')
  for (const a of data.juejin.slice(0, 6)) {
    console.log(`  [${a.publishedAt?.slice(0, 10) ?? '?'}] ${a.cate ?? ''}  ${a.title.slice(0, 36)}`)
  }
}
