#!/data/data/com.termux/files/usr/bin/bash
# Termux 一键安装并启动
set -e
cd "$(dirname "$0")"
echo "== 安装 Node.js =="
pkg update -y >/dev/null 2>&1 || true
pkg install -y nodejs-lts || pkg install -y nodejs
echo "== 安装依赖（首次约 1-2 分钟）=="
npm install --no-audit --no-fund
[ -f accounts.json ] || cp accounts.example.json accounts.json
echo "== 启动面板：http://127.0.0.1:8788 =="
node web/server.mjs
