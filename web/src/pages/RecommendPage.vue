<script setup>
/**
 * 页面一：今日推荐。
 *
 * 后端保证「当天首次打开抓一次、之后读快照」，所以这里的 refresh 按钮是
 * 显式的"我就要重抓"，而不是每次进页面都打网络——那样既慢又会被限速。
 */
import { ref, computed, onMounted } from 'vue'
import { api, todayLocal, formatHuman } from '../api.js'

const date = ref(todayLocal())
const data = ref(null)
const loading = ref(true)
const refreshing = ref(false)
const error = ref('')
const githubExpanded = ref(false)

const topRepo = computed(() => data.value?.github?.[0] ?? null)
const otherRepos = computed(() => data.value?.github?.slice(1) ?? [])
const failedSources = computed(() => (data.value?.sources ?? []).filter((s) => !s.ok))

async function load(refresh = false) {
  if (refresh) refreshing.value = true
  else loading.value = true
  error.value = ''
  try {
    data.value = await api.recommendToday({ date: date.value, refresh })
  } catch (err) {
    error.value = err.message
  } finally {
    loading.value = false
    refreshing.value = false
  }
}

function mark(repo, status) {
  const current = data.value.marks?.[repo.fullName] ?? 'none'
  const next = current === status ? 'none' : status
  // 乐观更新：先改界面，失败再回滚，避免每次点标记都等一个网络往返
  const prev = { ...(data.value.marks ?? {}) }
  data.value.marks = { ...prev, [repo.fullName]: next }
  if (next === 'none') delete data.value.marks[repo.fullName]
  api.markRepo(repo.fullName, next).catch((err) => {
    data.value.marks = prev
    error.value = `标记失败：${err.message}`
  })
}

function toggleFavorite(repo) {
  const isFav = data.value.favorites?.includes(repo.fullName)
  const prev = [...(data.value.favorites ?? [])]
  data.value.favorites = isFav
    ? prev.filter((n) => n !== repo.fullName)
    : [...prev, repo.fullName]
  api.markRepo(repo.fullName, data.value.marks?.[repo.fullName] ?? 'none', !isFav).catch((err) => {
    data.value.favorites = prev
    error.value = `收藏失败：${err.message}`
  })
}

onMounted(() => load(false))
</script>

