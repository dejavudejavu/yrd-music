@echo off
chcp 65001 >nul
cd /d "%~dp0"
title yrd音乐站 - yrd Music

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo [错误] 未检测到 Node.js，请先安装 Node.js 18 或更高版本：
  echo        https://nodejs.org/
  echo.
  pause
  exit /b 1
)

echo.
echo 正在启动 yrd音乐站...
echo.
node server.js %*
echo.
pause
