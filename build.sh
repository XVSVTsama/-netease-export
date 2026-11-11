#!/bin/sh
# 兼容入口：实际实现已迁到纯 Node 的 build.mjs（Windows 同样可用）
# 用法：sh build.sh     或   node build.mjs
cd "$(dirname "$0")" || exit 1
exec node build.mjs "$@"