<template>
  <section class="rec">
    <header class="rec-head">
      <div>
        <h2>今日推荐</h2>
        <p class="small muted">{{ formatHuman(date) }} · 每天抓一次，当天读缓存</p>
      </div>
      <div class="rec-actions">
        <button type="button" class="btn" :disabled="refreshing" @click="load(true)">
          {{ refreshing ? '重新抓取中…' : '重新抓取' }}
        </button>
      </div>
    </header>

    <div v-if="loading" class="empty">正在获取今天的推荐…（首次抓取约 3～5 秒）</div>

    <div v-else-if="error" class="notice notice-error">加载失败：{{ error }}</div>

    <template v-else-if="data">
      <div v-if="data.stale" class="notice notice-warn" style="margin-bottom:14px">
        今天抓取失败，以下是你最近一次成功抓取的内容（{{ data.fetchedAt ? formatHuman(data.fetchedAt.slice(0, 10)) : '未知日期' }}）。
      </div>
      <div v-else-if="failedSources.length" class="notice notice-warn" style="margin-bottom:14px">
        部分数据源今天没抓到：{{ failedSources.map((s) => s.name).join('、') }} —— 其余内容照常显示。
      </div>

      <!-- 每日一个仓库：不用卡片，与下面的列表同一套视觉语言 -->
      <article v-if="topRepo" class="repo-hero">
        <div class="repo-top">
          <span class="pill">今日仓库</span>
          <span v-if="topRepo.language" class="pill">{{ topRepo.language }}</span>
          <span class="pill">★ {{ topRepo.stars.toLocaleString() }}</span>
          <span v-if="topRepo.ageDays !== undefined" class="pill">建站 {{ topRepo.ageDays }} 天</span>
          <button
            type="button"
            class="btn btn-ghost tiny fav-btn"
            :class="{ 'fav-on': data.favorites?.includes(topRepo.fullName) }"
            @click="toggleFavorite(topRepo)"
          >
            {{ data.favorites?.includes(topRepo.fullName) ? '★ 已收藏' : '☆ 收藏' }}
          </button>
        </div>
        <h3 class="repo-name">
          <a :href="topRepo.url" target="_blank" rel="noreferrer">{{ topRepo.fullName }}</a>
        </h3>
        <p class="repo-desc">{{ topRepo.description || '（该仓库没有写简介）' }}</p>
        <div v-if="topRepo.topics?.length" class="repo-topics">
          <span v-for="t in topRepo.topics.slice(0, 8)" :key="t" class="pill tiny">#{{ t }}</span>
        </div>
        <div class="mark-row">
          <button
            type="button"
            class="btn"
            :class="{ 'btn-primary': data.marks?.[topRepo.fullName] === 'worth' }"
            @click="mark(topRepo, 'worth')"
          >
            值得看
          </button>
          <button
            type="button"
            class="btn"
            :class="{ 'btn-primary': data.marks?.[topRepo.fullName] === 'read' }"
            @click="mark(topRepo, 'read')"
          >
            已看完
          </button>
          <span class="tiny muted">最近推送：{{ String(topRepo.pushedAt).slice(0, 10) }}</span>
        </div>
      </article>

      <div v-else class="notice notice-warn">今天没有抓到合适的仓库（可能 API 限速或查询无结果）。</div>

      <!-- 备选仓库 -->
      <section v-if="otherRepos.length" class="list-card">
        <button type="button" class="more-head" @click="githubExpanded = !githubExpanded">
          <span>备选仓库（{{ otherRepos.length }}）</span>
          <span class="tiny muted">{{ githubExpanded ? '收起 ▲' : '展开 ▼' }}</span>
        </button>
        <ul v-if="githubExpanded" class="more-list">
          <li v-for="repo in otherRepos" :key="repo.fullName">
            <a :href="repo.url" target="_blank" rel="noreferrer">{{ repo.fullName }}</a>
            <span class="tiny muted">★{{ repo.stars.toLocaleString() }}</span>
            <span v-if="repo.ageDays !== undefined" class="tiny muted">{{ repo.ageDays }} 天</span>
            <span class="tiny muted repo-li-desc">{{ repo.description }}</span>
            <button
              type="button"
              class="btn btn-ghost tiny"
              :class="{ 'fav-on': data.favorites?.includes(repo.fullName) }"
              @click="toggleFavorite(repo)"
            >
              {{ data.favorites?.includes(repo.fullName) ? '★' : '☆' }}
            </button>
            <button
              type="button"
              class="btn btn-ghost tiny"
              :class="{ 'btn-primary': data.marks?.[repo.fullName] === 'worth' }"
              @click="mark(repo, 'worth')"
            >
              值得看
            </button>
          </li>
        </ul>
      </section>

      <!-- V2EX 热门讨论：仿论坛文章列表（标题 / 节点 / 摘要 / 元信息 + 分隔线） -->
      <section class="list-block">
        <h3 class="block-title">V2EX 热门讨论</h3>
        <ul v-if="data.v2ex?.length" class="entry-list">
          <li v-for="item in data.v2ex" :key="item.url" class="entry">
            <h4 class="entry-title">
              <a :href="item.url" target="_blank" rel="noreferrer">{{ item.title }}</a>
            </h4>
            <div v-if="item.node || item.author" class="entry-tags">
              <span v-if="item.node" class="tag-chip">{{ item.node }}</span>
              <span v-if="item.author" class="tag-chip">@{{ item.author }}</span>
            </div>
            <p class="entry-meta tiny muted">
              <span class="entry-time">今日热门</span>
              <span class="sep">|</span>💬 {{ item.replies }} 条回复
            </p>
          </li>
        </ul>
        <p v-else class="empty small">今天没有抓到 V2EX 热门讨论。</p>
      </section>

      <!-- 掘金最新文章：按发布时间倒序，所以标题里写"最新"而不是"推荐" -->
      <section class="list-block">
        <h3 class="block-title">掘金最新文章</h3>
        <ul v-if="data.juejin?.length" class="entry-list">
          <li v-for="item in data.juejin" :key="item.url" class="entry">
            <h4 class="entry-title">
              <a :href="item.url" target="_blank" rel="noreferrer">{{ item.title }}</a>
            </h4>
            <p v-if="item.brief" class="entry-summary">{{ item.brief }}</p>
            <p class="entry-meta tiny muted">
              <!-- 显示真实发布日期，这样"是不是今天的"一眼可验证 -->
              <span class="entry-time">{{ item.publishedAt ? item.publishedAt.slice(0, 10) : '日期未知' }}</span>
              <template v-if="item.cate"><span class="sep">|</span>{{ item.cate }}</template>
              <template v-if="item.digs"><span class="sep">|</span>👍 {{ item.digs }}</template>
              <template v-if="item.views"><span class="sep">|</span>👁 {{ item.views }}</template>
              <template v-if="item.comments"><span class="sep">|</span>💬 {{ item.comments }}</template>
            </p>
          </li>
        </ul>
        <p v-else class="empty small">今天没有抓到掘金文章。</p>
      </section>

      <p class="tiny muted" style="margin-top:18px">
        抓取时间：{{ data.fetchedAt ? new Date(data.fetchedAt).toLocaleString('zh-CN') : '未成功抓取' }}
        · 全部来自公开 API，未使用任何密钥
      </p>
    </template>
  </section>
