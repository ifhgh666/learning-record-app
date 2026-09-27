/**
 * 预热：把"今天"的推荐抓下来存成快照，这样你第一次打开页面一就是瞬间加载，
 * 而不是对着空白页等 5 秒。
 *
 * 幂等：已经有今天的快照就跳过（除非加 --force）。
 * 用法：
 *   node scripts/prewarm.mjs            # 没有今天的快照才抓
 *   node scripts/prewarm.mjs --force    # 强制重抓
 */
import { existsSync } from 'node:fs'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { RECOMMEND_DIR, todayLocal } from '../server/storage.mjs'
import { fetchAll } from '../server/sources.mjs'

const force = process.argv.includes('--force')
const date = todayLocal()
const [y, m] = date.split('-')
const file = path.join(RECOMMEND_DIR, `${y}-${m}`, `${date}.json`)

async function readJson(f) {
  try { return JSON.parse(await readFile(f, 'utf8')) } catch { return null }
}

const existing = await readJson(file)
if (existing && !force) {
  console.log(`今天（${date}）的快照已存在，跳过。抓取于 ${existing.fetchedAt ?? '未知'}。`)
  console.log('想强制重抓：node scripts/prewarm.mjs --force')
  process.exit(0)
}

console.log(`正在抓取 ${date} 的推荐…`)
const t0 = Date.now()
try {
  const data = await fetchAll()
  const snapshot = { date, ...data, fromCache: false }
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify(snapshot, null, 2), 'utf8')
  const failed = data.sources.filter((s) => !s.ok)
  console.log(`✓ 已写入 ${path.relative(process.cwd(), file)}（${((Date.now() - t0) / 1000).toFixed(1)}s）`)
  console.log(`  仓库 ${data.github.length} 个 / HN ${data.news.length} 条 / V2EX ${data.v2ex.length} 条 / 掘金 ${data.juejin.length} 条`)
  if (failed.length) console.log(`  ⚠ 部分数据源没抓到：${failed.map((s) => s.name).join('、')}`)
  if (data.github[0]) console.log(`  今日仓库：${data.github[0].fullName} ★${data.github[0].stars}（建站 ${data.github[0].ageDays} 天）`)
} catch (err) {
  console.error(`✗ 抓取失败：${err.message}`)
  console.error('  不影响使用——打开页面一会自己重试。')
  process.exit(1)
}
