/**
 * git 自动提交合并（coalesce）测试。
 *
 * 为什么必须测：自动保存很频繁，不合并会让"记一条笔记"产生 7 个提交、
 * 点几次收藏又十几个（实测真的发生过）。但合并涉及 `git commit --amend`，
 * 一旦误 amend 到**外部提交**（用户手敲的、历史重写的）就会破坏别人的历史。
 * 所以这里既测"该合并的合并"，也测"不该合并的坚决不合并"。
 *
 * 安全性：全程在一个**隔离的临时仓库**（.tmp/git-test/）里跑，
 * 绝不对用户的真实仓库做 reset / amend 之类的操作。
 * git.mjs 支持 GIT_REPO_ROOT 环境变量正是为了这一点。
 *
 * 用法：node scripts/test-git-commit.mjs
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, writeFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const run = promisify(execFile)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SANDBOX = path.join(ROOT, '.tmp', 'git-test')

let pass = 0
let fail = 0
const check = (name, cond, detail = '') => {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`) }
  else { fail += 1; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`) }
}

const git = async (...args) => (await run('git', args, { cwd: SANDBOX, windowsHide: true })).stdout.trim()
const count = async () => Number(await git('rev-list', '--count', 'HEAD'))

console.log(`\ngit 提交合并测试（隔离仓库 ${path.relative(ROOT, SANDBOX)}）\n`)

// 准备隔离仓库
await rm(SANDBOX, { recursive: true, force: true })
await mkdir(path.join(SANDBOX, 'data', 'daily'), { recursive: true })
await mkdir(path.join(SANDBOX, 'data'), { recursive: true })
await git('init', '-q', '-b', 'main')
await git('config', 'user.email', 'test@local')
await git('config', 'user.name', 'test')
await writeFile(path.join(SANDBOX, 'seed.txt'), 'seed\n', 'utf8')
await git('add', '-A')
await git('commit', '-q', '-m', 'seed')

// 关键：让 git.mjs 指向这个隔离仓库
process.env.GIT_REPO_ROOT = SANDBOX
const { commitData } = await import('../server/git.mjs')

const D = '1997-03-04'
const dayFile = path.join(SANDBOX, 'data', 'daily', `${D}.md`)
const profileFile = path.join(SANDBOX, 'data', 'profile.json')
const touchDay = (text) =>
  writeFile(dayFile, `---\ndate: '${D}'\nblocks: []\n---\n\n## 测试\n\n${text}\n`, 'utf8')

try {
  console.log('【该合并的：同一份数据的连续改动】')
  await touchDay('第一次')
  const r1 = await commitData(`notes: ${D} (1 块)`)
  check('首次提交成功（非 amend）', r1.committed === true && !r1.amended, JSON.stringify(r1))
  const afterFirst = await count()

  await touchDay('第二次')
  const r2 = await commitData(`notes: ${D} (1 块)`)
  check('第二次改动被合并（amend）', r2.committed === true && r2.amended === true, JSON.stringify(r2))
  check('提交数没有增加', (await count()) === afterFirst, `期望 ${afterFirst}，实际 ${await count()}`)

  await touchDay('第三次')
  const r3 = await commitData(`notes: ${D} (1 块)`)
  check('第三次仍然合并', r3.amended === true, JSON.stringify(r3))
  check('提交数依然没增加', (await count()) === afterFirst, `期望 ${afterFirst}，实际 ${await count()}`)

  console.log('\n【不该合并的：不同 scope】')
  await writeFile(profileFile, JSON.stringify({ nickname: 'x', bio: 'y', startedAt: null }, null, 2), 'utf8')
  const r4 = await commitData('profile: 更新个人档案')
  check('不同 scope 产生新提交（非 amend）', r4.committed === true && !r4.amended, JSON.stringify(r4))
  const afterProfile = await count()
  check('提交数 +1', afterProfile === afterFirst + 1, `期望 ${afterFirst + 1}，实际 ${afterProfile}`)

  const r5 = await commitData('profile: 更新个人档案')
  check('没有实际改动时不产生提交', r5.committed === false && r5.reason === 'no-changes', JSON.stringify(r5))

  console.log('\n【不该合并的：外部提交插入之后】')
  // 模拟用户在终端手敲了一个提交
  await touchDay('经过外部提交之后')
  await git('add', '-A')
  await git('commit', '-q', '-m', 'external: 用户手敲的提交', '--no-verify')
  const afterExternal = await count()

  await touchDay('外部提交之后的新改动')
  const r6 = await commitData(`notes: ${D} (1 块)`)
  check('HEAD 被外部改动后不 amend，改为新增提交', r6.committed === true && !r6.amended, JSON.stringify(r6))
  check('提交数 +1（新起）', (await count()) === afterExternal + 1, `期望 ${afterExternal + 1}，实际 ${await count()}`)

  const extStill = await git('log', '--oneline', '--grep=external: 用户手敲的提交')
  check('外部提交仍在历史中（未被 amend 覆盖）', extStill.includes('external:'), extStill)

  console.log('\n【连续多次自动保存（模拟真实打字）】')
  const beforeTyping = await count()
  for (const t of ['a', 'ab', 'abc', 'abcd', 'abcde']) {
    await touchDay(t)
    await commitData(`notes: ${D} (1 块)`)
  }
  check('多次连续保存只增加 1 个提交', (await count()) === beforeTyping, `期望 ${beforeTyping}，实际 ${await count()}`)
} finally {
  delete process.env.GIT_REPO_ROOT
  await rm(SANDBOX, { recursive: true, force: true })
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`)
process.exit(fail ? 1 : 0)
