import fs from 'node:fs';
import path from 'node:path';
import { post } from './export.mjs';

const NC_ROOT = process.env.NC_ROOT || process.cwd();
const BASE_OUT = path.join(NC_ROOT, 'out2');
const STAGE_DIR = path.join(BASE_OUT, 'staging');
const USE_STAGE = process.env.NC_STAGE === '1' || fs.existsSync(path.join(STAGE_DIR, 'playlists_full.json'));
const OUT = USE_STAGE ? STAGE_DIR : BASE_OUT;
const DEST = process.env.NC_DEST || path.join(process.cwd(), '导出');
const JSONF = path.join(OUT, 'collected_albums.json');
const COV = path.join(OUT, 'covers.json');
const mode = process.argv[2] || 'sync';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const one = s => String(s || '').replace(/\s+/g, ' ').trim();
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

async function retry(fn, n = 3) {
  for (let i = 0; i < n; i++) {
    try { const r = await fn(); if (r && r.code === 200) return r; if (i === n - 1) return r; }
    catch (e) { if (i === n - 1) throw e; }
    await sleep(800 * (i + 1));
  }
}
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}

/* ---------- 同步：抓收藏专辑 ---------- */
async function syncAlbums() {
  const acc = await retry(() => post('/weapi/w/nuser/account/get'));
  if (acc?.code !== 200 || !acc?.account) { console.error('登录失效'); process.exit(2); }
  const nick = acc.profile?.nickname || '';
  const all = [];
  for (let offset = 0; ; offset += 25) {
    const r = await retry(() => post('/weapi/album/sublist', { limit: 25, offset, total: true }));
    const data = r?.data || r?.albums || [];
    all.push(...data);
    if (!r?.hasMore || !data.length) break;
    await sleep(150);
  }
  const uniq = new Map();
  for (const a of all) if (!uniq.has(a.id)) uniq.set(a.id, a);
  const list = [...uniq.values()];
  log(`收藏专辑 ${list.length} 张，抓取详情…`);

  const details = await mapLimit(list, 5, async a => {
    const r = await retry(() => post('/weapi/v1/album/' + a.id, {}));
    const d = r?.album || {};
    await sleep(80);
    return {
      id: String(a.id),
      name: one(d.name) || one(a.name),
      artists: (d.artists || a.artists || []).map(x => one(x.name)).join(' / '),
      company: d.company || '',
      publishTime: d.publishTime || 0,
      size: d.size || (d.songs || []).length,
      picUrl: d.picUrl || '',
      songs: (d.songs || []).map(s => ({ name: one(s.name), ar: (s.ar || []).map(x => one(x.name)).join(' / ') })),
    };
  });

  fs.writeFileSync(JSONF, JSON.stringify(details));
  const cov = fs.existsSync(COV) ? JSON.parse(fs.readFileSync(COV, 'utf8')) : {};
  cov.albums = { ...(cov.albums || {}) };
  for (const d of details) if (d.picUrl) cov.albums[d.id] = d.picUrl;
  fs.writeFileSync(COV, JSON.stringify(cov));
  const withCover = details.filter(d => d.picUrl).length;
  const withCompany = details.filter(d => d.company).length;
  log(`收藏同步完成：${details.length} 张，封面 ${withCover}，厂牌 ${withCompany}（账号 ${nick}）`);
}

