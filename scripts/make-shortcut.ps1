# 在桌面创建「学习记录本」快捷方式（可重复执行，会覆盖旧的）
#
# 路径全部自动推导，不写死绝对路径：项目挪到哪、换台机器都能用。
#
# 注意：本文件必须保存为 **UTF-8 with BOM**，否则 Windows PowerShell 5.1
# 会按本地 ANSI 代码页解码，中文字符串会乱（实测踩过这个坑）。
$ErrorActionPreference = 'Stop'

# 本脚本位于 <项目根>\scripts\，所以项目根是它的上一级
$projectDir = Split-Path -Parent $PSScriptRoot
$desktop    = [Environment]::GetFolderPath('Desktop')
$sh         = New-Object -ComObject WScript.Shell

$target = Join-Path $projectDir '学习记录本.vbs'
if (-not (Test-Path -LiteralPath $target)) {
    Write-Error "找不到启动器：$target`n请确认项目根目录下存在「学习记录本.vbs」。"
}

# 走 .vbs 包装：隐藏启动本地服务，等服务真就绪再自动打开浏览器，不弹黑窗
$lnkPath = Join-Path $desktop '学习记录本.lnk'
$lnk = $sh.CreateShortcut($lnkPath)
$lnk.TargetPath       = $target
$lnk.WorkingDirectory = $projectDir
$lnk.IconLocation     = 'C:\Windows\System32\shell32.dll,1'
$lnk.Description      = '打开本机私有的学习记录本'
$lnk.Save()

Write-Output "OK $lnkPath"
