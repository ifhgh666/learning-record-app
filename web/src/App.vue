<script setup>
/**
 * 应用外壳：三个页面的极简路由 + 顶部导航。
 *
 * 为什么不用 vue-router：本机单人工具只有 3 个页面，用 hash 手写路由
 * 省掉一个依赖，也不会出现 history 模式下刷新 404 的坑。
 */
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import RecommendPage from './pages/RecommendPage.vue'
import NotesPage from './pages/NotesPage.vue'
import ChatPage from './pages/ChatPage.vue'
import ProfilePage from './pages/ProfilePage.vue'
import { api, todayLocal } from './api.js'
import { wallpaper } from './wallpaper-state.js'

/**
 * 背景图：预览图（静态）。scene 型壁纸是 Wallpaper Engine 私有格式，
 * 浏览器本来就读不了；用户也明确不要动态背景。
 */
const bgImageUrl = computed(() => (wallpaper.id ? api.wallpaperAsset(wallpaper.id, 'preview') : ''))

/* ---------------- 右侧栏的问候与名言 ---------------- */

const nickname = ref('')
const quotes = ref([])
const quoteIndex = ref(0)

/** 按"当天"选一条，保证一天之内刷新不变（不随机跳，看着稳）。 */
function seedFromDate(dateStr) {
  let h = 0
  for (const ch of dateStr) h = (h * 31 + ch.charCodeAt(0)) % 100000
  return h
}

const currentQuote = computed(() => quotes.value[quoteIndex.value] ?? null)

/** 换一条（同一天内手动切换，循环）。 */
function nextQuote() {
  if (quotes.value.length > 1) {
    quoteIndex.value = (quoteIndex.value + 1) % quotes.value.length
  }
}

const greeting = computed(() => {
  const h = new Date().getHours()
  if (h < 5) return '夜深了'
  if (h < 11) return '早上好'
  if (h < 14) return '中午好'
  if (h < 18) return '下午好'
  if (h < 23) return '晚上好'
  return '夜深了'
})

async function loadSideContent() {
  try {
    const p = await api.profile()
    nickname.value = (p?.nickname ?? '').trim()
  } catch { /* 拿不到就用默认称呼，不影响使用 */ }
  try {
    const q = await api.quotes()
    quotes.value = q?.quotes ?? []
    if (quotes.value.length) {
      // 以日期做种子：同一天固定同一条
      quoteIndex.value = seedFromDate(todayLocal()) % quotes.value.length
    }
  } catch { /* 拿不到就隐藏名言块 */ }
}

const TABS = [
  { key: 'recommend', label: '今日推荐', icon: '📰', comp: RecommendPage },
  { key: 'notes', label: '学习记录', icon: '✍️', comp: NotesPage },
  { key: 'ai', label: 'AI 对话', icon: '💬', comp: ChatPage },
  { key: 'profile', label: '我的', icon: '👤', comp: ProfilePage },
]

