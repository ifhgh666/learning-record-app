# 开发说明

面向要改这个项目的人。使用者请看 [README.md](README.md)。

这里记录的是"为什么这么做"和"踩过什么坑"——尤其是几个 Windows 上
**文件编码与行尾必须匹配读取方**的坑，改启动脚本前务必先看。

## 怎么跑

**日常使用：双击桌面的图标，不用碰终端。**

| 桌面图标 | 作用 |
| --- | --- |
| **打开DSH** | 打开 DeepSeek Harness。以最小化窗口启动服务进程，用完关掉那个窗口即退出 |
| **学习记录本** | 打开这个学习记录网站。已在跑就只开浏览器；没跑就静默启动（约 2 秒，不弹黑窗） |

图标删了或换电脑，一条命令重建两个：

```bash
powershell -ExecutionPolicy Bypass -File scripts/make-shortcut.ps1
```

命令行方式（开发时用）：

```bash
npm install        # 首次
npm start          # 起服务并自动打开浏览器 → http://127.0.0.1:3777
npm run dev        # 开发模式（前端热更新，前后端分开跑）
node scripts/stop-server.mjs   # 停止学习记录本的服务
```

### ⚠ 改这几个启动文件时必看：编码与行尾

Windows 的脚本宿主和 cmd.exe 对**文件编码和行尾**非常敏感，本项目踩了四个坑：

| 文件类型 | 必须 | 不对会怎样 |
| --- | --- | --- |
| `.vbs` | **UTF-16LE（带 `FF FE` BOM）** | cscript 按 ANSI 读，中文路径解析坏，报"未结束的字符串常量" |
| `.ps1` | **UTF-8 with BOM** | PowerShell 5.1 按本地代码页读，中文串变乱码 |
| `.cmd` | **UTF-8 无 BOM + `chcp 65001` + CRLF 行尾** | 行尾是 LF 时 cmd 会把语句切错，报 `'tlocal' is not recognized` 这类莫名其妙的错 |
| 源码 / 配置 | UTF-8 | — |

规范化 `.cmd` 用 `node scripts/fix-cmd-encoding.mjs`（自动修编码与行尾）。

> 注意：`git` 行尾由 `.gitattributes` 固定为 LF，所以检出后 `.cmd` 在工作区是 LF。
> **用编辑器保存过这些文件后，记得确认行尾仍是 CRLF**，否则双击会报错。

### 「打开DSH」这条链路的验证限制

**不能从 DSH 内部测试启动它**——再起一个 DSH 实例会触发保护机制并破坏当前会话
（实测报 `Windows Job runner exited with exit code 4294967295`）。
所以这条链路只用静态方式验证：

```bash
powershell -ExecutionPolicy Bypass -File scripts/_verify-dsh-launcher.ps1
```

它检查文件存在性、快捷方式指向、文件编码、入口查找结果，**但不实际启动 DSH**。

验证（全部是真实跑，不是 mock）：

```bash
npm run check         # 存储层(21) + git提交合并(12) + 壁纸(10) + AI对话(20) + 端到端冒烟(25)
npm run test:storage  # 只跑存储层：手改文件、块数不一致、往返保真等边界
npm run test:git      # 只跑提交合并：在**隔离仓库**里验证 amend 行为，不碰真实仓库
npm run test:wallpaper# 只跑壁纸：真实读取本机壁纸库 + 路径穿越防护
npm run test:ai       # 只跑 AI：本地起一个假的 OpenAI 兼容上游，全链路验证（不需要真 Key）
npm run smoke         # 只跑端到端：真实起服务 + 真实读写（不会污染 git 历史）
npm run verify:real   # 真实日期写一天 → 检查落盘文件与索引 → 用完自动清理
```

`test:ai` 的做法值得一提：DeepSeek 要真 Key 才能调，但流式解析、落盘格式、
Key 不泄漏这些逻辑必须验证。所以它**在本地起一个假的 OpenAI 兼容上游**，
用 `DEEPSEEK_BASE_URL` 把真实服务指过去，从而全链路跑通而不花钱、不需要真 Key。

---

