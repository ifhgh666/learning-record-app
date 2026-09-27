# 学习记录本

一个**只在自己电脑上运行**的私人学习记录工具。笔记、推荐、对话全部存在本地文件里，
不上传、不公开、不需要登录。

## 主要页面

左侧导航有四个入口：今日推荐、学习记录、AI 对话、我的。

### 今日推荐

每天自动挑一个近期活跃的 GitHub 项目，外加 V2EX 热门讨论、掘金推荐文章、
Hacker News 最佳文章。可以标记「值得看 / 已看完」，也可以收藏。

![今日推荐](docs/screenshots/recommend.png)

### 学习记录

一天一篇笔记，按「学到的点」分块。每块自己选分类（记忆类 / 纯写类）、自己打标签，
块内是想怎么写就怎么写的富文本（支持代码块、表格、链接）。改动会自动保存。

![学习记录](docs/screenshots/notes.png)

### AI 对话

一个仿 DeepSeek 的聊天页：左边是对话列表，右边边收边显示回复。
对话会存成 Markdown 文件，可以直接用编辑器打开。需要自己的 DeepSeek API Key。

![AI 对话](docs/screenshots/chat.png)

### 我的

看连续记录天数（今天没写不算断，避免早上打开就看到归零）、本周写了哪几天、
个人档案（昵称会显示在右侧壁纸栏的问候里），以及最近记录和收藏的仓库。

![我的](docs/screenshots/profile.png)

「我的」下面还有两个子页：

**记录** —— 检索写过的内容：按关键词全文搜索，也可以按分类、标签、时间范围筛。

![记录](docs/screenshots/records.png)

**壁纸** —— 读取本机 Wallpaper Engine 已订阅的壁纸（Steam 创意工坊），
把预览图显示在页面右侧独立一栏，可调栏宽、图片大小和亮度。

![壁纸](docs/screenshots/wallpaper.png)

## 怎么启动

需要先装 [Node.js](https://nodejs.org/)（22 或更高版本）。

```bash
npm install     # 首次运行，装依赖
npm start       # 启动，然后浏览器会自动打开 http://127.0.0.1:3777
```

就这样。`data/` 目录会在第一次写笔记时自动创建，不需要手动准备。

**想让壁纸栏显示名言**，复制一份示例名言库即可（可选）：

```bash
mkdir data
copy samples\quotes.example.json data\quotes.json
```

**想用 AI 对话**，需要在页面里填一次 DeepSeek API Key（「AI 对话 → 设置」），
或启动前设置环境变量 `DEEPSEEK_API_KEY`。Key 只存在本机，不会进 git。

### 用桌面图标启动（可选）

每次开终端确实麻烦，可以让它变成一个双击就能开的图标：

```bash
powershell -ExecutionPolicy Bypass -File scripts/make-shortcut.ps1
```

会在桌面创建两个快捷方式：「学习记录本」（打开本工具）和「打开DSH」
（打开 DeepSeek Harness）。不需要的话跳过这一步，用 `npm start` 也一样。

## 数据存在哪

全部在项目下的 `data/` 目录里，都是普通文件，可以直接用编辑器打开或复制走：

```
data/
├── daily/2026-09-24.md     一天一篇笔记
├── chat/                   AI 对话
├── recommend/              每日推荐快照
├── quotes.json             名言库
├── profile.json            昵称与简介
└── ai.json                 DeepSeek API Key（不会提交到 git）
```

这个目录默认不纳入版本管理——它是你的私人内容，不该跟着代码走。

## 说明

- **只在本机运行**：服务只绑定 `127.0.0.1`，同网络的其他设备访问不到。
- **不需要任何密钥**：推荐内容来自 GitHub、V2EX、掘金、Hacker News 的公开接口。
  只有 AI 对话需要你自己的 DeepSeek Key。
- **数据不出本机**：笔记和对话都只写在你自己的磁盘上。

## 开发

```bash
npm run dev                    # 前端热更新 + 后端
npm run build                  # 构建前端
npm run check                  # 跑全部测试
node scripts/stop-server.mjs   # 停止服务
```

改动前建议先看一遍 `README.dev.md`，里面记着这个项目踩过的坑
（文件编码、行尾、测试污染数据之类）。
