/**
 * 停止本机服务（桌面启动器把服务放到后台跑，需要一个对应的停止方式）。
 *
 * 只结束"在监听本项目端口的那个 node 进程"，不会误杀其它 node 程序。
 * 用法：node scripts/stop-server.mjs
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)
const PORT = Number(process.env.PORT ?? 3777)

async function findPid() {
  // netstat 是 Windows 上最直接的端口→PID 查询；PowerShell 的 Get-NetTCPConnection 也可，
  // 但 netstat 在受限环境里更稳。
  const { stdout } = await run('netstat', ['-ano', '-p', 'TCP'], { windowsHide: true })
  for (const line of stdout.split('\n')) {
    const m = /^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)/i.exec(line)
    if (m && Number(m[1]) === PORT) return Number(m[2])
  }
  return null
}

const pid = await findPid()
if (!pid) {
  console.log(`端口 ${PORT} 上没有在运行的服务。`)
  process.exit(0)
}

try {
  await run('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true })
  console.log(`已停止学习记录本服务（PID ${pid}）。`)
} catch (err) {
  console.error(`停止失败：${String(err.message).split('\n')[0]}`)
  console.error('可以手动在任务管理器里结束对应的 node.exe。')
  process.exit(1)
}