## 三个页面

| 页面 | 内容 |
| --- | --- |
| **今日推荐** | 每天一个 GitHub 仓库（近期创建、近期活跃，可在备选里挑）+ V2EX 热门讨论 + 掘金推荐文章 + Hacker News 最佳文章。可标记「值得看 / 已看完」、可收藏。 |
| **学习记录** | 一天一篇，按块记录。每块独立选分类（记忆类 / 纯写类）+ 打标签，块内是所见即所得富文本（代码块、表格、链接）。自动保存。 |
| **AI 对话** | 仿 DeepSeek 的聊天页：左侧对话列表、中间消息流、底部输入框，支持流式逐字回复。对话存成 Markdown 文件。可选功能，需要你自己的 DeepSeek API Key。 |
| **我的 / 记录 / 壁纸** | 「我的」：昵称简介、连续记录天数、本周格子、最近记录、收藏的仓库。「记录」：标签筛选 + 分类筛选 + 全文搜索 + 时间范围。「壁纸」：把本机 Wallpaper Engine 的壁纸用作网页背景（静态，右侧独立一栏），或一键应用到 Windows 桌面。 |

### AI 对话（可选功能）

需要你自己的 **DeepSeek API Key**（[在这里申请](https://platform.deepseek.com/api_keys)）。两种配置方式：

```bash
# 方式一：环境变量（推荐，不落盘）
set DEEPSEEK_API_KEY=sk-xxxx
npm start

# 方式二：页面里填（存到 data/ai.json，已被 .gitignore 排除）
# 「AI 对话 → 设置」里粘贴 Key
```

**Key 的安全边界（这是设计决定，不是实现细节）：**

- **浏览器永远拿不到 Key**。页面把 Key 交给本机服务，由服务端代理转发请求；
  `/api/ai/status` 只回「是否已配置」和 Key 的后 4 位提示，不回传 Key 本身（有测试覆盖）。
  之所以不直接在前端调 DeepSeek，是因为 localStorage 里的任何东西同源脚本都能读，
  不适合放密钥。
- **Key 不进 git**。`data/ai.json` 已加入 `.gitignore`（`git check-ignore data/ai.json` 可验证）。
- 对话正文存在 `data/chat/<日期>-<时间>-<随机>.md`，**会被 git 备份**——

> ⚠️ **注意**：如果你会用这个 AI 页聊敏感内容，它会被提交到 git。
> 想排除的话，把 `data/chat/` 加进 `.gitignore` 即可。

对话文件长这样，可 grep、可用编辑器打开：

```markdown
---
title: "注意力机制是什么"
model: deepseek-chat
createdAt: '2026-09-24T13:00:12.000Z'
updatedAt: '2026-09-24T13:00:41.000Z'
---

---

## 数据存在哪

```
data/
├── daily/2026-09-24.md         # 一天一篇，块的分类/标签存在 frontmatter
├── recommend/2026-09/2026-09-24.json   # 每日推荐快照（永久留档，可回看）
├── recommend/state.json        # 值得看/已看完/收藏 标记
└── profile.json                # 昵称与简介
```

`data/daily/2026-09-24.md` 长这样，**用任何编辑器直接打开都能读**：

```markdown
---
date: 2026-09-24
blocks:
  - id: k3f9a2
    category: memory
    tags: [英语, 单词]
    order: 0
  - id: p8x1m4
    category: writing
    tags: [Transformer]
    order: 1
  - id: q2w3e4
    category: writing
    tags: []
    order: 2
---

---

## 关键设计决定

这些都是需求拷问阶段逐条确认的，改动前请先想清楚代价：

1. **只绑 `127.0.0.1`，不做登录**。代码里留了 `requireAuth` 钩子（`server/index.mjs`），
   哪天要开局域网访问，改 `HOST` 并打开钩子即可。
2. **文件是唯一真相来源**，没有数据库。搜索用启动时构建的内存索引，写盘后增量更新。
   好处是十年后仍能用任意工具打开；代价是全文搜索是内存里扫，不是 SQL。
3. **分类是固定枚举**（记忆类 / 纯写类），**标签自由**。
   分类挂在「块」上而不是「天」上，所以一天里可以既有记忆类又有纯写类。
4. **每次保存自动 git 提交**，但只 `git add data/`——不用 `git add -A`，
   避免把源码 WIP 或误建的密钥文件顺手提交上去。提交失败不影响保存。
   同一份数据的**连续改动会合并进同一个提交**（10 分钟窗口内）：否则
   记一条笔记就会产生 7 个提交、点几次收藏又十几个，一年下来几千个无意义提交。
   合并只在「上一次提交确是本进程为同一份数据所做、且仍是 HEAD」时进行，
   绝不 amend 外部提交（详见 `server/git.mjs` 与 `npm run test:git`）。
5. **推荐当天首次打开抓一次**，之后读本地快照；`?refresh=1` 强制重抓。
6. **不用登录，但会联外网**：页面一抓 GitHub / V2EX / 掘金 / Hacker News 的公开接口，
   **不需要任何密钥**。你的笔记本身不会离开这台机器。

---

## 踩过的坑（改代码前值得看）

- **不需要 GitHub Token**：未认证的 Search API 限速 10 次/分钟，一天一轮只打 2~4 次，够用。
- **抓取只能用 Node 的 `fetch`**：本机装了系统代理（`127.0.0.1:7897`），
  PowerShell 的 `Invoke-WebRequest` 会因它失败，Node 的 fetch 不受影响。
- **掘金接口必须用 POST**：GET 同地址会返回空体；POST 要带
  `id_type/client_type/sort_type` 才出数据。
- **这些数据源已实测放弃，别再试**：X/Twitter（免费层不能读时间线、RSSHub twitter 路由 404、
  7 个 Nitter 实例全挂、官方 oEmbed 404）、知乎（热榜 401、RSS 0 字节）、微博热搜（403）、
  CSDN（RSS 404）、小红书（需登录）、36氪（200 但 0 条目）。
- **改了数据源字段要全项目搜一遍**：把 `papers` 换成 `v2ex/juejin` 时，
  `scripts/prewarm.mjs` 的日志还在访问 `data.papers.length`，导致抓取成功但脚本报错退出。
- **测试脚本别再往真实仓库里 commit**：`scripts/smoke.mjs` 会往真实 `data/daily/`
  写临时文件，若它自己还执行 `git commit`，就会把测试提交塞进你的历史（实测发生过）。
  现在它只删文件，并在收尾时用 `git reset --soft` 摘掉测试期间产生的提交；
  提交/合并逻辑改由 `scripts/test-git-commit.mjs` 在**隔离仓库**（`GIT_REPO_ROOT`）里验证。
- **别用 `git checkout -- .` 清理工作区**：它会把未提交的源码改动一起还原掉
  （这次就这么丢过 4 个文件的重写，只能重做）。要么先 `git stash`，要么只对具体文件操作。
- **GitHub 推荐不能用 `pushed:>N` + `sort=stars`**：那样选出来的是历史总榜
  （20 万 star 的老项目）。必须用 `created:>N`（近期创建）并设 star 上限。
- **esbuild 的临时目录要钉在项目内**（`web/vite.config.mjs` 里设 `TMPDIR`）：
  默认写系统 TEMP，受限环境里会出现 `remove ...\Temp\esbuild-xxxx: Access is denied`。
- **`npm install` 用 `--ignore-scripts` 可绕过受限环境的 `spawn EPERM`**，
  纯 JS 依赖不需要生命周期脚本。项目内放 `.npm-cache/` 以避开全局缓存权限问题。

---

## 技术栈

Vue 3 + Vite（前端）· Hono + Node 22（后端）· Milkdown Crepe（所见即所得 Markdown 编辑器）·
gray-matter（frontmatter）· 无数据库、无登录、无密钥。

---

**隐私提醒**：本仓库若推送到 GitHub，请确保是 **private** 仓库——
`data/` 里是你的全部学习记录，而 git 历史是永久的。
`.gitignore` 已排除 `.env`、`*.key`、`.credentials*`、`token.json` 等密钥类文件。
