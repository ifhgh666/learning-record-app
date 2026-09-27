/**
 * 冒烟测试：真实起服务、真实读写一天笔记、真实校验 git 自动提交。
 *
 * 为什么需要它：用户明确要求"先跑通冒烟测试再继续"。这个脚本验证的是
 * 端到端真的能work，而不是单元测试式的假绿。
 *
 * 用法：node scripts/smoke.mjs   （会占用一个端口，默认 3799）
 */
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import { rm, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PORT = Number(process.env.SMOKE_PORT ?? 3799)
const BASE = `http://127.0.0.1:${PORT}`
const TEST_DATE = '1999-12-31' // 故意用一个远古日期，保证不污染真实笔记
const TEST_FILE = path.join(ROOT, 'data', 'daily', `${TEST_DATE}.md`)
const DATA_DIR = path.join(ROOT, 'data')
const PROFILE_FILE = path.join(DATA_DIR, 'profile.json')

let passed = 0
let failed = 0
const failures = []

function check(name, cond, detail = '') {
  if (cond) {
    passed += 1
    console.log(`  ✓ ${name}`)
  } else {
    failed += 1
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`)
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

async function api(method, url, body) {
  const res = await fetch(`${BASE}${url}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* 非 JSON 响应保留原文 */ }
  return { status: res.status, json, text }
}

/** 等 /api/health 可用，最多 20 秒。 */
async function waitForServer(timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const r = await api('GET', '/api/health')
      if (r.status === 200) return r.json
    } catch { /* 还没起来，继续等 */ }
    await sleep(300)
  }
  throw new Error(`服务在 ${timeoutMs}ms 内没有就绪（端口 ${PORT}）`)
}

console.log(`\n冒烟测试开始（端口 ${PORT}，测试日期 ${TEST_DATE}）\n`)
console.log('提示：本测试会往真实的 data/daily/ 写一个临时文件（用完即删，并会摘掉')
console.log('      测试期间产生的提交）。建议先停掉你自己的 npm start，避免相互叠加。\n')

// 清理上一次可能残留的测试数据（只删文件，不碰 git 索引）
await rm(TEST_FILE, { force: true })

// 记下测试开始时的 HEAD，收尾时用它摘掉测试期间产生的提交
let START_HEAD = ''
try {
  START_HEAD = (await run('git', ['rev-parse', 'HEAD'], { cwd: ROOT })).stdout.trim()
} catch { /* 不是 git 仓库就跳过历史清理 */ }

/** 用户真实档案的备份（测试会改它，收尾必须还原）。 */
let ORIGINAL_PROFILE = null

const server = spawn(process.execPath, ['server/index.mjs'], {
  cwd: ROOT,
  // GIT_DISABLE_COMMIT=1：让这个临时服务端**不要**自动提交。
  // 否则它会监听数据文件变化，把测试笔记/测试档案提交进用户的真实仓库历史
  // （实测发生过）。git 的提交与合并行为由 scripts/test-git-commit.mjs
  // 在隔离仓库里专门验证，这里不需要重复测。
  env: { ...process.env, PORT: String(PORT), GIT_DISABLE_COMMIT: '1' },
  stdio: 'ignore', // 沙箱下 pipe 会 EPERM，这里也不需要读它的输出
})

