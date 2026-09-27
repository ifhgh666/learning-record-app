<script setup>
/**
 * AI 对话页：仿 DeepSeek 的聊天界面。
 *
 * 三条设计要点：
 *  1. **API Key 只在服务端**。这个页面会把「未配置」的状态显示出来并引导去填，
 *     但输入框里填的 Key 通过 PUT /api/ai/config 交给后端落盘到 data/ai.json，
 *     浏览器本地不保存 Key（localStorage 同源脚本都能读，不适合放密钥）。
 *  2. **对话存成 Markdown 文件**。每次 AI 回复结束就整体写回
 *     data/chat/<id>.md，可 grep、可用编辑器打开、会被 git 备份。
 *  3. **流式显示**：边收边渲染，不用干等。
 */
import { ref, computed, nextTick, onMounted } from 'vue'
import { api, formatHuman } from '../api.js'

const chats = ref([])
const currentId = ref('')
const messages = ref([])   // { role: 'user'|'assistant', content: string }
const input = ref('')
const sending = ref(false)
const error = ref('')
const status = ref(null)   // { configured, keyHint, model, ... }

const showSettings = ref(false)
const keyDraft = ref('')
const modelDraft = ref('deepseek-chat')
const savingConfig = ref(false)
const configNote = ref('')

const scrollBox = ref(null)
const streamText = ref('')

const configured = computed(() => Boolean(status.value?.configured))
const currentChat = computed(() => chats.value.find((c) => c.id === currentId.value) ?? null)

/** 新对话的标题：取第一条用户消息的前 30 字。 */
function deriveTitle() {
  const first = messages.value.find((m) => m.role === 'user')
  return (first?.content ?? '新对话').replace(/\s+/g, ' ').trim().slice(0, 30) || '新对话'
}

function newChatId() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  const stamp = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`
  return `${stamp}-${Math.random().toString(36).slice(2, 6)}`
}

async function loadStatus() {
  try {
    status.value = await api.aiStatus()
    modelDraft.value = status.value.model || 'deepseek-chat'
  } catch (err) {
    error.value = `读取 AI 配置失败：${err.message}`
  }
}

async function loadChats() {
  try {
    const r = await api.aiChats()
    chats.value = r.chats ?? []
  } catch (err) {
    error.value = `读取对话列表失败：${err.message}`
  }
}

async function openChat(id) {
  if (sending.value) return
  try {
    const c = await api.aiChat(id)
    currentId.value = c.id
    messages.value = c.messages
    await scrollToBottom()
  } catch (err) {
    error.value = `打开对话失败：${err.message}`
  }
}

function startNew() {
  if (sending.value) return
  currentId.value = ''
  messages.value = []
  input.value = ''
  error.value = ''
}

async function removeChat(id) {
  if (!window.confirm('删除这段对话？文件会从 data/chat/ 移除（git 历史里仍可找回）。')) return
  try {
    await api.aiDeleteChat(id)
    chats.value = chats.value.filter((c) => c.id !== id)
    if (currentId.value === id) startNew()
  } catch (err) {
    error.value = `删除失败：${err.message}`
  }
}

async function scrollToBottom() {
  await nextTick()
  const el = scrollBox.value
  if (el) el.scrollTop = el.scrollHeight
}

async function send() {
  const text = input.value.trim()
  if (!text || sending.value) return
  if (!configured.value) {
    error.value = '还没有配置 DeepSeek API Key，点右上角「设置」填一下。'
    showSettings.value = true
    return
  }
  error.value = ''
  input.value = ''
  messages.value.push({ role: 'user', content: text })
  const reply = { role: 'assistant', content: '' }
  messages.value.push(reply)
  await scrollToBottom()

  sending.value = true
  streamText.value = ''
  const controller = new AbortController()
  try {
    const payload = messages.value
      .filter((m) => m.content.trim())
      .map((m) => ({ role: m.role, content: m.content }))
    await api.aiStreamChat(
      payload,
      (delta) => {
        reply.content += delta
        streamText.value = reply.content
        void scrollToBottom()
      },
      controller.signal,
    )
    if (!reply.content.trim()) {
      reply.content = '（模型没有返回内容，请再试一次）'
    }
    await persist()
  } catch (err) {
    error.value = `发送失败：${err.message}`
    // 失败时把最后一条空回复去掉，避免留下一个空气泡
    if (!reply.content.trim()) messages.value.pop()
  } finally {
    sending.value = false
    streamText.value = ''
    await scrollToBottom()
  }
}

/** 把当前对话整体写回文件（首次会生成 id）。 */
async function persist() {
  if (!messages.value.some((m) => m.content.trim())) return
  const id = currentId.value || newChatId()
  const payload = {
    title: deriveTitle(),
    model: status.value?.model || 'deepseek-chat',
    createdAt: currentChat.value?.updatedAt ?? new Date().toISOString(),
    messages: messages.value.filter((m) => m.content.trim()),
  }
  const saved = await api.aiSaveChat(id, payload)
  currentId.value = saved.id
  await loadChats()
}

async function saveConfig() {
  savingConfig.value = true
  configNote.value = ''
  try {
    status.value = await api.saveAiConfig({ apiKey: keyDraft.value, model: modelDraft.value })
    keyDraft.value = ''
    configNote.value = status.value.configured ? '已保存，可以开始对话了' : '已清除 API Key'
  } catch (err) {
    configNote.value = `保存失败：${err.message}`
  } finally {
    savingConfig.value = false
  }
}

/** 输入框回车发送，Shift+回车换行（聊天框的通用习惯）。 */
function onKeydown(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    void send()
  }
}

function formatTime(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return `${formatHuman(iso.slice(0, 10))} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

