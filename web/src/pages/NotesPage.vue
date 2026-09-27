<script setup>
/**
 * 页面二：学习记录。
 *
 * 核心行为决策：自动保存 + 手动兜底。
 *  - 改动后 1.5 秒静默保存；切日期时立刻 flush，绝不丢字。
 *  - 保存状态永远可见（保存中/已保存 HH:MM/保存失败+原因），
 *    因为"我写了半天到底存没存"是这类工具最不能含糊的事。
 */
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue'
import BlockCard from '../components/BlockCard.vue'
import { api, todayLocal, formatHuman, weekdayOf } from '../api.js'

const props = defineProps({ params: { type: Object, default: () => ({}) } })
const emit = defineEmits(['navigate'])

const today = todayLocal()
const date = ref(/^\d{4}-\d{2}-\d{2}$/.test(props.params.date ?? '') ? props.params.date : today)
const blocks = ref([])
const loading = ref(true)
const loadError = ref('')

/** idle | dirty | saving | saved | error */
const saveState = ref('idle')
const savedAt = ref('')
const saveError = ref('')
const gitNote = ref('')

const isToday = computed(() => date.value === today)
const isFuture = computed(() => date.value > today)
const isEmpty = computed(() => blocks.value.length === 0)

let timer = null
let inflight = null

function scheduleSave() {
  saveState.value = 'dirty'
  clearTimeout(timer)
  timer = setTimeout(() => { void save() }, 1500)
}

async function save() {
  clearTimeout(timer)
  if (inflight) { await inflight.catch(() => {}) }
  saveState.value = 'saving'
  saveError.value = ''
  const payload = JSON.parse(JSON.stringify(blocks.value))
  const target = date.value
  inflight = api.saveDay(target, payload)
  try {
    const saved = await inflight
    if (target !== date.value) return // 保存期间已切到别的日期，不要覆盖界面状态
    blocks.value = saved.blocks
    savedAt.value = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
    saveState.value = 'saved'
    gitNote.value = saved.git?.committed ? '已提交 git' : saved.git?.reason === 'not-a-git-repo' ? '' : '内容无变化'
  } catch (err) {
    saveState.value = 'error'
    saveError.value = err.message
  } finally {
    inflight = null
  }
}

