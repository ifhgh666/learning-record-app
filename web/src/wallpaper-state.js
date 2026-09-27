/**
 * 壁纸状态：持久化到 localStorage，并驱动全局 CSS 变量。
 *
 * 布局是「左边页面、右边壁纸」两栏，所以这里调的是**壁纸栏宽度**和**图片大小**，
 * 不是之前那套"背景蒙层/模糊"参数——壁纸不再是铺满全屏的背景，
 * 也就不需要为"文字可读性"做蒙层了（用户明确不要那种朦胧效果）。
 */
import { reactive, watch } from 'vue'

const KEY = 'learning-record:wallpaper'

const DEFAULT = {
  id: '',        // 选中的壁纸 id；空=不显示壁纸栏
  sideWidth: 420, // 右侧壁纸栏宽度（px）
  zoom: 1,       // 图片在栏内的缩放（1=完整恰好放下）
  brightness: 1, // 亮度倍数
}

function load() {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return { ...DEFAULT }
    const parsed = JSON.parse(raw)
    // 只取认识的字段：旧版本存过 overlay/blur/kind/seed，直接忽略，
    // 避免旧数据把已删除的参数又带回界面。
    return {
      id: typeof parsed.id === 'string' ? parsed.id : DEFAULT.id,
      sideWidth: Number.isFinite(parsed.sideWidth) ? parsed.sideWidth : DEFAULT.sideWidth,
      zoom: Number.isFinite(parsed.zoom) ? parsed.zoom : DEFAULT.zoom,
      brightness: Number.isFinite(parsed.brightness) ? parsed.brightness : DEFAULT.brightness,
    }
  } catch {
    return { ...DEFAULT }
  }
}

export const wallpaper = reactive(load())

watch(
  wallpaper,
  (state) => {
    try {
      localStorage.setItem(KEY, JSON.stringify(state))
    } catch { /* 隐私模式下可能失败，忽略即可，不影响使用 */ }
    applyCssVars(state)
  },
  { deep: true },
)

function applyCssVars(state) {
  const root = document.documentElement
  root.style.setProperty('--wp-side-width', `${state.sideWidth}px`)
  root.style.setProperty('--wp-zoom', String(state.zoom))
  root.style.setProperty('--wp-brightness', String(state.brightness))
}

/** 选一张壁纸显示在右栏（用预览图，静态）。 */
export function useWallpaper(id) {
  wallpaper.id = String(id)
}

/** 取消壁纸栏，回到单栏布局。 */
export function clearWallpaper() {
  wallpaper.id = ''
}

/** 恢复默认显示参数（不动选了哪张）。 */
export function resetLook() {
  wallpaper.sideWidth = DEFAULT.sideWidth
  wallpaper.zoom = DEFAULT.zoom
  wallpaper.brightness = DEFAULT.brightness
}

// 首次进入就应用一次，避免刷新后布局抖一下
applyCssVars(wallpaper)
