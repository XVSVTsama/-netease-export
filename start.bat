@echo off
cd /d %~dp0
where node >nul 2>nul
if errorlevel 1 (
  echo 需要 Node.js 20+：https://nodejs.org
  pause
  exit /b 1
)
if not exist node_modules call npm install --no-audit --no-fund
if not exist accounts.json copy accounts.example.json accounts.json
echo 面板地址 http://127.0.0.1:8788
node web\server.mjs
pause
