/**
 * 页面截图工具（CDP）：把真实渲染结果截下来，用来验证视觉/布局改动。
 *
 * 为什么需要它：布局、尺寸、遮挡这类问题，读 CSS 只能算出"应该是什么样"，
 * 必须真的渲染出来看。曾经就因为只看代码而误判过。
 *
 * 用法：
 *   node scripts/shot.mjs <输出png> [hash路由] [localStorage值JSON文件]
 *
 * 注意：JSON 必须从**文件**读，不能当命令行参数传——PowerShell 会吃掉 JSON 里的
 * 双引号（实测写进去变成 {id:xxx} 的非法 JSON），导致应用静默回退默认值，
 * 于是出现"功能没生效"的假象。这是工具链的坑，不是应用的问题。
 *
 * 依赖：本机已安装的 Google Chrome（无需额外 npm 依赖）。
 */
import { spawn } from 'node:child_process'
import { writeFileSync, readFileSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PORT = Number(process.env.SHOT_PORT ?? 9333)
const BASE = process.env.SHOT_BASE_URL ?? 'http://127.0.0.1:3777'

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
]

const [, , outArg = '.tmp/shot.png', route = '#/notes', lsFileArg = ''] = process.argv
const out = path.resolve(ROOT, outArg)
const lsValue = lsFileArg && existsSync(lsFileArg) ? readFileSync(lsFileArg, 'utf8').trim() : ''
const chromePath = CHROME_CANDIDATES.find((p) => existsSync(p))
const userDataDir = path.join(ROOT, '.tmp', 'chrome-profile')

if (!chromePath) {
  console.error('没有找到 Chrome/Edge，无法截图')
  process.exit(1)
}

mkdirSync(path.dirname(out), { recursive: true })
rmSync(userDataDir, { recursive: true, force: true })
mkdirSync(userDataDir, { recursive: true })

const width = Number(process.env.SHOT_WIDTH ?? 1440)
const height = Number(process.env.SHOT_HEIGHT ?? 900)

const chrome = spawn(
  chromePath,
  [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    `--window-size=${width},${height}`,
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    'about:blank',
  ],
  { stdio: 'ignore', windowsHide: true },
)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function findTarget() {
  for (let i = 0; i < 40; i += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      const page = list.find((t) => t.type === 'page')
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl
    } catch { /* 还没起来 */ }
    await sleep(250)
  }
  throw new Error('Chrome 调试端口未就绪')
}

let seq = 0
const pending = new Map()
const send = (ws, method, params = {}) =>
  new Promise((resolve, reject) => {
    seq += 1
    pending.set(seq, { resolve, reject })
    ws.send(JSON.stringify({ id: seq, method, params }))
  })

/** 探针：读回真实 DOM 与计算样式，作为"改动确实生效"的客观证据。
 *  同时检查横向溢出——"边框被挤出去"这类问题必须用几何数据定位，不能靠肉眼猜。 */
const PROBE = `(() => {
  const q = (s) => document.querySelector(s);
  const img = q('.wallpaper-media');
  const side = q('.wallpaper-side');
  const content = q('.content');
  const out = {
    hasWallpaper: !!img,
    appShellClass: q('.app-shell')?.className ?? null,
    lsRaw: localStorage.getItem('learning-record:wallpaper'),
  };
  if (side) {
    const sr = side.getBoundingClientRect();
    out.sideLeft = Math.round(sr.left);
    out.sideWidth = Math.round(sr.width);
    out.sidePosition = getComputedStyle(side).position;
  }
  if (img) {
    const r = img.getBoundingClientRect();
    out.imgW = Math.round(r.width);
    out.imgH = Math.round(r.height);
    out.naturalW = img.naturalWidth;
    out.naturalH = img.naturalHeight;
    out.objectFit = getComputedStyle(img).objectFit;
  }
  if (content) {
    const cr = content.getBoundingClientRect();
    out.contentLeft = Math.round(cr.left);
    out.contentWidth = Math.round(cr.width);
  }
  out.viewportW = innerWidth;
  out.viewportH = innerHeight;
  out.docScrollW = document.documentElement.scrollWidth;

  // 横向溢出检测：找出比视口宽、或超出父容器的元素
  const overflow = [];
  for (const el of document.querySelectorAll('body *')) {
    const r = el.getBoundingClientRect();
    if (r.width === 0) continue;
    if (r.right > innerWidth + 1 || r.left < -1) {
      overflow.push({
        tag: el.tagName.toLowerCase(),
        cls: (el.className && typeof el.className === 'string') ? el.className.slice(0, 48) : '',
        left: Math.round(r.left),
        right: Math.round(r.right),
        w: Math.round(r.width),
      });
    }
  }
  out.overflow = overflow.slice(0, 8);
  out.overflowCount = overflow.length;
  return JSON.stringify(out);
})()`

let ws
try {
  const wsUrl = await findTarget()
  ws = new WebSocket(wsUrl)
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true })
    ws.addEventListener('error', reject, { once: true })
  })
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.error) reject(new Error(JSON.stringify(msg.error)))
      else resolve(msg.result)
    }
  })

  await send(ws, 'Page.enable')
  await send(ws, 'Runtime.enable')

  const url = `${BASE}/${route}`
  await send(ws, 'Page.navigate', { url })
  await sleep(1500)

  if (lsValue) {
    const r = await send(ws, 'Runtime.evaluate', {
      expression: `localStorage.setItem('learning-record:wallpaper', ${JSON.stringify(lsValue)}); 'ok'`,
      returnByValue: true,
    })
    if (r.result?.value !== 'ok') throw new Error('写入 localStorage 失败')
    // 必须整页重载：应用只在模块初始化时读 localStorage，
    // 而带 hash 的 navigate 只触发 hashchange，不会重载。
    await send(ws, 'Page.navigate', { url: `${BASE}/` })
    await sleep(700)
    await send(ws, 'Page.reload', { ignoreCache: true })
    await sleep(1000)
    await send(ws, 'Page.navigate', { url })
    await sleep(2500)
  }

  const probe = await send(ws, 'Runtime.evaluate', { expression: PROBE, returnByValue: true })
  console.log(probe.result?.value ?? '(探针无输出)')

  const shot = await send(ws, 'Page.captureScreenshot', { format: 'png' })
  writeFileSync(out, Buffer.from(shot.data, 'base64'))
  console.log(`截图已保存: ${path.relative(ROOT, out)}`)
} finally {
  try { ws?.close() } catch { /* 忽略 */ }
  chrome.kill()
  await sleep(400)
  rmSync(userDataDir, { recursive: true, force: true })
}
