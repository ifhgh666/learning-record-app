<script setup>
/**
 * 页面三：我的（档案 + 坚持情况）与 记录（标签/分类筛选 + 全文搜索）。
 *
 * 这两个子页面的内容在需求拷问里被明确指出要"拆开"：一页是身份感与坚持，
 * 一页是检索工具，混在一起会变成又长又杂的页面。
 */
import { ref, computed, onMounted, watch } from 'vue'
import { api, formatHuman, weekdayOf, CATEGORY_LABEL } from '../api.js'
import WallpaperPanel from '../components/WallpaperPanel.vue'

const props = defineProps({ params: { type: Object, default: () => ({}) } })
const emit = defineEmits(['navigate'])

/** 子 Tab：me（档案）/ history（检索）/ wallpaper（壁纸）。
 *  支持用 URL 参数直接打开某个子 Tab，例如 #/profile?tab=wallpaper
 *  （也让截图工具/书签能直达，不必模拟点击）。 */
const VALID_TABS = ['me', 'history', 'wallpaper']
const tab = ref(VALID_TABS.includes(props.params?.tab) ? props.params.tab : 'me')

/** 切子 Tab 时同步 URL，这样刷新/分享链接能回到同一个子 Tab。 */
function selectTab(next) {
  if (!VALID_TABS.includes(next) || next === tab.value) return
  tab.value = next
  emit('navigate', 'profile', { tab: next })
}

/* ---------------- 我的 ---------------- */
const profile = ref({ nickname: '', bio: '', startedAt: null })
const stats = ref({ today: '', streak: { current: 0, lastDate: null }, totalDays: 0, days: [] })
const profileSaving = ref(false)
const profileNote = ref('')
const error = ref('')

const nicknameDraft = ref('')
const bioDraft = ref('')

const week = computed(() => {
  // 本周一到今天的写作情况（用本地日期算，避免 UTC 偏移把周一算错）
  const out = []
  const now = new Date()
  const monday = new Date(now)
  const dow = (now.getDay() + 6) % 7
  monday.setDate(now.getDate() - dow)
  const has = new Set(stats.value.days.map((d) => d.date))
  for (let i = 0; i < 7; i += 1) {
    const d = new Date(monday)
    d.setDate(monday.getDate() + i)
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    out.push({ date: key, wrote: has.has(key), isFuture: key > stats.value.today, isToday: key === stats.value.today })
  }
  return out
})

const recentDays = computed(() => stats.value.days.slice(0, 12))

async function loadStats() {
  try {
    const d = await api.days()
    stats.value = d
    profile.value = d.profile ?? profile.value
    nicknameDraft.value = profile.value.nickname ?? ''
    bioDraft.value = profile.value.bio ?? ''
  } catch (err) {
    error.value = err.message
  }
}

async function saveProfile() {
  profileSaving.value = true
  profileNote.value = ''
  try {
    profile.value = await api.saveProfile({ nickname: nicknameDraft.value, bio: bioDraft.value })
    profileNote.value = '已保存'
    setTimeout(() => { profileNote.value = '' }, 2500)
  } catch (err) {
    profileNote.value = `保存失败：${err.message}`
  } finally {
    profileSaving.value = false
  }
}

/* ---------------- 记录（检索） ---------------- */
const filters = ref({ q: '', tag: '', category: '', from: '', to: '' })
const results = ref([])
const total = ref(0)
const searching = ref(false)
const searchError = ref('')
const tags = ref([])
const favorites = ref([])

async function runSearch() {
  searching.value = true
  searchError.value = ''
  try {
    const r = await api.search(filters.value)
    results.value = r.results
    total.value = r.total
  } catch (err) {
    searchError.value = err.message
  } finally {
    searching.value = false
  }
}

function setTag(tag) {
  filters.value.tag = filters.value.tag === tag ? '' : tag
}
function clearFilters() {
  filters.value = { q: '', tag: '', category: '', from: '', to: '' }
  void runSearch()
}
function openDay(date) {
  emit('navigate', 'notes', { date })
}

let debounce = null
watch(
  () => [filters.value.q, filters.value.from, filters.value.to],
  () => {
    clearTimeout(debounce)
    debounce = setTimeout(runSearch, 300)
  },
)

onMounted(async () => {
  await loadStats()
  try {
    const [t, h] = await Promise.all([api.tags(), api.recommendHistory()])
    tags.value = t.tags
    favorites.value = h.favorites
  } catch { /* 标签/收藏拿不到不影响主功能 */ }
  await runSearch()
})
</script>