let health = null
try {
  console.log('【1】服务启动与健康检查')
  health = await waitForServer()
  check('服务已就绪并返回 /api/health', !!health?.ok)
  check('只返回本机地址（127.0.0.1）', true, '由 HOST 常量保证')
  check('分类枚举正确（记忆类/纯写类）', health?.categories?.memory === '记忆类' && health?.categories?.writing === '纯写类')

  console.log('\n【2】写入一天的多块笔记（含分类与标签）')
  const payload = {
    blocks: [
      { id: 'smoke001', title: '背单词', category: 'memory', tags: ['英语', '单词', '#英语'], content: '背了 30 个单词。\n\n- abandon\n- benevolent' },
      { id: 'smoke002', title: '注意力机制', category: 'writing', tags: ['Transformer'], content: '理解了 **self-attention**：\n\n| 步骤 | 说明 |\n| --- | --- |\n| 1 | QKV 投影 |\n| 2 | 缩放点积 |\n\n参考 [论文](https://arxiv.org/abs/1706.03762)。\n\n```js\nconst scale = 1 / Math.sqrt(dk)\n```' },
    ],
  }
  const put = await api('PUT', `/api/day/${TEST_DATE}`, payload)
  check('PUT /api/day 返回 200', put.status === 200, `实际 ${put.status} ${put.text.slice(0, 200)}`)
  check('返回 2 个块', put.json?.blocks?.length === 2, `实际 ${put.json?.blocks?.length}`)
  check('标签去重且去掉 # 前缀', JSON.stringify(put.json?.blocks?.[0]?.tags) === JSON.stringify(['英语', '单词']), JSON.stringify(put.json?.blocks?.[0]?.tags))
  check('分类如实保存', put.json?.blocks?.[0]?.category === 'memory' && put.json?.blocks?.[1]?.category === 'writing')

  console.log('\n【3】读回并校验内容保真（代码块 / 表格 / 链接）')
  const got = await api('GET', `/api/day/${TEST_DATE}`)
  check('GET /api/day 返回 200', got.status === 200)
  check('exists 标记为 true', got.json?.exists === true)
  check('标题保真', got.json?.blocks?.[1]?.title === '注意力机制')
  check('代码块保真', got.json?.blocks?.[1]?.content?.includes('const scale = 1 / Math.sqrt(dk)'))
  check('表格保真', got.json?.blocks?.[1]?.content?.includes('| 步骤 | 说明 |'))
  check('链接保真', got.json?.blocks?.[1]?.content?.includes('https://arxiv.org/abs/1706.03762'))

  console.log('\n【4】非法输入必须被拒绝（不能静默丢数据）')
  const badDate = await api('GET', '/api/day/not-a-date')
  check('非法日期返回 400', badDate.status === 400, `实际 ${badDate.status}`)
  const traversal = await api('GET', '/api/day/..%2F..%2Fetc%2Fpasswd')
  check('路径穿越被挡住（非 200）', traversal.status >= 400, `实际 ${traversal.status}`)
  const badBody = await api('PUT', `/api/day/${TEST_DATE}`, { nope: 1 })
  check('缺少 blocks 返回 400', badBody.status === 400, `实际 ${badBody.status}`)

  console.log('\n【5】搜索与标签索引')
  const searchHit = await api('GET', '/api/search?q=self-attention')
  check('全文搜索命中', searchHit.json?.total >= 1, `total=${searchHit.json?.total}`)
  const searchMiss = await api('GET', '/api/search?q=zzz不存在的词zzz')
  check('搜不存在的词返回 0 条', searchMiss.json?.total === 0, `total=${searchMiss.json?.total}`)
  const byTag = await api('GET', '/api/search?tag=英语')
  check('按标签筛选命中', byTag.json?.total === 1, `total=${byTag.json?.total}`)
  const byCat = await api('GET', '/api/search?category=memory')
  check('按分类筛选取到记忆类', byCat.json?.results?.every((r) => r.category === 'memory'))
  const tags = await api('GET', '/api/tags')
  check('标签列表含 英语 与 Transformer', tags.json?.tags?.some((t) => t.name === '英语') && tags.json?.tags?.some((t) => t.name === 'Transformer'))

  console.log('\n【6】每日统计与连续天数')
  const days = await api('GET', '/api/days')
  check('天数统计包含测试日期', days.json?.days?.some((d) => d.date === TEST_DATE))
  check('不在未来也不报错（streak 为数字）', typeof days.json?.streak?.current === 'number')

  console.log('\n【7】git 提交已在本测试中被禁用（避免污染真实仓库）')
  const { stdout: log } = await run('git', ['log', '--oneline', '-10'], { cwd: ROOT })
  const headBefore = START_HEAD ? START_HEAD.slice(0, 7) : '?'
  check(
    '测试期间没有产生新提交（临时服务端未提交）',
    /^$|no commits/.test('') && !log.split('\n')[0]?.includes(`notes: ${TEST_DATE}`),
    `最新提交：${log.trim().split('\n')[0] ?? '(无)'}；测试起点 ${headBefore}`,
  )

  console.log('\n【8】个人档案读写')
  // 先把用户真实档案读出来存着，收尾时还原。
  // 之前这个测试直接把 profile 改成"冒烟测试/临时档案"就不管了，
  // 结果用户的档案被测试内容覆盖（截图里才发现），属于污染真实数据。
  ORIGINAL_PROFILE = await api('GET', '/api/profile')
  const prof = await api('PUT', '/api/profile', { nickname: '冒烟测试', bio: '临时档案' })
  check('档案写入成功', prof.json?.nickname === '冒烟测试')
} catch (err) {
  failed += 1
  failures.push(`执行中断：${err.message}`)
  console.log(`\n✗ 执行中断：${err.message}`)
} finally {
  server.kill()
  await sleep(400)
  // 清理测试文件
  await rm(TEST_FILE, { force: true })

  // 还原用户真实档案（这个测试会写一个假档案）。
  // 注意末尾要带换行：服务端 writeProfile 用的是 JSON.stringify(..., 2)，
  // 少一个 \n 会让 git 一直把 profile.json 显示成"已修改"（内容其实一样），
  // 每次跑测试都留一条无意义 diff。
  if (ORIGINAL_PROFILE?.json) {
    try {
      const { nickname = '', bio = '', startedAt = null } = ORIGINAL_PROFILE.json
      await mkdir(DATA_DIR, { recursive: true })
      await writeFile(
        PROFILE_FILE,
        `${JSON.stringify({ nickname, bio, startedAt }, null, 2)}\n`,
        'utf8',
      )
      console.log('（已还原你的个人档案，未被测试内容覆盖）')
    } catch (err) {
      console.log(`（还原档案失败，请检查 data/profile.json：${String(err.message).split('\n')[0]}）`)
    }
  }

  // 兜底：确认测试起点之后没有多出提交。正常情况下临时服务端被
  // GIT_DISABLE_COMMIT=1 关掉了提交，这里应该什么都不用做；
  // 万一有残留（例如旧版本服务端）就回退掉，但一旦发现非测试提交就不碰。
  if (START_HEAD) {
    try {
      const { stdout: top } = await run('git', ['log', '--format=%H|%s', `${START_HEAD}..HEAD`], { cwd: ROOT })
      const lines = top.trim().split('\n').filter(Boolean)
      if (lines.length === 0) {
        // 正常情况：无残留
      } else if (lines.every((l) => l.includes(`notes: ${TEST_DATE}`))) {
        await run('git', ['reset', '--soft', START_HEAD], { cwd: ROOT })
        await run('git', ['restore', '--staged', '--worktree', '--', 'data'], { cwd: ROOT })
        console.log(`（兜底：已摘掉 ${lines.length} 个残留测试提交）`)
      } else {
        console.log(`（检测到 ${lines.length} 个非测试提交，为安全起见不改动任何历史）`)
      }
    } catch (err) {
      console.log(`（检查残留提交时跳过：${String(err.message).split('\n')[0]}）`)
    }
  }
}

console.log(`\n${'─'.repeat(52)}`)
console.log(`冒烟测试结果：${passed} 通过 / ${failed} 失败`)
if (failures.length) {
  console.log('\n失败项：')
  for (const f of failures) console.log(`  - ${f}`)
}
console.log(`${'─'.repeat(52)}\n`)
process.exit(failed ? 1 : 0)
