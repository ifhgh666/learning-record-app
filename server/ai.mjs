/**
 * AI 聊天：把对话存成 Markdown 文件，API Key 只留在后端。
 *
 * 设计取向（与整个项目一致）：
 *  - **文件是唯一真相来源**：一段对话一个 .md，带 frontmatter（标题/模型/时间），
 *    正文用 `## 我` / `## AI` 分隔消息。可以 grep、可以用编辑器打开、能被 git 备份。
 *    明确不用数据库——用户随时能拿走自己的聊天记录。
 *  - **Key 只在服务端**：浏览器从不接触 API Key，请求由后端代理转发。
 *    服务只绑 127.0.0.1，这层代理不是"多此一举"，而是避免把 Key 写进前端存储
 *    （localStorage 里的东西任何同源脚本都能读）。
 *  - **Key 不入库**：支持环境变量 DEEPSEEK_API_KEY，或 data/ai.json（已在 .gitignore）。
 *
 * 消息格式（data/chat/2026-09-24-1432-ab12.md）：
 *   ---
 *   title: 如何理解 self-attention
 *   model: deepseek-chat
 *   createdAt: '2026-09-24T14:32:10.000Z'
 *   updatedAt: '2026-09-24T14:35:02.000Z'
 *   ---
 *
 *   ## 我
 *
 *   帮我解释一下 self-attention
 *
 *   ## AI
 *
 *   ……
 */
import { readdir, readFile, writeFile, mkdir, rm, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { DATA_DIR } from './storage.mjs'

export const CHAT_DIR = path.join(DATA_DIR, 'chat')
const AI_CONFIG_FILE = path.join(DATA_DIR, 'ai.json')

/** DeepSeek 的 OpenAI 兼容端点。 */
const DEFAULT_BASE_URL = 'https://api.deepseek.com'
const DEFAULT_MODEL = 'deepseek-chat'

const ROLE_HEAD = { user: '## 我', assistant: '## AI' }
const HEAD_TO_ROLE = { '## 我': 'user', '## AI': 'assistant' }

/** 会话 id 必须是安全的时间戳式名字，防目录穿越。 */
function assertChatId(id) {
  if (typeof id !== 'string' || !/^\d{4}-\d{2}-\d{2}-\d{4}-[a-z0-9]{4}$/.test(id)) {
    const err = new Error(`会话 id 格式不对：${JSON.stringify(id)}`)
    err.status = 400
    throw err
  }
  return id
}

function chatFile(id) {
  return path.join(CHAT_DIR, `${assertChatId(id)}.md`)
}

export function newChatId(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  const stamp = `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}`
  return `${stamp}-${Math.random().toString(36).slice(2, 6)}`
}

/** 读取 AI 配置（Key 只在这里用，绝不出现在任何 API 响应里）。 */
export async function readAiConfig() {
  let fileCfg = {}
  if (existsSync(AI_CONFIG_FILE)) {
    try {
      fileCfg = JSON.parse(await readFile(AI_CONFIG_FILE, 'utf8'))
    } catch {
      fileCfg = {}
    }
  }
  const apiKey = process.env.DEEPSEEK_API_KEY || fileCfg.apiKey || ''
  return {
    apiKey: String(apiKey).trim(),
    baseUrl: String(process.env.DEEPSEEK_BASE_URL || fileCfg.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, ''),
    model: String(fileCfg.model || DEFAULT_MODEL),
    configFile: AI_CONFIG_FILE,
  }
}

/** 对外暴露的配置状态：只说有没有 Key，绝不回传 Key 本身。 */
export async function aiStatus() {
  const cfg = await readAiConfig()
  return {
    configured: Boolean(cfg.apiKey),
    // 只给后 4 位用于确认"填的是哪把钥匙"，不足以还原
    keyHint: cfg.apiKey ? `****${cfg.apiKey.slice(-4)}` : '',
    model: cfg.model,
    baseUrl: cfg.baseUrl,
    source: process.env.DEEPSEEK_API_KEY ? 'env' : cfg.apiKey ? 'file' : 'none',
    configFile: cfg.configFile,
  }
}

/** 写入本地配置文件（Key 落盘在 data/ai.json，已在 .gitignore 里）。 */
export async function saveAiConfig(patch) {
  await mkdir(DATA_DIR, { recursive: true })
  let current = {}
  if (existsSync(AI_CONFIG_FILE)) {
    try { current = JSON.parse(await readFile(AI_CONFIG_FILE, 'utf8')) } catch { current = {} }
  }
  const next = { ...current }
  if (typeof patch?.apiKey === 'string' && patch.apiKey.trim()) next.apiKey = patch.apiKey.trim()
  if (patch?.apiKey === '') delete next.apiKey
  if (typeof patch?.model === 'string' && patch.model.trim()) next.model = patch.model.trim()
  if (typeof patch?.baseUrl === 'string' && patch.baseUrl.trim()) next.baseUrl = patch.baseUrl.trim().replace(/\/+$/, '')
  await writeFile(AI_CONFIG_FILE, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  return aiStatus()
}

/* ---------------- 会话读写 ---------------- */

function splitMessages(body) {
  const lines = String(body ?? '').split('\n')
  const messages = []
  let current = null
  for (const line of lines) {
    const head = line.trim()
    if (HEAD_TO_ROLE[head]) {
      if (current) messages.push(current)
      current = { role: HEAD_TO_ROLE[head], content: [] }
      continue
    }
    if (current) current.content.push(line)
  }
  if (current) messages.push(current)
  return messages
    .map((m) => ({ role: m.role, content: m.content.join('\n').replace(/^\s+|\s+$/g, '') }))
    .filter((m) => m.content)
}

function serializeMessages(messages) {
  return messages
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && String(m.content ?? '').trim())
    .map((m) => `${ROLE_HEAD[m.role]}\n\n${String(m.content).replace(/\s+$/, '')}`)
    .join('\n\n')
}

/** 极简 YAML frontmatter 解析/序列化（只处理本项目用到的字符串字段）。 */
function parseFrontmatter(raw) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw)
  if (!m) return { data: {}, body: raw }
  const data = {}
  for (const line of m[1].split('\n')) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line.trim())
    if (!kv) continue
    let v = kv[2].trim()
    if (/^'.*'$/.test(v) || /^".*"$/.test(v)) v = v.slice(1, -1)
    data[kv[1]] = v
  }
  return { data, body: m[2] }
}

