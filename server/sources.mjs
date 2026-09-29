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
 * GitHub：每天推一批"值得看的近期新仓库"。
 *
 * 这里踩过三个真实的坑：
 *
 * 坑 1：早先用 `pushed:>45天 + sort=stars`，选出来的全是建站 400~3000 天、
 *   20 万 star 的老牌巨头，那是"历史总榜"不是"今天值得看的新东西"。
 *   改成以「近期创建 + 排除巨星（star 上限）」为主。
 *
 * 坑 2（用户反馈"昨天和今天推的是同一个仓库"）：查询只有 3 条、全在
 *   topic:agent 系列，而且最后按「建站天数」升序排 —— 结果永远优先推那批最新的，
 *   同一天看是稳定的，但隔一天几乎不变（30 天窗口里新进来的仓库很少能挤进前 8）。
 *
 * 坑 3：GitHub 的 `created:>` **不接受相对天数**。`created:>30d` 会返回
 *   total_count=0（实测），必须是绝对日期 `created:>2026-08-30`。
 *   （排查上面问题时我写探测脚本图省事用了 `30d`，结果所有话题都"0 条"，
 *   白绕了一圈。写在这里免得以后又踩。）
 *
 * 现在的做法：
 *   - 查询集按用户的要求分 7 个方向（agent / RAG / LLM+MCP / 工具插件 / 前端 /
 *     后端 / 全栈），每天从中轮换挑 6 组查询（受未认证限速 10 次/分钟约束）
 *   - 把所有候选汇总去重成一个大池子
 *   - 用**当天日期做种子**在池子里轮换取用：所以同一天多次刷新结果稳定，
 *     隔一天必然换一批（这是"每天要更新"的保证）
 *   - 保留 star 上限 8000，避免老巨头混入
 */
const GH_GROUPS = [
  { name: 'Agent', topics: ['topic:ai-agent', 'topic:llm-agent', 'topic:multi-agent', 'topic:agent-framework', 'topic:agent'] },
  { name: 'RAG', topics: ['topic:rag', 'topic:retrieval-augmented-generation', 'topic:vector-database', 'topic:embedding'] },
  { name: 'LLM', topics: ['topic:mcp', 'topic:llm', 'topic:llmops', 'topic:prompt-engineering'] },
  { name: '工具', topics: ['topic:cli', 'topic:developer-tools', 'topic:vscode-extension', 'topic:neovim-plugin', 'topic:automation'] },
  { name: '前端', topics: ['topic:vue', 'topic:react', 'topic:typescript', 'topic:frontend'] },
  { name: '后端', topics: ['topic:backend', 'topic:golang', 'topic:rust', 'topic:fastapi', 'topic:database'] },
  { name: '全栈', topics: ['topic:fullstack', 'topic:web-app', 'topic:nextjs'] },
]

/** 每次抓取用几组查询：未认证限速 10 次/分钟，留余量给兜底查询。 */
const GH_GROUPS_PER_RUN = 6

