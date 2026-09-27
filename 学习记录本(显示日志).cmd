@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo 正在启动学习记录本（显示日志，便于排查问题）...
echo 关闭这个窗口可能同时结束服务。
echo.
node scripts\start.mjs
echo.
echo 服务已退出。
pause