export async function readChat(id) {
  const file = chatFile(id)
  if (!existsSync(file)) {
    const err = new Error('这段对话不存在（可能已被删除）')
    err.status = 404
    throw err
  }
  const raw = await readFile(file, 'utf8')
  const { data, body } = parseFrontmatter(raw)
  const st = await stat(file)
  return {
    id,
    title: data.title || '未命名对话',
    model: data.model || DEFAULT_MODEL,
    createdAt: data.createdAt || st.birthtime.toISOString(),
    updatedAt: data.updatedAt || st.mtime.toISOString(),
    messages: splitMessages(body),
  }
}

export async function writeChat(id, { title, model, createdAt, messages }) {
  await mkdir(CHAT_DIR, { recursive: true })
  const now = new Date().toISOString()
  const fm = [
    '---',
    `title: ${JSON.stringify(String(title || '未命名对话').slice(0, 80))}`,
    `model: ${String(model || DEFAULT_MODEL)}`,
    `createdAt: '${createdAt || now}'`,
    `updatedAt: '${now}'`,
    '---',
    '',
  ].join('\n')
  const body = serializeMessages(messages)
  await writeFile(chatFile(id), `${fm}${body ? `${body}\n` : ''}`, 'utf8')
  return readChat(id)
}

export async function listChats() {
  if (!existsSync(CHAT_DIR)) return []
  const names = await readdir(CHAT_DIR)
  const out = []
  for (const name of names) {
    if (!/^\d{4}-\d{2}-\d{2}-\d{4}-[a-z0-9]{4}\.md$/.test(name)) continue
    const id = name.replace(/\.md$/, '')
    try {
      const raw = await readFile(path.join(CHAT_DIR, name), 'utf8')
      const { data } = parseFrontmatter(raw)
      const st = await stat(path.join(CHAT_DIR, name))
      out.push({
        id,
        title: data.title || '未命名对话',
        model: data.model || DEFAULT_MODEL,
        updatedAt: data.updatedAt || st.mtime.toISOString(),
      })
    } catch { /* 单个文件坏掉不影响列表 */ }
  }
  return out.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
}

export async function deleteChat(id) {
  await rm(chatFile(id), { force: true })
  return { deleted: true, id }
}

/* ---------------- 调用 DeepSeek ---------------- */

/**
 * 向 DeepSeek 发起对话补全。
 *
 * 用原生 fetch 而不是 SDK：少一个依赖，而且能直接把上游的**流式响应**
 * 原样转发给浏览器（SSE），前端可以逐字显示。
 *
 * @param {object} opts
 * @param {Array<{role:string, content:string}>} opts.messages
 * @param {boolean} opts.stream
 * @returns {Promise<Response>} 上游响应（未消费）
 */
export async function callDeepSeek({ messages, stream = false }) {
  const cfg = await readAiConfig()
  if (!cfg.apiKey) {
    const err = new Error('还没有配置 DeepSeek API Key。请到「AI 对话 → 设置」里填，或设置环境变量 DEEPSEEK_API_KEY。')
    err.status = 400
    throw err
  }
  const clean = messages
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && String(m.content ?? '').trim())
    .map((m) => ({ role: m.role, content: String(m.content) }))
  if (!clean.length) {
    const err = new Error('没有可发送的消息')
    err.status = 400
    throw err
  }

  const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify({
      model: cfg.model,
      messages: clean,
      stream,
      ...(stream ? {} : {}),
    }),
    signal: AbortSignal.timeout(120_000),
  })

  if (!res.ok) {
    // 把上游错误原文带出来——自己编错误信息会掩盖真实原因（如余额不足、模型名错）
    const text = await res.text().catch(() => '')
    const err = new Error(`DeepSeek 返回 ${res.status}：${text.slice(0, 400) || res.statusText}`)
    err.status = res.status === 401 ? 401 : 502
    throw err
  }
  return res
}
