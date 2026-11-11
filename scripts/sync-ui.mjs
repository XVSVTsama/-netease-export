#!/usr/bin/env node
// 把 PC 面板的样式同步给 Android 前端，保证两端视觉完全一致。
// 运行：node scripts/sync-ui.mjs（构建 APK 前由 beforeBuildCommand 自动调用）
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'web/public/style.css');
const dst = join(root, 'ui/style.css');
const head = '/* 自动生成：web/public/style.css → ui/style.css，请勿手改（改 web/public/style.css 后重新运行 npm run sync:ui） */\n';

const css = readFileSync(src, 'utf8');
mkdirSync(dirname(dst), { recursive: true });
writeFileSync(dst, head + css);
console.log('synced ui/style.css ← web/public/style.css (' + css.length + ' bytes)');
