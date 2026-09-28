/**
 * 桌面启动器的工作进程（由「学习记录本.vbs」用隐藏窗口调起）。
 *
 * 行为：
 *  - 服务已经在跑 → 直接打开浏览器（不会重复起服务）
 *  - 没在跑 → 后台启动服务，等它真正就绪后再打开浏览器
 *
 * 为什么要有"已就绪检测"而不是 Sleep 几秒了事：固定延时要么白等、要么在慢机器上
 * 打开时页面还没起来（白屏）。这里轮询 /api/health，起来了才开浏览器。
 *
 * 为什么服务要 detached 启动：这样关掉启动器窗口不会连带杀掉服务。
 * 想停服务时用 scripts/stop-server.mjs（或任务管理器结束 node.exe）。
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PORT = Number(process.env.PORT ?? 3777)
const URL = `http://127.0.0.1:${PORT}`

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function isUp() {
  try {
    const res = await fetch(`${URL}/api/health`, { signal: AbortSignal.timeout(1500) })
    return res.ok
  } catch {
    return false
  }
}

function openBrowser() {
  // 用 explorer 打开默认浏览器：比 start 命令可靠，也不依赖 shell
  spawn('explorer.exe', [URL], { stdio: 'ignore', detached: true, windowsHide: true }).unref()
}

const already = await isUp()

if (!already) {
  // 首次运行可能还没构建前端；start.mjs 会负责构建
  //
  // NO_OPEN=1：让 start.mjs **不要**自己开浏览器。开浏览器由这里负责——
  // 因为它会先轮询 /api/health 确认服务真的就绪了再开（start.mjs 只是等固定延迟）。
  // 不传这个变量的话两边都会开，结果点一下图标弹出两个标签页（实测踩过）。
  const child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'start.mjs')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), NO_OPEN: '1' },
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  })
  child.unref()

  // 等它真的能响应（最多 60 秒，首次可能要构建前端）
  const deadline = Date.now() + 60_000
  let up = false
  while (Date.now() < deadline) {
    if (await isUp()) { up = true; break }
    await sleep(400)
  }
  if (!up) {
    // 起不来时给一个可见的提示，而不是静默失败
    const msg = `学习记录本启动失败。请在本项目目录手动运行看报错：npm start　项目位置：${ROOT}`
    spawn('mshta.exe', [`javascript:alert('${msg.replace(/'/g, "\\'")}');close()`], {
      stdio: 'ignore', windowsHide: false,
    })
    process.exit(1)
  }
}

openBrowser()
process.exit(0)