/** 当天日期做种子的伪随机（同一天稳定、隔天不同，无需真实随机数）。 */
function daySeed(dateStr) {
  let h = 2166136261
  for (const ch of dateStr) {
    h ^= ch.charCodeAt(0)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

/** 用种子从数组里取一个从 offset 开始的循环切片（保证每天取到的不同）。 */
function rotateBySeed(list, seed, offset) {
  if (!list.length) return []
  const start = (seed + offset) % list.length
  return [...list.slice(start), ...list.slice(0, start)]
}

export async function fetchGithubPick({ freshDays = 30, activeDays = 45, dateStr, recentPushedNames = [] } = {}) {
  const today = dateStr ?? new Date().toISOString().slice(0, 10)
  const fresh = new Date(Date.now() - freshDays * 86400_000).toISOString().slice(0, 10)
  const active = new Date(Date.now() - activeDays * 86400_000).toISOString().slice(0, 10)
  const seed = daySeed(today)

  // 每天轮换一组查询：按种子把方向顺序打乱后取前 N 个
  const groupsToday = rotateBySeed(GH_GROUPS, seed, 0).slice(0, GH_GROUPS_PER_RUN)

  const candidates = []
  const rateLimited = []
  for (const group of groupsToday) {
    // 每个方向里也按种子轮换一个话题，避免同方向每天都是同一个话题
    const topic = rotateBySeed(group.topics, seed, group.name.length)[0]
    const q = `${topic} created:>${fresh} stars:>30 stars:<8000`
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
          group: group.name,
        })
      }
    } catch (err) {
      const msg = String(err.message)
      // GitHub 搜索接口未认证时限制 10 次/分钟。这里显式区分出来：
      // 其余查询仍会继续，只是当天候选变少；不要让"限速"看起来像"这个方向没内容"。
      if (msg.includes('403') || msg.includes('429')) {
        rateLimited.push(group.name)
        console.warn(`[sources] GitHub 限速（未认证 10 次/分钟），跳过 ${group.name}：${q}`)
      } else {
        console.warn(`[sources] GitHub 查询失败：${q} -> ${msg}`)
      }
    }
    if (candidates.length >= 60) break
  }
  if (rateLimited.length) {
    console.warn(`[sources] GitHub 共 ${rateLimited.length} 组查询被限速：${rateLimited.join('、')}（当天候选会少一些）`)
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
            group: 'Agent',
          })
        }
      } catch (err) {
        console.warn(`[sources] GitHub 兜底查询失败：${err.message}`)
      }
    }
  }

  // 去重（同一仓库可能带多个话题，被多个方向查到）
  const seen = new Set()
  const uniq = candidates.filter((c) => (seen.has(c.fullName) ? false : (seen.add(c.fullName), true)))

  // 先按"建站时间"排（新的优先），再按当天种子轮换取用——
  // 这样既有新鲜度，又保证每天推的不是同一批。
  const ageDays = (c) => (c.createdAt ? (Date.now() - new Date(c.createdAt).getTime()) / 86400_000 : 9999)
  const ranked = [...uniq].sort((a, b) => ageDays(a) - ageDays(b) || b.stars - a.stars)

  /**
   * 质量门槛：只要 star 数够的仓库。
   *
   * 为什么要这一步：实测轮换算法会捞出 ★3、★4 这种刚建站、根本没人看的仓库
   * （还有一个 3 星仓库的镜像号也混进来了），那种"推荐"没有价值。
   * 先把候选限制在 star≥30 里；万一不够 8 个再逐步放宽，宁可少推也不推噪音。
   */
  const minStars = [30, 15, 5, 0].find((m) => ranked.filter((c) => c.stars >= m).length >= 8) ?? 0
  const pool = ranked.filter((c) => c.stars >= minStars)

  /**
   * 取用时做"**跨天不重复**"的硬保证。
   *
   * 只靠"当天种子轮换"是不够的：加了质量门槛后候选池变小，实测
   * mikehasa/golive-skill 在 09-28 和 09-30 都出现过（轮换的起点落在同一个窗口里）。
   * 用户明确要求"每天要更新"，所以这里改成：
   *   从池子里按种子取 8 个，然后逐条检查它们**近 N 天是否已经推过**；
   *   推过的换成池子里的下一个候选。
   * 传入 recentPushed（近几天的推荐记录）即可生效；没有历史数据时退化为纯轮换。
   */
  const recentlyPushed = new Set(recentPushedNames)
  const ordered = rotateBySeed(pool.slice(0, 60), seed, 7)

  const perGroup = new Map()
  const picked = []
  const taken = new Set()

  const tryTake = (c, enforceGroupCap) => {
    if (taken.has(c.fullName)) return false
    if (recentlyPushed.has(c.fullName)) return false
    if (enforceGroupCap) {
      const used = perGroup.get(c.group) ?? 0
      if (used >= 2) return false
      perGroup.set(c.group, used + 1)
    }
    taken.add(c.fullName)
    picked.push(c)
    return true
  }

  // 第一轮：每个方向最多 2 个
  for (const c of ordered) {
    if (picked.length >= 8) break
    tryTake(c, true)
  }
  // 第二轮：方向不限，只要没推过就补进来
  for (const c of ordered) {
    if (picked.length >= 8) break
    tryTake(c, false)
  }
  // 第三轮（最后手段）：池子里实在没有没推过的了，允许重复，但至少别空手
  for (const c of ordered) {
    if (picked.length >= 8) break
    if (!taken.has(c.fullName)) { taken.add(c.fullName); picked.push(c) }
  }

  return picked.map((c) => ({ ...c, ageDays: Math.max(0, Math.round(ageDays(c))) }))
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
 * 掘金：从**近期**文章里挑**有人看的**。
 *
 * 这段踩过两个坑，都记下来：
 *
 * 坑 1：最早用 recommend_all_feed + sort_type=200，用户反馈"昨天看的今天还是这些"。
 *   实测发现那是个**固定榜单**——连续两次调用返回完全相同的文章，
 *   且都是 5/6/7 月的旧文。换成 recommend_cate_feed + sort_type=300 才拿到当天文章。
 *
 * 坑 2：换成"当天最新"后，用户反馈"都是很少赞的"。这其实无解——
 *   掘金上刚发布的文章本来就没赞：实测最新一批 20 条里 17 条阅读 <50，
 *   平均阅读仅 26。而 sort_type=200 那批有 131 赞，却都是几个月前的旧文。
 *   "又新又高赞"在数据上不存在。
 *
 * 解法：**拉大候选池，在"近期"范围内按热度挑**。
 *   四个分类 × 两种排序（300 最新 / 3 近几天）各拉一批，去重后得到 130 条左右，
 *   全部落在近 3 天内；再按「阅读 + 评论 + 点赞」综合排序取前几名。
 *   实测平均阅读量从 26 提升到 808，且仍都是近 1~3 天的文章。
 *
 * 评论权重给得最高，因为它比点赞更能说明"真的有人讨论"。
 */
