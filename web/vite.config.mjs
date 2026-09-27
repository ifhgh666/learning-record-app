import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdirSync } from 'node:fs'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')

// esbuild 默认把临时文件写到系统 TEMP（Windows 是 %LOCALAPPDATA%\Temp）。
// 在受限环境里那个目录可能不可写/不可删，导致
// "[vite:esbuild-transpile] remove ...\Temp\esbuild-xxxx: Access is denied"。
// 把临时目录钉在项目内，构建就不再依赖系统 TEMP 的权限。
const tmpDir = path.join(root, '.tmp')
mkdirSync(tmpDir, { recursive: true })
process.env.TMPDIR = tmpDir
process.env.TMP = tmpDir
process.env.TEMP = tmpDir

export default defineConfig({
  root: here,
  plugins: [vue()],
  resolve: {
    alias: { '@': here },
  },
  build: {
    outDir: path.join(root, 'dist'),
    emptyOutDir: true,
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    // 开发时前端 5173、后端 3777；把 /api 代理过去，避免跨域与端口写死
    proxy: {
      '/api': { target: 'http://127.0.0.1:3777', changeOrigin: false },
    },
  },
})
