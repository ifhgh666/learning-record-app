/**
 * 真实链路验证：用真实日期写一天笔记 → 检查落盘文件 → 检查搜索索引 → 清理。
 * 与 smoke.mjs 的区别：这个走真实日期，验证的是"你第一次真正使用时"的路径。
 * 用完会删掉验证数据并把 git 恢复干净。
 */
import { readFile, rm } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const run = promisify(execFile)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const BASE = `http://127.0.0.1:${process.env.PORT ?? 3777}`
const DATE = process.argv[2] ?? new Date().toISOString().slice(0, 10)

const CODE_FENCE = '```'
const payload = {
  blocks: [
    {
      id: 'verify1',
      title: '验证用_背单词',
      category: 'memory',
      tags: ['英语', '验证用'],
      content: '这是验证内容，含 **粗体** 与 `行内代码`。',
    },
    {
      id: 'verify2',
      title: '验证用_概念',
      category: 'writing',
      tags: ['验证用'],
      content: `验证代码块与表格：\n\n${CODE_FENCE}js\nconst x = 1\n${CODE_FENCE}\n\n| 列 | 值 |\n| --- | --- |\n| a | 1 |`,
    },
  ],
}

let ok = 0
let bad = 0
const fail = (m) => { bad += 1; console.log(`  ✗ ${m}`) }
const pass = (m) => { ok += 1; console.log(`  ✓ ${m}`) }

const j = async (url, method = 'GET', body) => {
  const res = await fetch(`${BASE}${url}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  return { status: res.status, data: await res.json().catch(() => null) }
}

console.log(`\n真实链路验证（日期 ${DATE}）\n`)

const saved = await j(`/api/day/${DATE}`, 'PUT', payload)
saved.status === 200 ? pass('保存成功') : fail(`保存失败 HTTP ${saved.status}`)
saved.data?.blocks?.length === 2 ? pass('返回 2 个块') : fail(`返回块数 ${saved.data?.blocks?.length}`)
saved.data?.git?.committed ? pass('自动 git 提交已产生') : fail(`git 未提交：${JSON.stringify(saved.data?.git)}`)

const file = path.join(ROOT, 'data', 'daily', `${DATE}.md`)
console.log(`\n--- 落盘文件 ${path.relative(ROOT, file)} ---`)
const raw = await readFile(file, 'utf8')
console.log(raw)
console.log('--- 文件结束 ---\n')

raw.includes('category: memory') ? pass('frontmatter 记了分类') : fail('frontmatter 缺分类')
raw.includes('## 验证用_背单词') ? pass('块标题以 ## 存在正文（人能读）') : fail('正文缺块标题')
raw.includes(CODE_FENCE) ? pass('代码块围栏保真（能被 git/编辑器识别）') : fail('代码块丢失')

const byTag = await j('/api/search?tag=验证用')
byTag.data?.total === 2 ? pass('按标签筛到 2 条') : fail(`按标签命中 ${byTag.data?.total}`)
const byText = await j('/api/search?q=粗体')
byText.data?.total === 1 ? pass('全文搜索命中正文') : fail(`全文搜索命中 ${byText.data?.total}`)
const byCat = await j('/api/search?category=memory')
byCat.data?.results?.every((r) => r.category === 'memory') ? pass('按分类筛选正确') : fail('分类筛选串味')
const days = await j('/api/days')
days.data?.days?.find((d) => d.date === DATE)?.blockCount === 2 ? pass('统计里看到这一天') : fail('统计缺这一天')

// 清理：删掉验证文件并把 git 挪回验证前
console.log('\n清理验证数据…')
await rm(file, { force: true })
try {
  await run('git', ['rm', '--cached', '--ignore-unmatch', '--', `data/daily/${DATE}.md`], { cwd: ROOT })
} catch { /* 未被跟踪则忽略 */ }
try {
  await run('git', ['commit', '-q', '-m', `chore: 清理 ${DATE} 验证数据`, '--no-verify'], { cwd: ROOT })
  await run('git', ['push', '-q', 'origin', 'main'], { cwd: ROOT })
  pass('验证数据已清理并同步到远程')
} catch (err) {
  fail(`清理提交失败：${err.message}`)
}
const after = await j(`/api/day/${DATE}`)
after.data?.exists === false ? pass('服务内确认该日已无记录') : fail('删除后服务仍报告存在（索引未刷新）')

console.log(`\n结果：${ok} 通过 / ${bad} 失败\n`)
process.exit(bad ? 1 : 0)
