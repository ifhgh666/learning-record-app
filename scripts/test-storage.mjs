/**
 * 存储层边界情况测试：直接测 storage.mjs 的纯函数，
 * 覆盖"手改文件导致 frontmatter 与正文块数不一致"等真实场景。
 *
 * 为什么单独测这个：文件是唯一真相来源，用户随时可能手动编辑它。
 * 解析器在这里出错等于静默丢数据——这是本项目最不能接受的失败模式。
 */
import { mkdir, writeFile, rm, readFile } from 'node:fs/promises'
import path from 'node:path'
import assert from 'node:assert/strict'
import { DAILY_DIR, readDay, writeDay, normalizeTags, computeStreak } from '../server/storage.mjs'

const D = '1998-01-02' // 远古日期，避免撞到真实笔记
const file = path.join(DAILY_DIR, `${D}.md`)

let pass = 0
let fail = 0
function t(name, fn) {
  try {
    fn()
    pass += 1
    console.log(`  ✓ ${name}`)
  } catch (err) {
    fail += 1
    console.log(`  ✗ ${name}\n      ${err.message}`)
  }
}

async function ta(name, fn) {
  try {
    await fn()
    pass += 1
    console.log(`  ✓ ${name}`)
  } catch (err) {
    fail += 1
    console.log(`  ✗ ${name}\n      ${err.message}`)
  }
}

console.log('\n存储层边界情况测试\n')
await mkdir(DAILY_DIR, { recursive: true })

console.log('【标签归一化】')
t('去重（大小写不敏感）', () => {
  assert.deepEqual(normalizeTags(['JS', 'js', 'Js']), ['JS'])
})
t('去掉开头的 #', () => {
  assert.deepEqual(normalizeTags(['#英语', '##单词']), ['英语', '单词'])
})
t('过滤空白项', () => {
  assert.deepEqual(normalizeTags(['  ', '', 'ok', null, undefined]), ['ok'])
})
t('最多 20 个', () => {
  assert.equal(normalizeTags(Array.from({ length: 30 }, (_, i) => `t${i}`)).length, 20)
})
t('单个标签截断到 24 字', () => {
  assert.equal(normalizeTags(['x'.repeat(50)])[0].length, 24)
})

console.log('\n【连续天数计算】')
t('今天写了 → 从今天数', () => {
  const r = computeStreak(['2026-09-24', '2026-09-23', '2026-09-22'], '2026-09-24')
  assert.equal(r.current, 3)
})
t('今天没写但昨天写了 → 不算断（从昨天数）', () => {
  const r = computeStreak(['2026-09-23', '2026-09-22'], '2026-09-24')
  assert.equal(r.current, 2)
})
t('昨天也没写 → 归零', () => {
  const r = computeStreak(['2026-09-20'], '2026-09-24')
  assert.equal(r.current, 0)
})
t('跨月连续', () => {
  const r = computeStreak(['2026-10-01', '2026-09-30', '2026-09-29'], '2026-10-01')
  assert.equal(r.current, 3)
})
t('没有任何记录 → 0', () => {
  assert.equal(computeStreak([], '2026-09-24').current, 0)
})

console.log('\n【frontmatter 与正文块数不一致（手改文件的真实场景）】')

// 场景 A：正文有 2 块，frontmatter 只有 1 块元数据 → 缺的那块要能补默认值，不能丢
await ta('正文 2 块 / 元数据 1 块 → 不丢内容，缺的补默认分类', async () => {
  await writeFile(file, `---
date: '${D}'
blocks:
  - id: keep1
    category: memory
    tags:
      - 甲
    order: 0
---

## 第一块

内容一

## 第二块

内容二（没有元数据，手改场景）
`, 'utf8')
  const day = await readDay(D)
  assert.equal(day.blocks.length, 2, `块数应为 2，实际 ${day.blocks.length}`)
  assert.equal(day.blocks[0].category, 'memory')
  assert.equal(day.blocks[0].tags[0], '甲')
  assert.equal(day.blocks[1].category, 'writing', '缺元数据的块应回退到默认分类 writing')
  assert.match(day.blocks[1].content, /内容二/)
})

// 场景 B：元数据 3 块，正文只有 1 块 → 幽灵块必须被丢弃（否则前端显示空块）
await ta('元数据 3 块 / 正文 1 块 → 不产生幽灵空块', async () => {
  await writeFile(file, `---
date: '${D}'
blocks:
  - id: a1
    category: memory
    tags: []
    order: 0
  - id: a2
    category: memory
    tags: []
    order: 1
  - id: a3
    category: writing
    tags: []
    order: 2
---

## 唯一一块

只有这块有正文
`, 'utf8')
  const day = await readDay(D)
  assert.equal(day.blocks.length, 1, `块数应为 1，实际 ${day.blocks.length}`)
  assert.equal(day.blocks[0].title, '唯一一块')
})

