/**
 * AI 对话端到端测试。
 *
 * 为什么需要：DeepSeek 需要真实 API Key 才能调用，但"流式解析是否正确、
 * 对话是否正确落成 Markdown、Key 是否会泄漏"这些逻辑必须验证，不能只看代码。
 * 办法是本地起一个**假的 OpenAI 兼容上游**，让真实服务指向它
 * （DEEPSEEK_BASE_URL 环境变量），从而跑通全链路而不花一分钱、不需要真 Key。
 *
 * 同时验证一个安全属性：/api/ai/status 的响应里绝不能出现 Key 本体。
 */
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { rm, readFile, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const APP_PORT = Number(process.env.AI_TEST_PORT ?? 3788)
const FAKE_PORT = Number(process.env.AI_FAKE_PORT ?? 3789)
const BASE = `http://127.0.0.1:${APP_PORT}`
const CHAT_DIR = path.join(ROOT, 'data', 'chat')
const AI_CONFIG = path.join(ROOT, 'data', 'ai.json')

const FAKE_KEY = 'sk-test-fake-key-1234567890abcd'
const REPLY = '注意力机制的核心是让每个位置都能看到其它位置。'

let pass = 0
let fail = 0
const t = async (name, fn) => {
  try {
    await fn()
    pass += 1
    console.log(`  ✓ ${name}`)
  } catch (err) {
    fail += 1
    console.log(`  ✗ ${name}\n      ${err.message}`)
  }
}

/* ---------- 1. 假的 DeepSeek 上游 ---------- */
let capturedAuth = ''
let capturedBody = null

const fake = createServer((req, res) => {
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', () => {
    capturedAuth = req.headers.authorization ?? ''
    try { capturedBody = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { capturedBody = null }

    if (!req.url.includes('/chat/completions')) {
      res.writeHead(404).end('not found')
      return
    }
    const wantStream = capturedBody?.stream === true
    if (!wantStream) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        model: 'deepseek-chat',
        choices: [{ message: { role: 'assistant', content: REPLY } }],
        usage: { prompt_tokens: 9, completion_tokens: 18 },
      }))
      return
    }
    // SSE：把回复拆成多段，模拟真实逐字输出
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
    const pieces = [REPLY.slice(0, 6), REPLY.slice(6, 14), REPLY.slice(14)]
    for (const p of pieces) {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: p } }] })}\n\n`)
    }
    res.write('data: [DONE]\n\n')
    res.end()
  })
})

await new Promise((resolve) => fake.listen(FAKE_PORT, '127.0.0.1', resolve))
console.log(`\nAI 对话端到端测试（假上游 :${FAKE_PORT} → 真实服务 :${APP_PORT}）\n`)

/* ---------- 2. 起真实服务，指向假上游 ---------- */
const server = spawn(process.execPath, ['server/index.mjs'], {
  cwd: ROOT,
  env: {
    ...process.env,
    PORT: String(APP_PORT),
    GIT_DISABLE_COMMIT: '1',           // 别让它往真实仓库提交测试对话
    DEEPSEEK_API_KEY: FAKE_KEY,
    DEEPSEEK_BASE_URL: `http://127.0.0.1:${FAKE_PORT}`,
  },
  stdio: 'ignore',
})

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitReady() {
  for (let i = 0; i < 40; i += 1) {
    try {
      const r = await fetch(`${BASE}/api/health`)
      if (r.ok) return
    } catch { /* 还没起来 */ }
    await sleep(250)
  }
  throw new Error('服务未就绪')
}

const createdChats = []

