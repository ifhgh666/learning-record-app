/**
 * 自动提交：每次保存笔记后把 data/ 的改动 commit 到本地仓库。
 *
 * 设计要点：
 *  - 只 git add data/，不用 `git add -A`：避免把源码 WIP、构建产物、
 *    误建的密钥文件顺手提交进去。
 *  - 提交失败绝不影响保存：笔记已经落盘了，git 只是附加保险，失败只记日志。
 *  - 串行化：并发保存时排队执行，避免 index.lock 冲突。
 *  - **提交合并（coalesce）**：自动保存很频繁，如果每次都新增提交，
 *    记一条笔记就会产生 7 个提交、点几次收藏又是十几个——一年下来几千个
 *    无意义提交（实测真的发生过）。所以同一份数据的连续改动在时间窗口内
 *    合并进同一个提交。
 *
 * 合并的安全性：只有当「上一次提交确实是本进程、为同一份数据、且仍是 HEAD」
 * 时才 amend。外部提交（用户手敲、脚本、历史重写）一律不碰。
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { ROOT } from './storage.mjs'

const run = promisify(execFile)

/**
 * 仓库根目录。默认是项目根；测试时可用 GIT_REPO_ROOT 指到一个临时仓库，
 * 这样测试永远不用对用户的真实仓库做 reset / amend 之类的危险操作。
 */
const REPO_ROOT = process.env.GIT_REPO_ROOT ? path.resolve(process.env.GIT_REPO_ROOT) : ROOT

let queue = Promise.resolve()

/** 合并窗口：同一份数据在此时间内的连续改动合并为一次提交。 */
const COALESCE_WINDOW_MS = 10 * 60_000

/** 本进程做过的、可被合并的上一次提交。 */
let lastCommit = null // { sha, scope, at }

/**
 * 是否禁用自动提交。
 *
 * 用途：测试时（冒烟测试会起一个真实服务并写入测试数据）必须关掉提交，
 * 否则临时服务端会把测试文件、测试档案提交进用户的真实仓库历史——
 * 实测发生过，而且很隐蔽（提交混在正常提交里，清理逻辑还会因为
 * "不全是 notes: 测试日期" 而整体放弃）。
 * git 提交/合并行为由 scripts/test-git-commit.mjs 在隔离仓库里专门验证。
 */
const COMMIT_DISABLED = process.env.GIT_DISABLE_COMMIT === '1'

/** git 仓库是否可用（没 init 就静默跳过，不报错打扰用户）。 */
export function isGitRepo() {
  if (COMMIT_DISABLED) return false
  return existsSync(path.join(REPO_ROOT, '.git'))
}

async function git(args, opts = {}) {
  return run('git', args, { cwd: REPO_ROOT, windowsHide: true, ...opts })
}

/**
 * 从提交信息里解析出"这次动的是哪一份数据"。
 * 约定格式 `<scope>: <描述>`，例如：
 *   notes: 2026-09-24 (2 块)           → notes:2026-09-24
 *   recommend: 标记 owner/repo → worth → recommend:marks
 *   recommend: 2026-09-24 每日推荐快照  → recommend:snapshot
 *   profile: 更新个人档案               → profile
 */
function commitScope(message) {
  const [prefix, ...rest] = String(message).split(':')
  const p = prefix.trim()
  const body = rest.join(':').trim()
  if (p === 'notes') return `notes:${body.split(/\s+/)[0] ?? ''}`
  if (p === 'recommend') return body.startsWith('标记') ? 'recommend:marks' : 'recommend:snapshot'
  return p
}

/** 判断这次提交能否合并进上一次：本进程、同 scope、在窗口内、且仍是 HEAD。 */
async function canCoalesce(scope) {
  if (!lastCommit) return false
  if (lastCommit.scope !== scope) return false
  if (Date.now() - lastCommit.at > COALESCE_WINDOW_MS) return false
  try {
    const { stdout } = await git(['rev-parse', 'HEAD'])
    if (stdout.trim() !== lastCommit.sha) {
      // HEAD 被外部改动过（用户手敲提交、历史重写）→ 放弃合并，绝不越权 amend
      lastCommit = null
      return false
    }
    return true
  } catch {
    lastCommit = null
    return false
  }
}

/**
 * 提交 data/ 目录的改动（带合并）。
 * @param {string} message 提交信息，格式 `<scope>: <描述>`
 * @returns {Promise<{committed: boolean, amended?: boolean, reason?: string}>}
 */
export function commitData(message) {
  const task = async () => {
    if (!isGitRepo()) return { committed: false, reason: 'not-a-git-repo' }
    try {
      await git(['add', '--', 'data'])
      // 没有暂存内容就跳过（例如只点了保存但内容没变）
      const { stdout } = await git(['diff', '--cached', '--name-only'])
      if (!stdout.trim()) return { committed: false, reason: 'no-changes' }

      const scope = commitScope(message)
      if (await canCoalesce(scope)) {
        await git(['commit', '--amend', '-m', message, '--no-verify'])
        const { stdout: sha } = await git(['rev-parse', 'HEAD'])
        lastCommit = { sha: sha.trim(), scope, at: Date.now() }
        return { committed: true, amended: true }
      }

      await git(['commit', '-m', message, '--no-verify'])
      const { stdout: sha } = await git(['rev-parse', 'HEAD'])
      lastCommit = { sha: sha.trim(), scope, at: Date.now() }
      return { committed: true }
    } catch (err) {
      console.warn('[git] 自动提交失败（笔记已保存，不影响使用）：', err.message)
      return { committed: false, reason: 'error', error: err.message }
    }
  }
  queue = queue.then(task, task)
  return queue
}