const JUEJIN_CATES = [
  { id: '6809637773935378440', name: '人工智能' },
  { id: '6809637771511070734', name: '开发工具' },
  { id: '6809637767543259144', name: '前端' },
  { id: '6809637769959178254', name: '后端' },
]

/** 候选池用的排序：300=纯最新，3=近几天（实测两者能捞到不同的文章）。 */
const JUEJIN_SORTS = [300, 3]

/** 只考虑这个天数内发布的文章，避免为了热度把几个月前的旧文捞上来。 */
const JUEJIN_MAX_AGE_DAYS = 10

/** 掘金的 ctime 是**秒**，不是毫秒（按毫秒算会得到 1970 年）。 */
function juejinTime(sec) {
  const n = Number(sec)
  if (!n) return null
  return new Date(n > 1e12 ? n : n * 1000).toISOString()
}

/**
 * 综合热度分：阅读量打底，评论与点赞加权（它们更能说明内容被认可）。
 * 评论权重最高：1 条评论 ≈ 30 次阅读 ≈ 3 个赞。
 */
function juejinScore(a) {
  return (a.views ?? 0) + (a.comments ?? 0) * 30 + (a.digs ?? 0) * 10
}

async function fetchJuejinCate(cate, sortType, limit) {
  const res = await fetch('https://api.juejin.cn/recommend_api/v1/article/recommend_cate_feed', {
    method: 'POST',
    headers: { ...CN_HEADERS, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ id_type: 2, client_type: 2608, sort_type: sortType, cursor: '0', limit, cate_id: cate.id }),
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

export async function fetchJuejin({ limit = 6, poolPerQuery = 20 } = {}) {
  const queries = JUEJIN_CATES.flatMap((cate) => JUEJIN_SORTS.map((sortType) => ({ cate, sortType })))
  const settled = await Promise.allSettled(
    queries.map((q) => fetchJuejinCate(q.cate, q.sortType, poolPerQuery)),
  )

  const pool = settled.flatMap((r) => (r.status === 'fulfilled' ? r.value : []))
  if (!pool.length) {
    const err = settled.find((r) => r.status === 'rejected')?.reason
    throw new Error(`掘金全部分类都没抓到${err ? `：${err.message}` : ''}`)
  }

  // 去重（同一篇可能同时出现在不同分类/排序里）
  const seen = new Set()
  const uniq = pool.filter((a) => (seen.has(a.url) ? false : (seen.add(a.url), true)))

  // 时效窗口：只保留近期文章
  const cutoff = Date.now() - JUEJIN_MAX_AGE_DAYS * 86400_000
  const fresh = uniq.filter((a) => (a.publishedAt ? Date.parse(a.publishedAt) >= cutoff : false))

  // 窗口内一条都没有（极端情况）就退回全部候选，宁可给几篇稍旧的也别空手
  const candidates = fresh.length ? fresh : uniq

  return [...candidates].sort((a, b) => juejinScore(b) - juejinScore(a)).slice(0, limit)
}

/**
 * 抓一轮全部数据源。单个源失败不影响其它源——返回里带每个源的状态，
 * 前端据此如实展示"某个源今天没抓到"，而不是假装有内容。
 *
 * recentPushedNames：最近几天已经推过的仓库名，传给 GitHub 源用于跨天去重。
 */
export async function fetchAll({ recentPushedNames = [] } = {}) {
  const [github, v2ex, juejin] = await Promise.allSettled([
    fetchGithubPick({ recentPushedNames }),
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