/* ---------- 整理：从 JSON 生成文档 ---------- */
function tidyAlbums() {
  if (!fs.existsSync(JSONF)) { console.error('缺少 collected_albums.json，先跑收藏同步'); process.exit(3); }
  const list = JSON.parse(fs.readFileSync(JSONF, 'utf8'));
  const fmtDate = ts => { if (!ts) return '—'; const d = new Date(ts), p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };
  const esc = v => String(v || '').replace(/\|/g, '\\|');
  const L = [
    '# 收藏的专辑', '',
    `- 数量：${list.length} 张`,
    `- 有厂牌：${list.filter(a => a.company).length} 张`,
    `- 更新时间：${new Date().toLocaleString('zh-CN', { hour12: false })}`,
    '',
    '| # | 专辑 | 艺人 | 曲目 | 发行公司 | 发行时间 | 链接 |',
    '| --- | --- | --- | --- | --- | --- | --- |',
  ];
  list.forEach((a, i) => L.push(`| ${i + 1} | ${esc(a.name)} | ${esc(a.artists)} | ${a.size} | ${esc(a.company) || '未标注'} | ${fmtDate(a.publishTime)} | https://music.163.com/album?id=${a.id} |`));
  L.push('', '## 专辑曲目', '');
  for (const a of list) {
    if (!a.songs?.length) continue;
    L.push(`### ${a.name}${a.artists ? ' - ' + a.artists : ''}（${a.company || '未标注厂牌'}）`, '');
    a.songs.forEach((s, i) => L.push(`${i + 1}. ${s.name} - ${s.ar || a.artists || '未知'}`));
    L.push('');
  }
  fs.mkdirSync(path.join(OUT, '收藏'), { recursive: true });
  fs.writeFileSync(path.join(OUT, '收藏/01_收藏专辑.md'), L.join('\n'));

  const csv = ['收藏序号,专辑,艺人,曲目数,发行公司,发行时间,专辑ID'];
  list.forEach((a, i) => csv.push([i + 1, a.name, a.artists, a.size, a.company, fmtDate(a.publishTime), a.id].map(v => `"${String(v || '').replace(/"/g, '""')}"`).join(',')));
  fs.mkdirSync(path.join(OUT, '表格'), { recursive: true });
  fs.writeFileSync(path.join(OUT, '表格/albums.csv'), '\ufeff' + csv.join('\n'));
  log(`收藏整理完成：md + csv（${list.length} 张）`);
}

/* ---------- 核验 ---------- */
function checkAlbums() {
  const issues = [];
  if (!fs.existsSync(JSONF)) { console.log('[FAIL] collected_albums.json 缺失'); process.exit(1); }
  const list = JSON.parse(fs.readFileSync(JSONF, 'utf8'));
  const md = fs.existsSync(path.join(OUT, '收藏/01_收藏专辑.md')) ? fs.readFileSync(path.join(OUT, '收藏/01_收藏专辑.md'), 'utf8') : '';
  const mdRows = md.split('\n').filter(l => /^\| \d+ \|/.test(l)).length;
  const csvRows = fs.existsSync(path.join(OUT, '表格/albums.csv')) ? fs.readFileSync(path.join(OUT, '表格/albums.csv'), 'utf8').trim().split('\n').length - 1 : 0;
  const ids = new Set(list.map(a => a.id));
  const dup = list.length - ids.size;
  const noCover = list.filter(a => !a.picUrl).length;
  const noCompany = list.filter(a => !a.company).length;
  const noSongs = list.filter(a => !a.songs || !a.songs.length).length;

  const add = (name, ok, detail) => { console.log(`${ok ? '[PASS]' : '[FAIL]'} ${name}｜${detail}`); if (!ok) issues.push(name); };
  add('专辑数量与 md 一致', mdRows === list.length, `JSON ${list.length} / md ${mdRows}`);
  add('专辑数量与 csv 一致', csvRows === list.length, `JSON ${list.length} / csv ${csvRows}`);
  add('无重复专辑', dup === 0, dup ? `${dup} 条重复` : '无重复');
  add('封面覆盖', true, `${list.length - noCover} / ${list.length} 有封面`);
  add('厂牌覆盖', true, `${list.length - noCompany} / ${list.length} 有厂牌`);
  add('曲目列表', true, `网易专辑接口当前不返回曲目（${list.length - noSongs}/${list.length} 张有曲目数据），此项仅作信息展示`);
  console.log('');
  console.log(`问题合计 ${issues.length}`);
  if (issues.length) process.exit(1);
  else console.log('收藏数据全部通过');
}

if (mode === 'sync') await syncAlbums();
else if (mode === 'tidy') tidyAlbums();
else if (mode === 'check') checkAlbums();
else { console.error('用法: node fav.mjs sync|tidy|check'); process.exit(64); }