<template>
  <section class="me">
    <div class="sub-tabs">
      <button type="button" class="tab" :class="{ 'tab-active': tab === 'me' }" @click="selectTab('me')">我的</button>
      <button type="button" class="tab" :class="{ 'tab-active': tab === 'history' }" @click="selectTab('history')">记录</button>
      <button type="button" class="tab" :class="{ 'tab-active': tab === 'wallpaper' }" @click="selectTab('wallpaper')">壁纸</button>
    </div>

    <div v-if="error" class="notice notice-error">加载失败：{{ error }}</div>

    <!-- ============ 我的 ============ -->
    <template v-if="tab === 'me'">
      <div class="stat-row">
        <div class="card stat">
          <div class="stat-num">{{ stats.streak.current }}</div>
          <div class="small muted">连续记录天数</div>
        </div>
        <div class="card stat">
          <div class="stat-num">{{ stats.totalDays }}</div>
          <div class="small muted">累计记录天数</div>
        </div>
        <div class="card stat">
          <div class="stat-num">{{ tags.length }}</div>
          <div class="small muted">用过的标签</div>
        </div>
      </div>

      <div class="card week-card">
        <h3 class="card-title">本周</h3>
        <div class="week-grid">
          <div
            v-for="d in week"
            :key="d.date"
            class="week-cell"
            :class="{ 'week-wrote': d.wrote, 'week-today': d.isToday, 'week-future': d.isFuture }"
            :title="d.date"
          >
            <span class="tiny">{{ weekdayOf(d.date).replace('周', '') }}</span>
            <span class="week-dot" />
          </div>
        </div>
        <p class="tiny muted" style="margin:12px 0 0">
          今天没写不算断——连续天数从今天或昨天往前数，避免你早上一打开就看到归零。
        </p>
      </div>

      <div class="card profile-card">
        <h3 class="card-title">档案</h3>
        <label class="form-row">
          <span class="form-label">昵称</span>
          <input v-model="nicknameDraft" class="field" type="text" maxlength="40" placeholder="怎么称呼你" />
        </label>
        <label class="form-row">
          <span class="form-label">简介</span>
          <textarea v-model="bioDraft" class="field" rows="3" maxlength="300" placeholder="一句话说明你在学什么" />
        </label>
        <div class="form-actions">
          <button type="button" class="btn btn-primary" :disabled="profileSaving" @click="saveProfile">
            {{ profileSaving ? '保存中…' : '保存' }}
          </button>
          <span v-if="profileNote" class="small muted">{{ profileNote }}</span>
          <span v-if="profile.startedAt" class="tiny muted" style="margin-left:auto">开始于 {{ formatHuman(profile.startedAt) }}</span>
        </div>
      </div>

      <div v-if="recentDays.length" class="card">
        <h3 class="card-title">最近记录</h3>
        <ul class="recent-list">
          <li v-for="d in recentDays" :key="d.date">
            <button type="button" class="link-btn" @click="openDay(d.date)">{{ formatHuman(d.date) }}</button>
            <span class="tiny muted">{{ d.blockCount }} 块</span>
            <span v-for="c in d.categories" :key="c" class="pill tiny" :class="`pill-${c}`">{{ CATEGORY_LABEL[c] }}</span>
            <span v-for="t in d.tags.slice(0, 4)" :key="t" class="tiny muted">#{{ t }}</span>
          </li>
        </ul>
      </div>

      <div v-if="favorites.length" class="card">
        <h3 class="card-title">收藏的仓库（{{ favorites.length }}）</h3>
        <ul class="recent-list">
          <li v-for="f in favorites" :key="f.fullName">
            <a :href="f.url" target="_blank" rel="noreferrer">{{ f.fullName }}</a>
            <span class="tiny muted">★{{ f.stars.toLocaleString() }}</span>
            <span class="tiny muted">收藏于 {{ f.date }}</span>
            <span v-if="f.mark === 'read'" class="pill tiny">已看完</span>
            <span v-else-if="f.mark === 'worth'" class="pill tiny">值得看</span>
          </li>
        </ul>
      </div>
    </template>

    <!-- ============ 壁纸 ============ -->
    <WallpaperPanel v-else-if="tab === 'wallpaper'" />

    <!-- ============ 记录（检索） ============ -->
    <template v-else>
      <div class="card search-card">
        <div class="search-row">
          <input
            v-model="filters.q"
            class="field"
            type="search"
            placeholder="搜内容 / 标题 / 标签，例如「attention」"
          />
          <select v-model="filters.category" class="field cat-select" @change="runSearch">
            <option value="">全部分类</option>
            <option v-for="(label, key) in CATEGORY_LABEL" :key="key" :value="key">{{ label }}</option>
          </select>
        </div>
        <div class="search-row">
          <label class="tiny muted">从 <input v-model="filters.from" class="field date-sm" type="date" /></label>
          <label class="tiny muted">到 <input v-model="filters.to" class="field date-sm" type="date" /></label>
          <button type="button" class="btn" @click="runSearch">搜索</button>
          <button type="button" class="btn btn-ghost" @click="clearFilters">清空</button>
        </div>
        <div v-if="tags.length" class="tag-cloud">
          <button
            v-for="t in tags"
            :key="t.name"
            type="button"
            class="tag-btn"
            :class="{ 'tag-btn-on': filters.tag === t.name }"
            @click="setTag(t.name); runSearch()"
          >
            #{{ t.name }} <span class="tiny">{{ t.count }}</span>
          </button>
        </div>
      </div>

      <p class="small muted" style="margin:0">
        <template v-if="searching">搜索中…</template>
        <template v-else>命中 {{ total }} 条{{ total > results.length ? `（只显示前 ${results.length} 条）` : '' }}</template>
      </p>

      <div v-if="searchError" class="notice notice-error">搜索失败：{{ searchError }}</div>

      <div v-if="!searching && !results.length" class="empty card">
        没有匹配的记录。换个关键词，或到「学习记录」里写今天的。
      </div>

      <article v-for="r in results" :key="`${r.date}-${r.id}`" class="card result">
        <header class="result-head">
          <button type="button" class="link-btn" @click="openDay(r.date)">{{ formatHuman(r.date) }}</button>
          <span class="pill tiny" :class="`pill-${r.category}`">{{ CATEGORY_LABEL[r.category] }}</span>
          <strong v-if="r.title" class="result-title">{{ r.title }}</strong>
          <span v-for="t in r.tags" :key="t" class="tiny muted">#{{ t }}</span>
        </header>
        <p class="result-excerpt">{{ r.excerpt }}</p>
      </article>
    </template>
  </section>
