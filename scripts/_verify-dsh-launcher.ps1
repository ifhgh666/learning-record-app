# 校验「打开DSH」这条链路（只做静态检查，不启动 DSH 实例）
#
# 为什么不实际启动：从 DSH 内部再起一个 DSH 会触发保护机制并破坏当前会话。
# 所以这里逐项验证「文件存在 / 快捷方式指向正确 / 命令参数正确」。
$ErrorActionPreference = 'Continue'

# 路径自动推导：本脚本在 <项目根>\scripts\ 下
$projectDir = Split-Path -Parent $PSScriptRoot
$desktop    = [Environment]::GetFolderPath('Desktop')
$sh         = New-Object -ComObject WScript.Shell

Write-Output '=== 1. 快捷方式属性 ==='
foreach ($name in @('打开DSH', '学习记录本')) {
    $lnkPath = Join-Path $desktop "$name.lnk"
    if (-not (Test-Path $lnkPath)) { Write-Output "  ✗ $name.lnk 不存在"; continue }
    $l = $sh.CreateShortcut($lnkPath)
    Write-Output "  [$name]"
    Write-Output "    目标:     $($l.TargetPath)"
    Write-Output "    工作目录: $($l.WorkingDirectory)"
    Write-Output "    目标存在: $(Test-Path $l.TargetPath)"
}

Write-Output ''
Write-Output '=== 2. 启动链路的文件是否齐全 ==='
$chain = @(
    '打开DSH.vbs',
    '打开DSH.cmd',
    '学习记录本.vbs',
    'scripts\start.mjs',
    'scripts\launch.mjs',
    'scripts\stop-server.mjs'
)
foreach ($f in $chain) {
    $p = Join-Path $projectDir $f
    Write-Output ("  {0} {1}" -f $(if (Test-Path $p) { '[OK]' } else { '[缺失]' }), $f)
}

Write-Output ''
Write-Output '=== 3. dsh 入口是否可被找到（模拟 .cmd 里的查找逻辑）==='
$globalRoot = (npm root -g 2>$null)
$globalEntry = Join-Path $globalRoot '@deepseek-ai\dsh\lib\bin.js'
Write-Output "  全局 npm 根: $globalRoot"
Write-Output "  全局入口:    $globalEntry"
Write-Output "  是否存在:    $(Test-Path $globalEntry)"

$cacheRoot = Join-Path (npm config get cache 2>$null) '_npx'
Write-Output "  npx 缓存根:  $cacheRoot"
$found = @()
if (Test-Path $cacheRoot) {
    Get-ChildItem $cacheRoot -Directory | ForEach-Object {
        $e = Join-Path $_.FullName 'node_modules\@deepseek-ai\dsh\lib\bin.js'
        if (Test-Path $e) { $found += $e }
    }
}
Write-Output "  npx 缓存里找到的入口:"
if ($found.Count -eq 0) { Write-Output '    （无）' } else { $found | ForEach-Object { Write-Output "    $_" } }

Write-Output ''
Write-Output '=== 4. 编码检查（这两个文件对编码敏感）==='
foreach ($f in @('打开DSH.vbs', 'scripts\make-shortcut.ps1')) {
    $p = Join-Path $projectDir $f
    $b = [System.IO.File]::ReadAllBytes($p)
    $head = ($b[0..2] | ForEach-Object { '{0:X2}' -f $_ }) -join ' '
    $expect = if ($f -like '*.vbs') { 'FF FE' } else { 'EF BB BF' }
    $okMark = if (($f -like '*.vbs' -and $b[0] -eq 0xFF -and $b[1] -eq 0xFE) -or
                   ($f -notlike '*.vbs' -and $b[0] -eq 0xEF -and $b[1] -eq 0xBB)) { '[OK]' } else { '[错误]' }
    Write-Output ("  {0} {1}  头部 {2}（期望 {3}）" -f $okMark, $f, $head, $expect)
}

Write-Output ''
Write-Output '=== 5. .cmd 里拼出的启动命令（预览，不执行）==='
$entry = if (Test-Path $globalEntry) { $globalEntry } elseif ($found.Count -gt 0) { $found[0] } else { '<未找到>' }
Write-Output "  cd /d `"$projectDir`""
Write-Output "  node `"$entry`" --profile web"

Write-Output ''
Write-Output '=== 6. 当前是否已有 DSH 在跑（双击前要注意）==='
$running = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -match '@deepseek-ai[\\/]dsh[\\/]lib[\\/]bin\.js' }
Write-Output "  正在运行的 DSH 实例数: $($running.Count)"
$running | ForEach-Object { Write-Output "    PID $($_.ProcessId)" }
