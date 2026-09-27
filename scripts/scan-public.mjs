/**
 * 公开前隐私扫描：检查即将公开的副本里有没有不该出现的东西。
 *
 * 公开是不可逆的（git 历史永久可检索），所以这一步必须机器扫 + 人眼复核。
 *
 * 设计注意：**扫描器本身不能包含个人信息**（否则它自己就成了泄漏源）。
 * 所以本机相关的特征（用户名、账号名、私人笔记关键词）不硬编码在这里，
 * 而是运行时从一个"本机特征文件"读取（默认 .tmp/privacy-terms.txt，一行一个词，
 * 该文件在 .tmp/ 下、不会被提交）。
 *
 * 用法：
 *   node scripts/scan-public.mjs <公开副本目录> [特征文件]
 */
import { readdirSync, statSync, readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const target = path.resolve(process.argv[2] ?? path.join(ROOT, '..', 'learning-record-public'))
const termsFile = process.argv[3] ?? path.join(ROOT, '.tmp', 'privacy-terms.txt')

/* 本机专有特征：从外部文件读，避免写进代码 */
const localTerms = existsSync(termsFile)
  ? readFileSync(termsFile, 'utf8')
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s && !s.startsWith('#'))
  : []

const TEXT_EXT = new Set([
  '.md', '.mjs', '.js', '.json', '.vue', '.cmd', '.ps1', '.vbs',
  '.yml', '.yaml', '.css', '.html', '.txt', '.gitignore', '.gitattributes',
])

/** 通用敏感特征（与本机无关，可以写死在代码里） */
const GENERIC = [
  { name: '疑似 API Key', re: /sk-[A-Za-z0-9]{16,}/ },
  { name: '疑似 GitHub token', re: /gh[pousr]_[A-Za-z0-9]{20,}/ },
  { name: '疑似私钥', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: '邮箱地址', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/ },
]

function walk(dir, base = '') {
  const out = []
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name)
    const rel = base ? `${base}/${name}` : name
    if (statSync(p).isDirectory()) out.push(...walk(p, rel))
    else out.push(rel)
  }
  return out
}

const files = walk(target)

/* 1) 不该存在的路径 */
const forbiddenPaths = files.filter((f) =>
  /(^|\/)data\//.test(f) ||
  /ai\.json$/.test(f) ||
  /\.npm-cache|node_modules|\.tmp|(^|\/)dist\//.test(f),
)

/* 2) 内容扫描 */
const hits = []
for (const rel of files) {
  // 扫描器自己会被自己的规则命中（规则里就写着敏感词），跳过它
  if (path.basename(rel) === 'scan-public.mjs') continue
  const ext = path.extname(rel).toLowerCase()
  const base = path.basename(rel)
  if (!TEXT_EXT.has(ext) && !TEXT_EXT.has(base)) continue
  let text
  try {
    text = readFileSync(path.join(target, rel), 'utf8')
  } catch {
    continue
  }
  const checks = [...GENERIC]
  for (const term of localTerms) {
    checks.push({
      name: `本机特征「${term.slice(0, 8)}${term.length > 8 ? '…' : ''}」`,
      re: new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'),
    })
  }
  for (const c of checks) {
    const m = c.re.exec(text)
    if (m) {
      const line = text.slice(0, m.index).split('\n').length
      hits.push({ file: rel, line, pattern: c.name, sample: m[0].slice(0, 60) })
    }
  }
}

console.log(`\n扫描目标：${target}`)
console.log(`文件总数：${files.length}`)
console.log(
  localTerms.length
    ? `本机特征词：${localTerms.length} 个（来自 ${path.relative(ROOT, termsFile)}）`
    : `本机特征词：无（未找到 ${path.relative(ROOT, termsFile)}，只做了通用扫描）`,
)

console.log('\n=== 1. 不该存在的路径 ===')
if (forbiddenPaths.length === 0) console.log('  ✓ 无 data/、无 ai.json、无构建产物')
else forbiddenPaths.forEach((f) => console.log(`  ⚠ ${f}`))

console.log('\n=== 2. 不应出现的内容 ===')
if (hits.length === 0) console.log('  ✓ 未命中任何敏感特征')
else hits.forEach((h) => console.log(`  ⚠ ${h.file}:${h.line}  [${h.pattern}]  ${h.sample}`))

console.log('\n=== 3. .cmd 行尾（必须 CRLF，否则别人克隆后双击跑不了） ===')
for (const rel of files.filter((f) => f.endsWith('.cmd'))) {
  const b = readFileSync(path.join(target, rel))
  const crlf = (b.toString('latin1').match(/\r\n/g) ?? []).length
  const lf = (b.toString('latin1').match(/\n/g) ?? []).length
  console.log(`  ${crlf === lf ? '✓' : '⚠'} ${rel}  CRLF ${crlf}/${lf}`)
}

const bad = forbiddenPaths.length + hits.length
console.log(`\n${bad === 0 ? '✓ 可以公开' : `⚠ 有 ${bad} 处需要处理`}\n`)
process.exit(bad === 0 ? 0 : 1)
