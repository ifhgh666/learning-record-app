/**
 * 校验 README 里写的启动说明与实际代码是否一致。
 * 文档和代码不符比没文档更糟，所以逐项核对。
 */
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const readme = readFileSync(path.join(ROOT, 'README.md'), 'utf8')
const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
const startSrc = readFileSync(path.join(ROOT, 'scripts', 'start.mjs'), 'utf8')
const indexSrc = readFileSync(path.join(ROOT, 'server', 'index.mjs'), 'utf8')

let pass = 0
let fail = 0
const check = (name, cond, detail = '') => {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`) }
  else { fail += 1; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`) }
}

console.log('\nREADME 与实际代码的一致性校验\n')

// 1) 启动命令
check('README 写了 npm install', readme.includes('npm install'))
check('README 写了 npm start', readme.includes('npm start'))
check('package.json 里确实有 start 脚本', Boolean(pkg.scripts.start))

// 2) 端口与访问地址
const portMatch = /http:\/\/127\.0\.0\.1:(\d+)/.exec(readme)
const readmePort = portMatch?.[1]
check('README 里的端口与代码一致', readmePort === '3777', `README=${readmePort}`)
check('server 默认端口是 3777', /PORT\s*=\s*Number\(process\.env\.PORT \?\? 3777\)/.test(indexSrc))
check('server 只绑定 127.0.0.1', /HOST\s*=\s*'127\.0\.0\.1'/.test(indexSrc))

// 3) 启动成功时的输出文案（README 里引用了它）
const banner = /学习记录本已启动/.exec(indexSrc)?.[0]
check('代码里的启动提示与 README 引用的一致', Boolean(banner) && readme.includes('学习记录本已启动'))

// 4) 首次构建行为（README 说"首次约 10 秒"）
check('start.mjs 在前端未构建时会自动构建', startSrc.includes('buildFrontend') && startSrc.includes('distIndex'))

// 5) Node 版本要求
check('README 的 Node 要求与 engines 一致',
  readme.includes('20.19') && pkg.engines?.node === '>=20.19',
  `README含20.19=${readme.includes('20.19')} engines=${pkg.engines?.node}`)

// 6) 停止服务的方式
check('README 提到的 stop-server.mjs 存在', existsSync(path.join(ROOT, 'scripts', 'stop-server.mjs')))
check('README 提到 Ctrl+C 关闭', readme.includes('Ctrl + C') || readme.includes('Ctrl+C'))

// 7) 可选配置里引用的文件
check('samples/quotes.example.json 存在', existsSync(path.join(ROOT, 'samples', 'quotes.example.json')))
check('make-shortcut.ps1 存在', existsSync(path.join(ROOT, 'scripts', 'make-shortcut.ps1')))

// 8) 截图引用
const shots = [...readme.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)].map((m) => m[1])
check(`README 引用的 ${shots.length} 张截图都存在`, shots.every((s) => existsSync(path.join(ROOT, s))),
  shots.filter((s) => !existsSync(path.join(ROOT, s))).join(', '))

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`)
process.exit(fail ? 1 : 0)
