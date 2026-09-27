/**
 * 单命令启动：确保前端已构建 → 起后端（后端同时托管前端）→ 打开浏览器。
 *
 * 为什么需要它：需求明确要"一条命令起全套 + 自动开浏览器"，而不是
 * "先开 Vite 再开后端"两个终端。开发时请用 npm run dev（有热更新）。
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PORT = Number(process.env.PORT ?? 3777)
const URL = `http://127.0.0.1:${PORT}`
const distIndex = path.join(ROOT, 'dist', 'index.html')

function buildFrontend() {
  console.log('首次启动：正在构建前端…')
  const r = spawnSync('npx', ['vite', 'build', '--config', 'web/vite.config.mjs'], {
    cwd: ROOT,
    stdio: 'inherit',
    shell: true,
  })
  if (r.status !== 0) {
    console.error('\n前端构建失败。请把上面的报错发给我。')
    process.exit(r.status ?? 1)
  }
}

if (!existsSync(distIndex)) buildFrontend()

// 用一个固定延迟后打开浏览器：服务起来需要几百毫秒，立即开可能白屏
setTimeout(() => {
  const opener = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', URL]]
    : process.platform === 'darwin' ? ['open', [URL]]
    : ['xdg-open', [URL]]
  try {
    spawn(opener[0], opener[1], { stdio: 'ignore', detached: true, shell: false }).unref()
  } catch {
    console.log(`（没能自动打开浏览器，请手动访问 ${URL}）`)
  }
}, 1200)

const server = spawn(process.execPath, ['server/index.mjs'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT) },
  stdio: 'inherit',
})

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    server.kill()
    process.exit(0)
  })
}