onMounted(async () => {
  await loadStatus()
  await loadChats()
})
</script>

<template>
  <section class="chat">
    <!-- 左：对话列表 -->
    <aside class="chat-list">
      <button type="button" class="btn btn-primary new-btn" :disabled="sending" @click="startNew">
        ＋ 新对话
      </button>
      <ul>
        <li v-for="c in chats" :key="c.id">
          <button
            type="button"
            class="chat-item"
            :class="{ 'chat-item-on': c.id === currentId }"
            @click="openChat(c.id)"
          >
            <span class="chat-item-title">{{ c.title }}</span>
            <span class="tiny muted">{{ formatTime(c.updatedAt) }}</span>
          </button>
          <button type="button" class="chat-del" title="删除" @click="removeChat(c.id)">×</button>
        </li>
      </ul>
      <p v-if="!chats.length" class="tiny muted empty-hint">还没有对话。点「新对话」开始。</p>
    </aside>

    <!-- 右：消息区 -->
    <div class="chat-main">
      <header class="chat-head">
        <div>
          <h2>{{ currentChat?.title ?? '新对话' }}</h2>
          <p class="tiny muted">
            {{ configured ? `模型 ${status.model}` : '未配置 API Key' }}
            · 对话保存在 data/chat/，可随时用编辑器打开
          </p>
        </div>
        <div class="head-ops">
          <span v-if="configured" class="pill" :title="`来源：${status.source}`">{{ status.keyHint }}</span>
          <button type="button" class="btn" @click="showSettings = !showSettings">
            {{ showSettings ? '收起设置' : '设置' }}
          </button>
        </div>
      </header>

      <!-- 设置面板 -->
      <div v-if="showSettings" class="card settings">
        <div class="notice" style="margin-bottom:12px">
          API Key <strong>只保存在你本机</strong>（<code>data/ai.json</code>，已加入 .gitignore，不会进 git）。
          浏览器不保存 Key，所有请求由本机服务转发。
        </div>
        <label class="form-row">
          <span class="form-label">API Key</span>
          <input
            v-model="keyDraft"
            class="field"
            type="password"
            autocomplete="off"
            :placeholder="configured ? `已配置（${status.keyHint}），留空则不改动` : 'sk-...'"
          />
        </label>
        <label class="form-row">
          <span class="form-label">模型</span>
          <input v-model="modelDraft" class="field" type="text" placeholder="deepseek-chat" />
        </label>
        <div class="form-actions">
          <button type="button" class="btn btn-primary" :disabled="savingConfig" @click="saveConfig">
            {{ savingConfig ? '保存中…' : '保存' }}
          </button>
          <span v-if="configNote" class="small muted">{{ configNote }}</span>
          <a class="tiny muted" style="margin-left:auto" href="https://platform.deepseek.com/api_keys" target="_blank" rel="noreferrer">
            去 DeepSeek 申请 Key →
          </a>
        </div>
      </div>

      <div v-if="error" class="notice notice-error">{{ error }}</div>

      <!-- 消息流 -->
      <div ref="scrollBox" class="chat-scroll">
        <div v-if="!messages.length" class="empty card chat-empty">
          <p style="margin:0 0 6px">问点什么吧。</p>
          <p class="tiny muted" style="margin:0">
            {{ configured ? '回车发送，Shift+回车换行。' : '先在右上角「设置」里填 DeepSeek API Key。' }}
          </p>
        </div>

        <div
          v-for="(m, i) in messages"
          :key="i"
          class="msg"
          :class="m.role === 'user' ? 'msg-user' : 'msg-ai'"
        >
          <div class="msg-role tiny">{{ m.role === 'user' ? '我' : 'AI' }}</div>
          <div class="msg-body">
            <span v-if="m.content">{{ m.content }}</span>
            <span v-else-if="sending && i === messages.length - 1" class="typing">正在思考…</span>
          </div>
        </div>
      </div>

      <!-- 输入区 -->
      <div class="composer">
        <textarea
          v-model="input"
          class="composer-input"
          rows="3"
          :placeholder="configured ? '输入问题，回车发送（Shift+回车换行）' : '请先配置 API Key'"
          :disabled="sending"
          @keydown="onKeydown"
        />
        <div class="composer-foot">
          <span class="tiny muted">{{ sending ? '正在接收回复…' : '' }}</span>
          <button type="button" class="btn" :disabled="sending || !input.trim()" @click="send">
            {{ sending ? '发送中…' : '发送' }}
          </button>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.chat {
  display: grid;
  grid-template-columns: 216px minmax(0, 1fr);
  gap: 16px;
  height: calc(100vh - 40px);
  min-height: 460px;
}