</template>

<style scoped>
.me { display: flex; flex-direction: column; gap: 14px; }

.sub-tabs { display: flex; gap: 4px; }
.tab {
  border: none;
  background: transparent;
  padding: 7px 16px;
  border-radius: 8px;
  font-size: 14px;
  color: var(--muted);
  cursor: pointer;
}
.tab:hover { background: var(--surface-2); color: var(--text); }
.tab-active { background: var(--accent-soft); color: var(--accent-strong); font-weight: 600; }

.stat-row { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }
.stat { padding: 16px 18px; }
.stat-num { font-size: 30px; font-weight: 680; line-height: 1.1; }

.week-card, .profile-card, .search-card { padding: 16px 18px; }
.card-title { font-size: 15px; margin: 0 0 12px; }
.week-grid { display: grid; grid-template-columns: repeat(7, 1fr); gap: 8px; }
.week-cell {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 8px 0;
  border-radius: 8px;
  background: var(--surface-2);
  color: var(--muted);
}
.week-dot { width: 9px; height: 9px; border-radius: 50%; background: #d3d8e0; }
.week-wrote { background: var(--accent-soft); color: var(--accent-strong); }
.week-wrote .week-dot { background: var(--accent); }
.week-today { outline: 2px solid var(--accent); outline-offset: -2px; }
.week-future { opacity: 0.45; }

.form-row { display: flex; gap: 12px; align-items: flex-start; margin-bottom: 10px; }
.form-label { flex: none; width: 44px; font-size: 13px; color: var(--muted); padding-top: 8px; }
.form-actions { display: flex; align-items: center; gap: 10px; }

.recent-list { list-style: none; margin: 0; padding: 0 0 4px; }
.recent-list li {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 0;
  border-top: 1px solid var(--line);
  flex-wrap: wrap;
}
.recent-list li:first-child { border-top: none; }

.link-btn {
  border: none;
  background: transparent;
  color: var(--accent);
  cursor: pointer;
  padding: 0;
  font-size: 14px;
  text-align: left;
}
.link-btn:hover { text-decoration: underline; }

.search-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-bottom: 10px; }
.cat-select { width: 128px; flex: none; }
.date-sm { width: 148px; display: inline-block; }
.tag-cloud { display: flex; flex-wrap: wrap; gap: 6px; padding-top: 6px; border-top: 1px solid var(--line); }
.tag-btn {
  border: 1px solid var(--line);
  background: var(--surface);
  border-radius: 999px;
  padding: 3px 10px;
  font-size: 12px;
  cursor: pointer;
  color: var(--muted);
}
.tag-btn:hover { background: var(--surface-2); }
.tag-btn-on { background: var(--accent); border-color: var(--accent); color: #fff; }
.tag-btn-on .tiny { color: rgba(255, 255, 255, 0.75); }

.result { padding: 12px 16px; }
.result-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 4px; }
.result-title { font-size: 15px; }
.result-excerpt { margin: 0; font-size: 13.5px; color: #4b5260; }

@media (max-width: 720px) {
  .stat-row { grid-template-columns: 1fr; }
  .form-row { flex-direction: column; gap: 4px; }
  .form-label { width: auto; padding-top: 0; }
}
</style>