try {
  await waitReady()

  console.log('【安全：Key 不能泄漏给前端】')
  const st = await (await fetch(`${BASE}/api/ai/status`)).json()
  await t('status 报告已配置', () => assert.equal(st.configured, true))
  await t('status 里没有 Key 本体（只有后 4 位提示）', () => {
    const s = JSON.stringify(st)
    assert.ok(!s.includes(FAKE_KEY), '响应里出现了完整 Key！')
    assert.equal(st.keyHint, `****${FAKE_KEY.slice(-4)}`)
  })
  await t('status 报告来源为 env', () => assert.equal(st.source, 'env'))

  console.log('\n【非流式调用】')
  await t('非流式返回完整回复', async () => {
    const r = await fetch(`${BASE}/api/ai/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: '解释注意力机制' }], stream: false }),
    })
    assert.equal(r.status, 200)
    const j = await r.json()
    assert.equal(j.content, REPLY)
  })
  await t('上游收到的 Authorization 用了我们的 Key', () => {
    assert.equal(capturedAuth, `Bearer ${FAKE_KEY}`)
  })
  await t('上游收到的消息历史正确', () => {
    assert.equal(capturedBody.messages.length, 1)
    assert.equal(capturedBody.messages[0].role, 'user')
    assert.equal(capturedBody.model, 'deepseek-chat')
  })

  console.log('\n【流式调用（SSE 透传 + 前端解析）】')
  const res = await fetch(`${BASE}/api/ai/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: '解释注意力机制' }], stream: true }),
  })
  await t('流式响应状态 200 且 Content-Type 是 SSE', () => {
    assert.equal(res.status, 200)
    assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/)
  })

  // 用与前端完全相同的解析逻辑消费这个流
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let full = ''
  let deltas = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('data:')) continue
      const payload = trimmed.slice(5).trim()
      if (payload === '[DONE]') continue
      try {
        const json = JSON.parse(payload)
        const d = json?.choices?.[0]?.delta?.content
        if (d) { full += d; deltas += 1 }
      } catch { /* 忽略 */ }
    }
  }
  await t('流式分多段到达（确实是流式，不是一次性）', () => assert.ok(deltas >= 2, `只收到 ${deltas} 段`))
  await t('分段拼接后与完整回复一致', () => assert.equal(full, REPLY))

  console.log('\n【对话落盘为 Markdown】')
  const chatId = '2026-09-24-2100-test'
  const put = await fetch(`${BASE}/api/ai/chat/${chatId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: '注意力机制是什么',
      model: 'deepseek-chat',
      messages: [
        { role: 'user', content: '解释注意力机制' },
        { role: 'assistant', content: REPLY },
      ],
    }),
  })
  await t('保存对话返回 200', () => assert.equal(put.status, 200))
  createdChats.push(chatId)

  const file = path.join(CHAT_DIR, `${chatId}.md`)
  await t('生成了 .md 文件', () => assert.ok(existsSync(file), `文件不存在：${file}`))
  const raw = await readFile(file, 'utf8')
  await t('frontmatter 含 title/model/时间', () => {
    assert.match(raw, /title: "注意力机制是什么"/)
    assert.match(raw, /model: deepseek-chat/)
    assert.match(raw, /createdAt:/)
    assert.match(raw, /updatedAt:/)
  })
  await t('消息用 ## 我 / ## AI 分隔，人能直接读', () => {
    assert.match(raw, /## 我\n\n解释注意力机制/)
    assert.match(raw, new RegExp(`## AI\\n\\n${REPLY}`))
  })

  await t('读回对话内容与写入一致', async () => {
    const c = await (await fetch(`${BASE}/api/ai/chat/${chatId}`)).json()
    assert.equal(c.title, '注意力机制是什么')
    assert.equal(c.messages.length, 2)
    assert.equal(c.messages[0].role, 'user')
    assert.equal(c.messages[1].content, REPLY)
  })
  await t('对话出现在列表里', async () => {
    const l = await (await fetch(`${BASE}/api/ai/chats`)).json()
    assert.ok(l.chats.some((c) => c.id === chatId))
  })
  await t('列表按更新时间倒序（最新的在前）', async () => {
    const l = await (await fetch(`${BASE}/api/ai/chats`)).json()
    const times = l.chats.map((c) => c.updatedAt)
    const sorted = [...times].sort().reverse()
    assert.deepEqual(times, sorted)
  })

  console.log('\n【非法输入与边界】')
  await t('路径穿越的会话 id 被拒绝', async () => {
    const r = await fetch(`${BASE}/api/ai/chat/..%2F..%2Fpasswd`)
    assert.ok(r.status >= 400, `实际 ${r.status}`)
  })
  await t('不存在的会话返回 404', async () => {
    const r = await fetch(`${BASE}/api/ai/chat/1999-01-01-0000-zzzz`)
    assert.equal(r.status, 404)
  })
  await t('空消息被拒绝', async () => {
    const r = await fetch(`${BASE}/api/ai/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [], stream: false }),
    })
    assert.equal(r.status, 400)
  })
  await t('删除对话后文件消失', async () => {
    const r = await fetch(`${BASE}/api/ai/chat/${chatId}`, { method: 'DELETE' })
    assert.equal(r.status, 200)
    assert.ok(!existsSync(file), '文件仍然存在')
  })
} catch (err) {
  fail += 1
  console.log(`\n✗ 执行中断：${err.message}`)
} finally {
  server.kill()
  await sleep(400)
  fake.close()
  // 清理测试产生的对话文件
  for (const id of createdChats) {
    await rm(path.join(CHAT_DIR, `${id}.md`), { force: true })
  }
  if (existsSync(CHAT_DIR)) {
    const rest = (await readdir(CHAT_DIR)).filter((f) => f.includes('test'))
    for (const f of rest) await rm(path.join(CHAT_DIR, f), { force: true })
  }
  // 如果 data/ai.json 是这次测试产生的，清掉（正常情况下它由用户手动配置）
  if (existsSync(AI_CONFIG)) {
    try {
      const cfg = JSON.parse(await readFile(AI_CONFIG, 'utf8'))
      if (cfg.apiKey === FAKE_KEY) await rm(AI_CONFIG, { force: true })
    } catch { /* 忽略 */ }
  }
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`)
process.exit(fail ? 1 : 0)
