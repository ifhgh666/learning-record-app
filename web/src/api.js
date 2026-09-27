/** 与后端 API 的唯一出口。出错时抛出带后端原文的 Error，界面如实显示。 */
async function request(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let data = null
  try { data = text ? JSON.parse(text) : null } catch { /* 保留原文 */ }
  if (!res.ok) {
    const err = new Error(data?.error ?? `HTTP ${res.status} ${text.slice(0, 200)}`)
    err.status = res.status
    throw err
  }
  return data
}

export const api = {
  health: () => request('GET', '/api/health'),

  day: (date) => request('GET', `/api/day/${date}`),
  saveDay: (date, blocks) => request('PUT', `/api/day/${date}`, { blocks }),
  addBlock: (date, block) => request('POST', `/api/day/${date}/blocks`, block),

  days: () => request('GET', '/api/days'),
  tags: () => request('GET', '/api/tags'),
  search: (params = {}) => {
    const qs = new URLSearchParams(
      Object.entries(params).filter(([, v]) => v !== '' && v !== null && v !== undefined),
    )
    return request('GET', `/api/search?${qs}`)
  },

  profile: () => request('GET', '/api/profile'),
  saveProfile: (patch) => request('PUT', '/api/profile', patch),

  wallpaperStatus: () => request('GET', '/api/wallpaper/status'),
  wallpaperList: () => request('GET', '/api/wallpaper/list'),
  /** 壁纸预览图直链（由 /wallpaper-asset 路由提供）。 */
  wallpaperAsset: (id, kind) => `/wallpaper-asset/${encodeURIComponent(id)}/${kind}`,

  quotes: () => request('GET', '/api/quotes'),

  /* ---------------- AI 对话 ---------------- */
  aiStatus: () => request('GET', '/api/ai/status'),
  saveAiConfig: (patch) => request('PUT', '/api/ai/config', patch),
  aiChats: () => request('GET', '/api/ai/chats'),
  aiChat: (id) => request('GET', `/api/ai/chat/${id}`),
  aiSaveChat: (id, payload) => request('PUT', `/api/ai/chat/${id}`, payload),
  aiDeleteChat: (id) => request('DELETE', `/api/ai/chat/${id}`),

  /**
   * 流式发送对话。用 fetch + ReadableStream 手动解析 SSE，
   * 因为 EventSource 只支持 GET，而这里必须 POST 完整消息历史。
   *
   * @param {Array<{role:string,content:string}>} messages
   * @param {(chunk:string)=>void} onDelta 每收到一段增量文本就回调
   * @param {AbortSignal} [signal]
   */
  async aiStreamChat(messages, onDelta, signal) {
    const res = await fetch('/api/ai/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages, stream: true }),
      signal,
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      let msg = `HTTP ${res.status}`
      try { msg = JSON.parse(text).error ?? msg } catch { if (text) msg = text.slice(0, 300) }
      throw new Error(msg)
    }
    if (!res.body) throw new Error('响应没有可读流')

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let full = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? '' // 最后一行可能不完整，留到下次
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed.startsWith('data:')) continue
        const payload = trimmed.slice(5).trim()
        if (payload === '[DONE]') continue
        try {
          const json = JSON.parse(payload)
          const delta = json?.choices?.[0]?.delta?.content
          if (delta) {
            full += delta
            onDelta(delta)
          }
        } catch { /* 忽略无法解析的行（心跳、注释等） */ }
      }
    }
    return full
  },

  recommendToday: (opts = {}) => {
    const qs = new URLSearchParams()
    if (opts.date) qs.set('date', opts.date)
    if (opts.refresh) qs.set('refresh', '1')
    const s = qs.toString()
    return request('GET', `/api/recommend/today${s ? `?${s}` : ''}`)
  },
  markRepo: (fullName, status, favorite) =>
    request('POST', '/api/recommend/mark', { fullName, status, favorite }),
  recommendHistory: () => request('GET', '/api/recommend/history'),
}

/** 本地日期 YYYY-MM-DD（不能用 toISOString，那是 UTC，晚上会差一天）。 */
export function todayLocal() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export function formatHuman(date) {
  const [y, m, d] = date.split('-')
  return `${y} 年 ${Number(m)} 月 ${Number(d)} 日`
}

export function weekdayOf(date) {
  const names = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
  return names[new Date(`${date}T00:00:00`).getDay()]
}

export const CATEGORY_LABEL = { memory: '记忆类', writing: '纯写类' }
export const CATEGORY_HINT = {
  memory: '需要背下来、以后要复习的内容',
  writing: '理解了、想清楚了的内容',
}