// 场景 C：完全没有 frontmatter（用户拿编辑器新建了个空 md 丢进来）
await ta('无 frontmatter → 不抛错，正文仍可读', async () => {
  await writeFile(file, `## 手写的块

没有任何 frontmatter
`, 'utf8')
  const day = await readDay(D)
  assert.equal(day.blocks.length, 1)
  assert.equal(day.blocks[0].category, 'writing')
  assert.match(day.blocks[0].content, /没有任何 frontmatter/)
})

// 场景 D：第一个 ## 之前有前言 → 不能丢
await ta('正文前言（## 之前的内容）→ 归入首块而非被丢弃', async () => {
  await writeFile(file, `---
date: '${D}'
blocks: []
---

这是没写标题的前言内容。

## 正式块

块内容
`, 'utf8')
  const day = await readDay(D)
  assert.equal(day.blocks.length, 2, `应为 2 块（前言 + 正式块），实际 ${day.blocks.length}`)
  assert.match(day.blocks[0].content, /没写标题的前言/)
})

// 场景 E：frontmatter 语法错误 → 必须明确报错，不能静默返回空
await ta('frontmatter 语法错误 → 抛出可读错误而非静默丢数据', async () => {
  await writeFile(file, `---
date: '${D}'
blocks: [ 这不是合法 YAML
---

## 块

内容
`, 'utf8')
  await assert.rejects(
    () => readDay(D),
    (err) => {
      assert.ok(/frontmatter|YAML|解析/.test(err.message), `错误信息应说明是 frontmatter 问题，实际：${err.message}`)
      return true
    },
  )
})

console.log('\n【写入幂等与往返保真】')
await ta('读写往返：标题/分类/标签/正文完全保真', async () => {
  const input = [
    { id: 'r1', title: '往返测试 A', category: 'memory', tags: ['标签一', 'b'], content: '正文 **加粗**\n\n```js\nconst y = 2\n```' },
    { id: 'r2', title: '', category: 'writing', tags: [], content: '没有标题的块' },
  ]
  await writeDay(D, input)
  const out = (await readDay(D)).blocks
  assert.equal(out.length, 2)
  assert.equal(out[0].title, '往返测试 A')
  assert.deepEqual(out[0].tags, ['标签一', 'b'])
  assert.match(out[0].content, /const y = 2/)
  assert.equal(out[1].title, '', '无标题块不应被塞入假标题')
  assert.match(out[1].content, /没有标题的块/)
})

await ta('二次写入不残留旧内容（无重复累积）', async () => {
  await writeDay(D, [{ id: 'x1', title: '新的', category: 'writing', tags: [], content: '全新的内容' }])
  const raw = await readFile(file, 'utf8')
  assert.ok(!raw.includes('往返测试 A'), '旧内容不应残留')
  assert.ok(!raw.includes('没有标题的块'), '旧内容不应残留')
  const out = (await readDay(D)).blocks
  assert.equal(out.length, 1)
})

await ta('空块列表 → 产出合法文件且可再读回', async () => {
  await writeDay(D, [])
  const out = await readDay(D)
  assert.equal(out.blocks.length, 0)
  assert.equal(out.exists, true)
})

console.log('\n【无标题块的分隔标记（曾经的丢块 bug）】')
await ta('无标题块用 <!--block--> 标记分隔，不被并进上一块', async () => {
  await writeDay(D, [
    { id: 'm1', title: '有标题', category: 'writing', tags: [], content: '第一块正文' },
    { id: 'm2', title: '', category: 'writing', tags: [], content: '第二块没有标题' },
  ])
  const raw = await readFile(file, 'utf8')
  assert.ok(raw.includes('<!--block-->'), '应写入不可见分隔标记')
  const out = (await readDay(D)).blocks
  assert.equal(out.length, 2, `应为 2 块，实际 ${out.length}`)
  assert.equal(out[1].title, '')
  assert.match(out[1].content, /第二块没有标题/)
})

await ta('标记本身不会污染块内容', async () => {
  const out = (await readDay(D)).blocks
  assert.ok(!out[1].content.includes('<!--block-->'), '标记不应出现在正文里')
})

await ta('手写文件（只有 ## 标题、无标记）→ 内容并入上一块（已知取舍，明示而非静默）', async () => {
  // 这是格式的固有边界：没有分隔符就无法确定边界。用户的 App 写入时一定有标记，
  // 只有"纯手工编辑且不给新块加 ## 标题"才会遇到，此时并入上一块是唯一合理解释。
  await writeFile(file, `---
date: '${D}'
blocks: []
---

## 唯一标题

标题块正文

这段是手写的、没有分隔符的尾随内容
`, 'utf8')
  const out = (await readDay(D)).blocks
  assert.equal(out.length, 1, '应合并为 1 块')
  assert.match(out[0].content, /尾随内容/, '内容不能丢，只是归属到上一块')
})

// 清理
await rm(file, { force: true })
console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`)
process.exit(fail ? 1 : 0)
