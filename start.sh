#!/bin/sh
cd "$(dirname "$0")"
command -v node >/dev/null 2>&1 || { echo "需要 Node.js 20+：https://nodejs.org"; exit 1; }
[ -d node_modules ] || npm install --no-audit --no-fund
[ -f accounts.json ] || cp accounts.example.json accounts.json
echo "面板地址 http://127.0.0.1:8788"
node web/server.mjs
