import fs from 'node:fs';
import path from 'node:path';

const NC_ROOT = process.env.NC_ROOT || process.cwd();
const BASE = path.join(NC_ROOT, 'out2');
const STAGE = path.join(BASE, 'staging');
const DATA_FILES = ['playlists_full.json', 'albums_cache.json', 'covers.json', 'collected_playlists.json', 'collected_albums.json', 'created_albums.json', 'ranking.json'];
const mode = process.argv[2] || 'init';
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

if (mode === 'init') {
  if (fs.existsSync(STAGE)) fs.rmSync(STAGE, { recursive: true, force: true });
  fs.mkdirSync(STAGE, { recursive: true });
  let copied = 0;
  for (const f of DATA_FILES) {
    const src = path.join(BASE, f);
    if (fs.existsSync(src)) { fs.copyFileSync(src, path.join(STAGE, f)); copied++; }
  }
  const hist = path.join(BASE, 'history');
  if (fs.existsSync(hist)) { fs.cpSync(hist, path.join(STAGE, 'history'), { recursive: true }); copied++; }
  log(`暂存区已初始化（${copied} 项基线数据复制）→ out2/staging`);
} else if (mode === 'commit') {
  if (!fs.existsSync(path.join(STAGE, 'playlists_full.json'))) {
    console.error('暂存区缺少 playlists_full.json，拒绝提交');
    process.exit(3);
  }
  let moved = 0;
  const entries = fs.readdirSync(STAGE);
  for (const name of entries) {
    const src = path.join(STAGE, name);
    const dst = path.join(BASE, name);
    if (fs.existsSync(dst)) fs.rmSync(dst, { recursive: true, force: true });
    fs.renameSync(src, dst);
    moved++;
  }
  fs.rmSync(STAGE, { recursive: true, force: true });
  log(`已提交：${moved} 项从暂存区提升为正式数据，暂存区已删除`);
} else if (mode === 'discard') {
  if (fs.existsSync(STAGE)) { fs.rmSync(STAGE, { recursive: true, force: true }); log('暂存区已丢弃'); }
  else log('没有暂存区');
} else {
  console.error('用法: node stage.mjs init|commit|discard');
  process.exit(64);
}