</template>

<style scoped>
/* min-width:0 + 宽度约束：防止内部长内容（超长仓库名/URL）把区块撑出容器，
   造成"边框被挤到外面"的观感 */
.rec {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
  max-width: 100%;
}
.rec > * { min-width: 0; max-width: 100%; }
.rec-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  padding-bottom: 10px;
  border-bottom: 2px solid var(--line);
  margin-bottom: 14px;
}
.rec-head h2 { font-size: 20px; }
.rec-head p { margin: 2px 0 0; }

/* 今日仓库：不用卡片，和下面的列表保持同一套视觉语言 */
.repo-hero {
  padding: 12px 0 16px;
  border-bottom: 1px solid var(--line);
  min-width: 0;
  max-width: 100%;
  overflow-wrap: anywhere;
}
.repo-top { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 8px; }
.fav-btn { margin-left: auto; }
.fav-on { color: #b45309; font-weight: 600; }
.repo-name { font-size: 20px; margin: 0 0 6px; overflow-wrap: anywhere; }
.repo-desc { margin: 0 0 8px; color: #3f4653; line-height: 1.65; }
.repo-topics { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 10px; }
.mark-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.mark-row .tiny { margin-left: auto; }

/* 备选仓库：折叠块，保持轻量（不用卡片，融入列表风格） */
.more-card { padding: 4px 0; }
.more-head {
  width: 100%;
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 10px 0;
  background: transparent;
  border: none;
  border-bottom: 1px solid var(--line);
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  color: var(--text);
}
.more-list { list-style: none; margin: 0; padding: 0; }
.more-list li {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 0;
  border-bottom: 1px solid var(--line);
  flex-wrap: wrap;
}
.repo-li-desc {
  flex: 1;
  min-width: 160px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ---------- 文章列表（仿传统博客/论坛的条目列表） ---------- */

.list-block { margin-bottom: 26px; }

/* 区块标题：下方一条实线，像图片里的"文章列表" */
.block-title {
  font-size: 15.5px;
  font-weight: 650;
  padding-bottom: 8px;
  margin-bottom: 2px;
  border-bottom: 2px solid var(--line);
}

.entry-list { list-style: none; margin: 0; padding: 0; }
.entry {
  padding: 12px 0;
  border-bottom: 1px solid var(--line);
}
.entry:last-child { border-bottom: none; }

.entry-title {
  font-size: 16.5px;
  font-weight: 600;
  line-height: 1.45;
  margin: 0 0 5px;
}
.entry-title a { color: var(--accent-strong); text-decoration: none; }
.entry-title a:hover { text-decoration: underline; }

.entry-tags { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 6px; }
.tag-chip {
  font-size: 12px;
  padding: 1px 9px;
  border-radius: 999px;
  background: var(--accent-soft);
  color: var(--accent-strong);
}

.entry-summary {
  margin: 0 0 6px;
  font-size: 14px;
  line-height: 1.65;
  color: #4b5260;
}

/* 元信息行：仿图片里的 "2009-04-07 14:02 | 浏览 71789 | 评论(17) | 分类:编程语言" */
.entry-meta {
  margin: 0;
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.entry-time { color: var(--muted); }
.sep { color: #c8ccd4; }
</style>