async function load() {
  loading.value = true
  loadError.value = ''
  try {
    const day = await api.day(date.value)
    blocks.value = day.blocks
    saveState.value = 'idle'
    savedAt.value = day.updatedAt ? new Date(day.updatedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : ''
  } catch (err) {
    loadError.value = err.message
  } finally {
    loading.value = false
  }
}

function shiftDate(delta) {
  const d = new Date(`${date.value}T00:00:00`)
  d.setDate(d.getDate() + delta)
  void switchTo(d.toISOString().slice(0, 10))
}

async function switchTo(next) {
  if (next === date.value) return
  if (saveState.value === 'dirty' || saveState.value === 'saving') await save()
  date.value = next
  emit('navigate', 'notes', { date: next })
  await nextTick()
  await load()
}

function addBlock(category = 'writing') {
  blocks.value.push({
    id: `b${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`,
    title: '',
    category,
    tags: [],
    content: '',
  })
  scheduleSave()
}

function updateBlock(index, next) {
  blocks.value[index] = next
  scheduleSave()
}

function removeBlock(index) {
  const target = blocks.value[index]
  const hasContent = target.title.trim() || target.content.trim()
  if (hasContent && !window.confirm('这块有内容，确定删除吗？（删掉后仍可从 git 历史找回）')) return
  blocks.value.splice(index, 1)
  scheduleSave()
}

function moveBlock(index, delta) {
  const to = index + delta
  if (to < 0 || to >= blocks.value.length) return
  const [item] = blocks.value.splice(index, 1)
  blocks.value.splice(to, 0, item)
  scheduleSave()
}

/** 关闭页面前把未保存的内容落盘（浏览器只给同步时机，用 sendBeacon 最稳） */
function flushOnLeave() {
  if (saveState.value !== 'dirty' && saveState.value !== 'saving') return
  const payload = JSON.stringify({ blocks: blocks.value })
  navigator.sendBeacon?.(`/api/day/${date.value}`, new Blob([payload], { type: 'application/json' }))
}

onMounted(() => {
  void load()
  window.addEventListener('beforeunload', flushOnLeave)
})
onBeforeUnmount(() => {
  window.removeEventListener('beforeunload', flushOnLeave)
  clearTimeout(timer)
})

watch(() => props.params.date, (next) => {
  if (next && /^\d{4}-\d{2}-\d{2}$/.test(next) && next !== date.value) void switchTo(next)
})
</script>

<template>
  <section class="notes">
    <header class="day-bar">
      <button type="button" class="btn btn-ghost" title="前一天" @click="shiftDate(-1)">←</button>
      <div class="day-title">
        <h2>{{ isToday ? '今天' : formatHuman(date) }}</h2>
        <p class="small muted">
          {{ formatHuman(date) }} · {{ weekdayOf(date) }}
          <span v-if="isToday" class="pill" style="margin-left:6px">今天</span>
        </p>
      </div>
      <input
        class="field date-field"
        type="date"
        :value="date"
        :max="today"
        @change="switchTo($event.target.value)"
      />
      <button type="button" class="btn btn-ghost" title="后一天" :disabled="isToday || isFuture" @click="shiftDate(1)">→</button>

      <div class="save-box">
        <span v-if="saveState === 'saving'" class="small muted">保存中…</span>
        <span v-else-if="saveState === 'dirty'" class="small" style="color:#8a5a00">未保存…</span>
        <span v-else-if="saveState === 'error'" class="small" :title="saveError" style="color:var(--danger)">保存失败</span>
        <span v-else-if="savedAt" class="small muted">已保存 {{ savedAt }}<template v-if="gitNote"> · {{ gitNote }}</template></span>
        <span v-else class="small muted">尚无内容</span>
        <button type="button" class="btn btn-primary" :disabled="saveState === 'saving'" @click="save">保存</button>
      </div>
    </header>

    <div v-if="saveState === 'error'" class="notice notice-error" style="margin-bottom:12px">
      保存失败：{{ saveError }} —— 内容还在页面上，请先别关窗口，把这段报错发给我。
    </div>
    <div v-if="loadError" class="notice notice-error" style="margin-bottom:12px">
      读取失败：{{ loadError }}
    </div>

    <div v-if="loading" class="empty">加载中…</div>

    <template v-else>
      <div v-if="isEmpty" class="empty card start-card">
        <p style="margin:0 0 6px">这一天还没有记录。</p>
        <p class="small muted" style="margin:0 0 16px">按「学到的一个点」分块：需要背下来的选记忆类，想清楚了的选纯写类。</p>
        <div class="start-actions">
          <button type="button" class="btn btn-primary" @click="addBlock('memory')">＋ 加一块记忆类</button>
          <button type="button" class="btn" @click="addBlock('writing')">＋ 加一块纯写类</button>
        </div>
      </div>

      <div v-else class="block-list">
        <BlockCard
          v-for="(block, index) in blocks"
          :key="block.id"
          :block="block"
          :index="index"
          :total="blocks.length"
          @update="updateBlock(index, $event)"
          @remove="removeBlock"
          @move="moveBlock"
        />
      </div>

      <div v-if="!isEmpty" class="add-bar">
        <button type="button" class="btn" @click="addBlock('memory')">＋ 记忆类</button>
        <button type="button" class="btn" @click="addBlock('writing')">＋ 纯写类</button>
        <span class="tiny muted" style="margin-left:auto">
          共 {{ blocks.length }} 块 · {{ blocks.reduce((n, b) => n + b.tags.length, 0) }} 个标签
        </span>
      </div>
    </template>
  </section>
</template>

<style scoped>
.notes { display: flex; flex-direction: column; gap: 14px; }

.day-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--line);
}
.day-title { flex: 1; min-width: 190px; }
.day-title h2 { font-size: 20px; }
.day-title p { margin: 2px 0 0; }
.date-field { width: 148px; flex: none; }
.save-box {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-left: auto;
}

.block-list { display: flex; flex-direction: column; gap: 14px; }

.add-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 0;
}

.start-card { padding: 34px 20px; }
.start-actions { display: flex; gap: 10px; justify-content: center; flex-wrap: wrap; }

@media (max-width: 720px) {
  .save-box { margin-left: 0; width: 100%; justify-content: space-between; }
}
</style>
