/**
 * 把 .cmd 批处理文件规范化：**UTF-8（无 BOM）+ CRLF 行尾**。
 *
 * 为什么这两点都必须对（都是实测踩出来的）：
 *  1. **行尾必须 CRLF**。.cmd 用 LF 行尾时 cmd.exe 会解析错乱——
 *     表现为 "'tlocal' is not recognized"、"'i\"' is not recognized" 这种
 *     看起来毫不相干的报错（实际是行被切错拼到下一行）。这是最隐蔽的一个。
 *  2. **编码用 UTF-8 时必须在脚本开头 `chcp 65001`**；否则中文会乱。
 *     （另一种选择是存成 GBK 并去掉 chcp，但本项目的 .cmd 统一用 UTF-8+chcp。）
 *
 * 本项目共有三个"文件编码/行尾必须匹配读取方"的坑：
 *   - .vbs  → UTF-16LE(BOM)   （cscript 按 ANSI 读，否则中文路径解析坏）
 *   - .ps1  → UTF-8 with BOM  （PowerShell 5.1 按本地代码页读）
 *   - .cmd  → UTF-8 + CRLF    （cmd.exe；行尾不对会语句错乱）
 *
 * 用法：node scripts/fix-cmd-encoding.mjs [文件...]（缺省处理几个已知的 .cmd）
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_FILES = ['打开DSH.cmd', '学习记录本(显示日志).cmd']

const files = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_FILES

for (const f of files) {
  const abs = path.resolve(ROOT, f)
  if (!existsSync(abs)) {
    console.log(`跳过（不存在）：${f}`)
    continue
  }

  // 1) 解码：先试 UTF-8，若含替换字符则按 GBK(936) 解回来
  let text = readFileSync(abs, 'utf8')
  if (text.includes('\uFFFD')) {
    const ps = [
      `$p = '${abs.replace(/'/g, "''")}'`,
      '$gbk = [System.Text.Encoding]::GetEncoding(936)',
      '$txt = $gbk.GetString([System.IO.File]::ReadAllBytes($p))',
      "[System.IO.File]::WriteAllText($p, $txt, (New-Object System.Text.UTF8Encoding($false)))",
      "Write-Output 'ok'",
    ].join('; ')
    execFileSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8' })
    text = readFileSync(abs, 'utf8')
    console.log(`  ${f}: 检测到 GBK，已转回 UTF-8`)
  }

  // 2) 行尾统一为 CRLF
  text = text.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n')

  // 3) 以 UTF-8 无 BOM 写回
  writeFileSync(abs, text, 'utf8')

  const b = readFileSync(abs)
  const crlf = (b.toString('latin1').match(/\r\n/g) ?? []).length
  const lf = (b.toString('latin1').match(/\n/g) ?? []).length
  const bom = b[0] === 0xEF && b[1] === 0xBB && b[2] === 0xBF
  const chcp = /chcp\s+65001/i.test(text)
  console.log(
    `  ${f}: ${b.length} 字节 | CRLF ${crlf}/${lf} ${crlf === lf ? '✓' : '⚠'} | ` +
      `${bom ? '⚠ 有 BOM' : '无 BOM ✓'} | chcp 65001 ${chcp ? '✓' : '（无中文则不需要）'}`,
  )
}
