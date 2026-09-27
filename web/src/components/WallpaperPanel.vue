<script setup>
/**
 * 壁纸面板：把本机 Wallpaper Engine 的壁纸库搬进网页，用作**静态**背景。
 *
 * 点缩略图或「设为背景」= 用该壁纸的预览图当页面右侧栏的图。
 *
 * 为什么只做静态背景：scene 型（本机占多数）是 Wallpaper Engine 私有格式
 * （.pkg），浏览器根本无法渲染，只有预览图可用；video 型虽然能播，但用户明确
 * 不要动态背景。所以统一静态，行为可预测、也不吃性能。
 */
import { ref, computed, onMounted } from 'vue'
import { api } from '../api.js'
import { wallpaper as wp, useWallpaper, clearWallpaper, resetLook } from '../wallpaper-state.js'

const list = ref([])
const available = ref(null)
const loading = ref(true)
const error = ref('')
const keyword = ref('')
const filter = ref('all') // all | video | scene | web

const counts = computed(() => {
  const c = { all: list.value.length }
  for (const w of list.value) c[w.type] = (c[w.type] ?? 0) + 1
  return c
})

/** 类型按钮：只显示实际存在的类型，避免出现 0 个的按钮。 */
const typeTabs = computed(() =>
  ['video', 'scene', 'web'].filter((t) => counts.value[t] > 0),
)

const shown = computed(() => {
  const k = keyword.value.trim().toLowerCase()
  return list.value.filter((w) => {
    if (filter.value !== 'all' && w.type !== filter.value) return false
    if (k && !w.title.toLowerCase().includes(k)) return false
    return true
  })
})

async function load() {
  loading.value = true
  error.value = ''
  try {
    const r = await api.wallpaperList()
    available.value = r.available
    list.value = r.wallpapers ?? []
  } catch (err) {
    error.value = err.message
  } finally {
    loading.value = false
  }
}

/** 把某张壁纸设为网页右侧栏的图（用它的预览图）。 */
function setAsBackground(w) {
  useWallpaper(w.id)
}

const isCurrent = (w) => wp.id === String(w.id)
const hasPreview = (w) => Boolean(w.previewName)

onMounted(load)
</script>

