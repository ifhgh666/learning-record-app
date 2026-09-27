/**
 * 构建「公开版」代码副本：只包含代码与示例文件，**不含任何用户数据**。
 *
 * 为什么不直接在现有仓库上操作：
 *  - 现有私有仓库里已经跟踪了 data/daily、data/profile.json、data/recommend 等
 *    个人数据（那是用户的私人备份，必须保留）；
 *  - 公开是不可逆的（git 历史永久可检索），所以公开仓库绝不能带着数据的历史。
 * 独立复制一份全新的、只有代码的仓库是最安全的做法。
 *
 * 用法：node scripts/build-public.mjs <目标目录>
 */
import { cpSync, rmSync, mkdirSync, existsSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dest = process.argv[2]
if (!dest) {
  console.error('用法：node scripts/build-public.mjs <目标目录>')
  process.exit(1)
}
const DEST = path.resolve(dest)

/* 要复制的顶层项（代码与配置，白名单方式，避免漏掉什么就带上了数据） */
const INCLUDE = [
  '.gitattributes',
  'README.md',
  'README.dev.md',
  'docs',
  'package.json',
  'package-lock.json',
  'server',
  'web',
  'scripts',
  'samples',
  '打开DSH.cmd',
  '打开DSH.vbs',
  '学习记录本.vbs',
  '学习记录本(显示日志).cmd',
]

/* 明确排除：这些要么是隐私数据，要么是可再生成的产物 */
const EXCLUDE_NAMES = new Set([
  'data', 'node_modules', 'dist', '.tmp', '.git', '.npm-cache', '.gitignore',
])

rmSync(DEST, { recursive: true, force: true })
mkdirSync(DEST, { recursive: true })

const copied = []
for (const item of INCLUDE) {
  const src = path.join(ROOT, item)
  if (!existsSync(src)) {
    console.warn(`  跳过（不存在）：${item}`)
    continue
  }
  const target = path.join(DEST, item)
  cpSync(src, target, {
    recursive: true,
    filter: (s) => !EXCLUDE_NAMES.has(path.basename(s)),
  })
  copied.push(item)
}

/**
 * 公开副本需要自己的 .gitignore：把 data/ 整个排除（公开仓库不该有用户数据），
 * 但要保留 samples/ 作为示例。
 */
writeFileSync(
  path.join(DEST, '.gitignore'),
  `# 依赖与产物
node_modules/
dist/
*.log
.npm-cache/
.tmp/
*.tmp.txt
commit-msg*.txt

# 密钥（绝不上传）
.env
.env.*
*.key
.credentials*
token.json
data/ai.json

# 用户数据不进公开仓库；示例见 samples/
data/

# 系统文件
.DS_Store
Thumbs.db
desktop.ini
`,
  'utf8',
)

/** 列出结果，方便人工核对"确实没有 data/" */
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

const files = walk(DEST).sort()
console.log(`\n已复制 ${copied.length} 个顶层项到：${DEST}`)
console.log(`文件总数：${files.length}\n`)

const suspicious = files.filter((f) => /(^|\/)data\//.test(f) || /ai\.json$/.test(f))
if (suspicious.length) {
  console.error('⚠ 发现不该出现的数据文件：')
  suspicious.forEach((f) => console.error(`    ${f}`))
  process.exit(1)
}
console.log('✓ 检查通过：副本里没有任何 data/ 内容或密钥文件')
console.log('\n目录概览：')
for (const f of files.slice(0, 25)) console.log(`  ${f}`)
if (files.length > 25) console.log(`  …（其余 ${files.length - 25} 个）`)
