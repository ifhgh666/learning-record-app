# 在桌面创建两个快捷方式（可重复执行，会覆盖旧的）：
#   「打开DSH」    —— 打开 DeepSeek Harness（我）
#   「学习记录本」 —— 打开本机的学习记录网站
#
# 路径全部自动推导，不写死绝对路径：项目挪到哪、换台机器都能用。
# 注意：本文件必须保存为 **UTF-8 with BOM**，否则 Windows PowerShell 5.1
# 会按本地 ANSI 代码页解码，中文字符串会乱（实测踩过这个坑）。
$ErrorActionPreference = 'Stop'

# 本脚本位于 <项目根>\scripts\，所以项目根是它的上一级
$projectDir = Split-Path -Parent $PSScriptRoot
$desktop    = [Environment]::GetFolderPath('Desktop')
$sh         = New-Object -ComObject WScript.Shell

function New-DesktopShortcut {
    param(
        [string]$Target,     # 快捷方式指向的文件
        [string]$LinkName,   # 桌面上的名字（不含 .lnk）
        [string]$Icon,       # 图标来源
        [string]$Desc
    )
    if (-not (Test-Path -LiteralPath $Target)) {
        Write-Warning "跳过（目标不存在）：$Target"
        return
    }
    $lnkPath = Join-Path $desktop "$LinkName.lnk"
    $lnk = $sh.CreateShortcut($lnkPath)
    $lnk.TargetPath       = $Target
    $lnk.WorkingDirectory = $projectDir
    $lnk.IconLocation     = $Icon
    $lnk.Description      = $Desc
    $lnk.Save()
    Write-Output "OK $lnkPath"
}

# 「打开DSH」→ 走 .vbs 包装，最小化启动，不弹黑窗挡屏
New-DesktopShortcut `
    -Target   (Join-Path $projectDir '打开DSH.vbs') `
    -LinkName '打开DSH' `
    -Icon     'C:\Windows\System32\shell32.dll,13' `
    -Desc     '打开 DeepSeek Harness（本机 Web 界面）'

# 「学习记录本」→ 走 .vbs 包装，隐藏启动本地服务并自动开浏览器
New-DesktopShortcut `
    -Target   (Join-Path $projectDir '学习记录本.vbs') `
    -LinkName '学习记录本' `
    -Icon     'C:\Windows\System32\shell32.dll,1' `
    -Desc     '打开本机私有的学习记录本'
