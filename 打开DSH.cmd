@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion

rem ============================================================
rem  打开 DeepSeek Harness（我）
rem
rem  ? 这个脚本不能从 DSH 内部测试执行：从 DSH 里再起一个 DSH 会触发
rem     保护机制并破坏当前会话。所以启动链路的验证方式是静态检查
rem     （入口文件存在性、参数拼接、快捷方式指向），见
rem     scripts/_verify-dsh-launcher.ps1。
rem
rem  找出 dsh 入口并按优先级尝试：
rem     1) 全局安装（npm root -g）—— 最稳定
rem     2) npx 缓存（npm config get cache\_npx\*）—— 当前机器走这条
rem     3) 都没有 → 交给 npx 现场下载（最慢但一定能用）
rem ============================================================

rem 在脚本所在目录打开（也是 DSH 里显示的当前工作目录）。
rem 用 %~dp0 自动推导，不写死绝对路径：换台机器/换目录都能用，
rem 也不会把本机用户名暴露出去。
set "DSH_WORKDIR=%~dp0"
if "%DSH_WORKDIR:~-1%"=="\" set "DSH_WORKDIR=%DSH_WORKDIR:~0,-1%"
if not exist "%DSH_WORKDIR%" set "DSH_WORKDIR=%USERPROFILE%"

rem --- 先把两个候选根目录算出来（不要在同一个括号块里"设了就用"，
rem     延迟展开在括号块内会拿到旧值，这是个经典坑）---
set "GLOBAL_ROOT="
for /f "delims=" %%i in ('npm root -g 2^>nul') do set "GLOBAL_ROOT=%%i"

set "NPX_ROOT="
for /f "delims=" %%i in ('npm config get cache 2^>nul') do set "NPX_ROOT=%%i\_npx"

set "ENTRY="

rem --- 1) 全局安装 ---
if defined GLOBAL_ROOT (
  if exist "!GLOBAL_ROOT!\@deepseek-ai\dsh\lib\bin.js" (
    set "ENTRY=!GLOBAL_ROOT!\@deepseek-ai\dsh\lib\bin.js"
  )
)

rem --- 2) npx 缓存（逐个目录找，找到就停）---
if not defined ENTRY (
  if defined NPX_ROOT (
    if exist "!NPX_ROOT!" (
      for /d %%d in ("!NPX_ROOT!\*") do (
        if not defined ENTRY (
          if exist "%%~fd\node_modules\@deepseek-ai\dsh\lib\bin.js" (
            set "ENTRY=%%~fd\node_modules\@deepseek-ai\dsh\lib\bin.js"
          )
        )
      )
    )
  )
)

rem --- 3) 兜底：交给 npx 下载启动 ---
if not defined ENTRY (
  echo.
  echo   缓存里没找到 DSH，改用 npx 现场下载 ^(首次会慢一些^) …
  echo.
  cd /d "%DSH_WORKDIR%"
  npx -y @deepseek-ai/dsh@alpha --profile web %*
  echo.
  echo   DSH 已退出。
  pause
  exit /b 0
)

echo.
echo   正在打开 DeepSeek Harness …
echo   启动目录：%DSH_WORKDIR%
echo   入口：!ENTRY!
echo.
echo   这个窗口是 DSH 的服务进程，用完直接关掉它即可退出。
echo   （最小化不影响使用）
echo.

cd /d "%DSH_WORKDIR%"
node "!ENTRY!" --profile web %*

echo.
echo   DSH 已退出。
endlocal