<template>
  <section class="wp-panel">
    <div v-if="loading" class="empty">正在读取本机壁纸库…</div>

    <div v-else-if="error" class="notice notice-error">读取壁纸库失败：{{ error }}</div>

    <template v-else-if="available === false">
      <div class="notice notice-warn">
        没有检测到 Wallpaper Engine 或它的创意工坊目录。装好 Wallpaper Engine（Steam）并订阅几张壁纸后，这里会自动出现。
      </div>
    </template>

    <template v-else>
      <!-- 当前背景与显示参数 -->
      <div class="card current-card">
        <div class="current-head">
          <h3 class="card-title" style="margin:0">当前网页背景</h3>
          <span v-if="wp.id" class="pill">已设置</span>
          <span v-else class="pill">未设置（纯色）</span>
          <div class="current-ops">
            <button v-if="wp.id" type="button" class="btn" @click="resetLook">恢复默认参数</button>
            <button v-if="wp.id" type="button" class="btn btn-danger" @click="clearWallpaper">取消背景</button>
          </div>
        </div>

        <div v-if="wp.id" class="sliders">
          <label class="slider-row">
            <span class="slider-label">壁纸栏宽度</span>
            <input v-model.number="wp.sideWidth" type="range" min="220" max="760" step="10" />
            <span class="slider-value">{{ wp.sideWidth }}px</span>
          </label>
          <label class="slider-row">
            <span class="slider-label">图片大小</span>
            <input v-model.number="wp.zoom" type="range" min="0.4" max="1.4" step="0.02" />
            <span class="slider-value">{{ wp.zoom.toFixed(2) }}×</span>
          </label>
          <label class="slider-row">
            <span class="slider-label">亮度</span>
            <input v-model.number="wp.brightness" type="range" min="0.4" max="1.5" step="0.05" />
            <span class="slider-value">{{ wp.brightness.toFixed(2) }}</span>
          </label>
          <p class="tiny muted" style="margin:4px 0 0">
            布局是<strong>左边页面、右边壁纸</strong>：壁纸单独占右侧一栏，不铺在文字底下，
            所以不用蒙层也不会影响阅读。窄窗口（&lt; 1080px）时壁纸栏会自动移到底部。
          </p>
        </div>
      </div>

      <!-- 筛选 -->
      <div class="filters">
        <input v-model="keyword" class="field" type="search" placeholder="搜索壁纸标题…" />
        <button type="button" class="btn" :class="{ 'btn-primary': filter === 'all' }" @click="filter = 'all'">
          全部 {{ counts.all }}
        </button>
        <button
          v-for="t in typeTabs"
          :key="t"
          type="button"
          class="btn"
          :class="{ 'btn-primary': filter === t }"
          @click="filter = t"
        >
          {{ t }} {{ counts[t] }}
        </button>
      </div>

      <p class="tiny muted" style="margin:0">
        显示的是壁纸的<strong>预览图（静态）</strong>，不做动态背景——省性能，行为也可预测。
        点缩略图或「设为背景」即把它放到页面右侧栏。
      </p>

      <!-- 网格 -->
      <div v-if="!shown.length" class="empty card">没有匹配的壁纸。</div>
      <div v-else class="wp-grid">
        <article
          v-for="w in shown"
          :key="w.id"
          class="wp-card card"
          :class="{ 'wp-current': isCurrent(w) }"
        >
          <button
            type="button"
            class="wp-thumb"
            :disabled="!hasPreview(w)"
            :title="hasPreview(w) ? '设为网页背景：' + w.title : '这个壁纸没有预览图'"
            @click="setAsBackground(w)"
          >
            <img v-if="hasPreview(w)" :src="api.wallpaperAsset(w.id, 'preview')" :alt="w.title" loading="lazy" />
            <span v-else class="wp-nopreview tiny muted">无预览图</span>
            <span v-if="isCurrent(w)" class="wp-badge wp-badge-on">使用中</span>
          </button>
          <div class="wp-meta">
            <div class="wp-title" :title="w.title">{{ w.title }}</div>
            <div class="tiny muted">
              {{ w.type }}<template v-if="w.tags?.length"> · {{ w.tags.slice(0, 2).join(' / ') }}</template>
            </div>
          </div>
          <div class="wp-ops">
            <button type="button" class="btn tiny" :disabled="!hasPreview(w)" @click="setAsBackground(w)">
              {{ isCurrent(w) ? '背景使用中' : '设为背景' }}
            </button>
          </div>
        </article>
      </div>
    </template>
  </section>
</template>

<style scoped>
.wp-panel { display: flex; flex-direction: column; gap: 12px; }

.current-card { padding: 14px 16px; }
.current-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.current-ops { margin-left: auto; display: flex; gap: 6px; }
.sliders { margin-top: 12px; display: flex; flex-direction: column; gap: 8px; }
.slider-row { display: flex; align-items: center; gap: 10px; }
.slider-label { flex: none; width: 118px; font-size: 13px; color: var(--muted); }
.slider-row input[type='range'] { flex: 1; min-width: 80px; }
.slider-value { flex: none; width: 52px; text-align: right; font-size: 12px; color: var(--muted); font-variant-numeric: tabular-nums; }

.filters { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.filters .field { flex: 1; min-width: 160px; }

.wp-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: 12px;
}
.wp-card { overflow: hidden; display: flex; flex-direction: column; }
.wp-current { outline: 2px solid var(--accent); outline-offset: -2px; }
.wp-thumb {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  aspect-ratio: 16 / 9;
  padding: 0;
  border: none;
  background: var(--surface-2);
  cursor: pointer;
  overflow: hidden;
}
.wp-thumb:disabled { cursor: default; }
.wp-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; transition: transform 0.25s; }
.wp-thumb:not(:disabled):hover img { transform: scale(1.05); }
.wp-badge {
  position: absolute;
  top: 6px;
  right: 6px;
  font-size: 11px;
  padding: 1px 7px;
  border-radius: 999px;
  background: var(--accent);
  color: #fff;
}
.wp-meta { padding: 8px 10px 4px; }
.wp-title {
  font-size: 13.5px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}
.wp-ops { display: flex; gap: 6px; padding: 8px 10px 10px; margin-top: auto; }
.wp-ops .btn { flex: 1; }

@media (max-width: 720px) {
  .slider-label { width: 96px; font-size: 12px; }
  .wp-grid { grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); }
}
</style>