/* 左：对话列表 */
.chat-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
  border-right: 1px solid var(--line);
  padding-right: 12px;
  overflow-y: auto;
}
.new-btn { width: 100%; }
.chat-list ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
.chat-list li { display: flex; align-items: center; gap: 2px; }
.chat-item {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
  border: none;
  background: transparent;
  border-radius: 6px;
  padding: 7px 9px;
  cursor: pointer;
  text-align: left;
}
.chat-item:hover { background: var(--surface-2); }
.chat-item-on { background: var(--accent-soft); }
.chat-item-title {
  font-size: 13.5px;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.chat-item-on .chat-item-title { color: var(--accent-strong); font-weight: 600; }
.chat-del {
  flex: none;
  border: none;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  font-size: 15px;
  line-height: 1;
  padding: 2px 5px;
  border-radius: 5px;
  opacity: 0;
}
.chat-list li:hover .chat-del { opacity: 1; }
.chat-del:hover { background: #fef3f2; color: var(--danger); }
.empty-hint { padding: 4px 2px; line-height: 1.6; }

/* 右：消息区 */
.chat-main { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.chat-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  padding-bottom: 10px;
  border-bottom: 1px solid var(--line);
}
.chat-head h2 { font-size: 17px; margin: 0; }
.chat-head p { margin: 2px 0 0; }
.head-ops { display: flex; align-items: center; gap: 8px; }

.settings { padding: 14px 16px; }
.form-row { display: flex; gap: 12px; align-items: center; margin-bottom: 10px; }
.form-label { flex: none; width: 68px; font-size: 13px; color: var(--muted); }
.form-actions { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }

.chat-scroll {
  flex: 1;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 4px 2px;
  min-height: 0;
}
.chat-empty { padding: 30px 20px; text-align: center; }

.msg { display: flex; gap: 10px; align-items: flex-start; }
.msg-role {
  flex: none;
  width: 26px;
  padding-top: 2px;
  color: var(--muted);
  text-align: right;
}
.msg-body {
  flex: 1;
  min-width: 0;
  font-size: 14.5px;
  line-height: 1.75;
  white-space: pre-wrap;   /* 保留模型输出的换行 */
  overflow-wrap: anywhere;
}
.msg-user .msg-body {
  background: var(--surface-2);
  border-radius: 8px;
  padding: 8px 12px;
}
.typing { color: var(--muted); }

.composer { display: flex; flex-direction: column; gap: 8px; }
.composer-input {
  width: 100%;
  border: 1px solid var(--line);
  border-radius: 10px;
  padding: 10px 12px;
  font-family: inherit;
  font-size: 14.5px;
  line-height: 1.6;
  resize: vertical;
  outline: none;
  background: var(--surface);
}
.composer-input:focus { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
.composer-foot { display: flex; align-items: center; justify-content: space-between; gap: 10px; }

@media (max-width: 900px) {
  .chat { grid-template-columns: minmax(0, 1fr); height: auto; }
  .chat-list { border-right: none; border-bottom: 1px solid var(--line); padding: 0 0 10px; max-height: 180px; }
  .chat-scroll { max-height: 50vh; }
}
</style>