function parseHash() {
  const key = window.location.hash.replace(/^#\/?/, '').split('?')[0]
  return TABS.some((t) => t.key === key) ? key : 'recommend'
}

const active = ref(parseHash())
/** 传给子页面的参数（如 #/notes?date=2026-09-24），用于"从历史跳到某天"。 */
const params = ref({})

function readHash() {
  const raw = window.location.hash.replace(/^#\/?/, '')
  const [key, qs] = raw.split('?')
  active.value = TABS.some((t) => t.key === key) ? key : 'recommend'
  params.value = Object.fromEntries(new URLSearchParams(qs ?? ''))
}

function go(key, query) {
  const qs = query ? `?${new URLSearchParams(query)}` : ''
  window.location.hash = `#/${key}${qs}`
}

// 换壁纸时无需额外同步（静态图直接用 :src 绑定即可）

onMounted(() => {
  if (!window.location.hash) window.location.hash = '#/recommend'
  readHash()
  window.addEventListener('hashchange', readHash)
  void loadSideContent()
})
onBeforeUnmount(() => window.removeEventListener('hashchange', readHash))
</script>

<template>
  <!-- 三栏：左侧导航（左上角）+ 中间页面内容 + 右侧壁纸 -->
  <div class="app-shell" :class="{ 'no-wallpaper': !wallpaper.id }">
    <!-- 左侧导航栏：模仿传统论坛/博客的左栏布局 -->
    <aside class="sidebar">
      <div class="brand">
        <span class="brand-mark">📓</span>
        <span class="brand-name">学习记录本</span>
        <span class="brand-tag">本机私有</span>
      </div>

      <nav class="nav" aria-label="页面导航">
        <button
          v-for="tab in TABS"
          :key="tab.key"
          type="button"
          class="nav-item"
          :class="{ 'nav-item-active': active === tab.key }"
          @click="go(tab.key)"
        >
          <span class="nav-icon">{{ tab.icon }}</span>
          <span class="nav-label">{{ tab.label }}</span>
        </button>
      </nav>

      <p class="sidebar-foot tiny muted">只在本机运行 · 数据存 data/</p>
    </aside>

    <div class="app">
      <main class="content">
        <!-- :key 让切页时重建组件，避免残留上一次的状态 -->
        <component :is="TABS.find((t) => t.key === active).comp" :key="active" :params="params" @navigate="go" />
      </main>
    </div>

    <!-- 右侧壁纸栏：只在选了壁纸时出现。三行：问候 / 壁纸 / 名言 -->
    <aside v-if="wallpaper.id" class="wallpaper-side">
      <div class="wallpaper-greet">
        <div class="greet-line">
          <span>{{ greeting }}，</span>
          <span class="greet-name">{{ nickname || 'if' }}</span>
        </div>
        <p class="greet-sub">今天也记一点吧</p>
      </div>

      <div class="wallpaper-frame">
        <img class="wallpaper-media" :src="bgImageUrl" alt="" />
      </div>

      <div v-if="currentQuote" class="wallpaper-quote">
        <p class="quote-body">{{ currentQuote.text }}</p>
        <p v-if="currentQuote.author" class="quote-author">{{ currentQuote.author }}</p>
        <div class="quote-foot">
          <span class="tiny muted">{{ quoteIndex + 1 }} / {{ quotes.length }}</span>
          <button v-if="quotes.length > 1" type="button" class="quote-next" @click="nextQuote">换一条 →</button>
        </div>
      </div>
    </aside>
  </div>
</template>

<style scoped>
.app {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  min-width: 0;
}

/* 左侧导航栏（左上角）：仿传统论坛/博客的左栏 */
.sidebar {
  position: sticky;
  top: 0;
  height: 100vh;
  display: flex;
  flex-direction: column;
  gap: 18px;
  padding: 18px 14px;
  border-right: 1px solid var(--line);
  background: var(--surface);
  overflow-y: auto;
}
.brand {
  display: flex;
  align-items: center;
  gap: 7px;
  flex-wrap: wrap;
}
.brand-mark { font-size: 17px; }
.brand-name { font-weight: 650; font-size: 15px; letter-spacing: 0.01em; }
.brand-tag {
  font-size: 11px;
  color: var(--muted);
  border: 1px solid var(--line);
  border-radius: 999px;
  padding: 1px 7px;
}

.nav { display: flex; flex-direction: column; gap: 2px; }
.nav-item {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  border: none;
  background: transparent;
  padding: 9px 10px;
  border-radius: 6px;
  font-size: 14.5px;
  color: var(--muted);
  cursor: pointer;
  text-align: left;
  transition: background 0.15s, color 0.15s;
}
.nav-item:hover { background: var(--surface-2); color: var(--text); }
.nav-item-active { background: var(--accent-soft); color: var(--accent-strong); font-weight: 600; }
.nav-icon { font-size: 15px; line-height: 1; }
.sidebar-foot { margin: auto 0 0; line-height: 1.5; }

.content {
  flex: 1;
  width: 100%;
  max-width: 1180px;
  margin: 0;
  text-align: left;
  padding: 20px 28px 80px 20px;
}

/* 中窄屏：导航变成顶部横向一条，不再占左栏 */
@media (max-width: 1180px) {
  .sidebar {
    position: static;
    height: auto;
    flex-direction: row;
    align-items: center;
    gap: 12px;
    padding: 10px 14px;
    border-right: none;
    border-bottom: 1px solid var(--line);
    overflow: visible;
  }
  .nav { flex-direction: row; flex: 1; }
  .nav-item { width: auto; padding: 6px 12px; }
  .sidebar-foot { display: none; }
}
@media (max-width: 720px) {
  .sidebar { flex-wrap: wrap; }
  .content { padding: 14px 14px 60px; }
}</style>
