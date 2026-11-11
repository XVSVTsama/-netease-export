import fs from 'node:fs';
import path from 'node:path';
import { post } from './export.mjs';

const NC_ROOT = process.env.NC_ROOT || process.cwd();
const BASE_OUT = path.join(NC_ROOT, 'out2');
const STAGE_DIR = path.join(BASE_OUT, 'staging');
const USE_STAGE = process.env.NC_STAGE === '1' || fs.existsSync(path.join(STAGE_DIR, 'playlists_full.json'));
const OUT = USE_STAGE ? STAGE_DIR : BASE_OUT;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const one = s => String(s || '').replace(/\s+/g, ' ').trim();
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const fmtDate = ts => { const d = new Date(ts), p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`; };

async function retry(fn, n = 3) {
  for (let i = 0; i < n; i++) {
    try {
      const r = await fn();
      if (r && r.code === 200) return r;
      if (i === n - 1) return r;
    } catch (e) { if (i === n - 1) throw e; }
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

const acc = await retry(() => post('/weapi/w/nuser/account/get'));
const uid = acc.account.id;
const nick = acc.profile?.nickname || '';

const albumCache = new Map();
async function albumInfo(id) {
  if (albumCache.has(id)) return albumCache.get(id);
  const r = await retry(() => post('/weapi/v1/album/' + id, {}));
  const a = r?.album || {};
  const info = {
    picUrl: a.picUrl || '',
    name: one(a.name),
    company: a.company || '',
    publishTime: a.publishTime || 0,
    artists: (a.artists || []).map(x => one(x.name)).join(' / '),
    desc: (a.description || '').trim(),
    size: a.size || (a.songs || []).length,
    songs: (a.songs || []).map(s => ({
      name: one(s.name),
      ar: (s.ar || []).map(x => one(x.name)).join(' / '),
    })),
  };
  albumCache.set(id, info);
  return info;
}

const CACHE_FILE = path.join(process.cwd(), 'out2/albums_cache.json');
const cache = fs.existsSync(CACHE_FILE) ? JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')) : {};
async function songLine(song) {
  const ar = (song.ar || []).map(x => one(x.name)).join(' / ');
  const al = song.al || {};
  return { name: one(song.name), ar, al: one(al.name), company: cache[String(al.id)]?.company || '' };
}

// ---------- 听歌排行 ----------
async function exportRank(type, label) {
  const r = await retry(() => post('/weapi/v1/play/record', { uid, type }));
  const data = (type === 0 ? r?.allData : r?.weekData) || [];
  if (!data.length) { log(`听歌排行(${label}) 为空`); return; }
  const rows = [];
  for (const it of data) {
    const line = await songLine(it.song || {});
    rows.push({ rank: rows.length + 1, playCount: it.playCount, dur: it.song?.dt || 0, ...line });
  }
  const L = [
    `# 听歌排行 · ${label}`,
    '',
    `- 账号：${nick}（uid ${uid}）`,
    `- 条目：${rows.length}（官方接口上限 100）`,
    `- 生成时间：${fmtDate(Date.now())}`,
    '',
    '| 排名 | 播放次数 | 歌名 | 制作人/团体 | 专辑 | 发行公司/厂牌 |',
    '| --- | --- | --- | --- | --- | --- |',
  ];
  for (const r2 of rows) L.push(`| ${r2.rank} | ${r2.playCount} | ${r2.name.replace(/\|/g, '\\|')} | ${r2.ar.replace(/\|/g, '\\|') || '未知'} | ${r2.al.replace(/\|/g, '\\|')} | ${r2.company.replace(/\|/g, '\\|') || '未标注厂牌'} |`);
  fs.mkdirSync(`${OUT}/排行与收藏`, { recursive: true });
  fs.mkdirSync(`${OUT}/排行与收藏`, { recursive: true });
  fs.writeFileSync(`${OUT}/排行与收藏/10_听歌排行_${label}.md`, L.join('\n'));
  // 落盘结构化数据，供纯本地重建
  const RKF = `${OUT}/ranking.json`;
  const rk = fs.existsSync(RKF) ? JSON.parse(fs.readFileSync(RKF, 'utf8')) : { generated: '', all: [], week: [] };
  rk[label === '全部时间' ? 'all' : 'week'] = rows.map(r => ({ rank: r.rank, playCount: r.playCount, name: r.name, ar: r.ar, al: r.al, company: r.company, dur: r.dur || 0 }));
  rk.generated = new Date().toISOString();
  fs.writeFileSync(RKF, JSON.stringify(rk));
  log(`听歌排行(${label}) ${rows.length} 条`);
}

// ---------- 收藏专辑 ----------
async function exportCollectedAlbums() {
  const all = [];
  for (let offset = 0; ; offset += 25) {
    const r = await retry(() => post('/weapi/album/sublist', { limit: 25, offset, total: true }));
    const data = r?.data || r?.albums || [];
    all.push(...data);
    if (!r?.hasMore || !data.length) break;
    await sleep(200);
  }
  const uniq = new Map();
  for (const a of all) if (!uniq.has(a.id)) uniq.set(a.id, a);
  const list = [...uniq.values()];
  log(`收藏专辑 ${list.length} 张，抓取详情…`);
  const details = await mapLimit(list, 5, async a => {
    const info = await albumInfo(a.id);
    await sleep(100);
    return { id: a.id, ...info };
  });
  const L = [
    `# 收藏的专辑`,
    '',
    `- 账号：${nick}（uid ${uid}）`,
    `- 数量：${details.length} 张`,
    `- 生成时间：${fmtDate(Date.now())}`,
    '',
    '| # | 专辑 | 艺人 | 曲目 | 发行公司 | 发行时间 | 链接 |',
    '| --- | --- | --- | --- | --- | --- | --- |',
  ];
  details.forEach((d, i) => {
    const t = d.publishTime ? new Date(d.publishTime).toISOString().slice(0, 10) : '—';
    L.push(`| ${i + 1} | ${(d.name || '').replace(/\|/g, '\\|')} | ${d.artists.replace(/\|/g, '\\|')} | ${d.size} | ${(d.company || '未标注').replace(/\|/g, '\\|')} | ${t} | https://music.163.com/album?id=${d.id} |`);
  });
  L.push('', '## 专辑曲目', '');
  for (const d of details) {
    if (!d.songs.length) continue;
    L.push(`### ${d.name}${d.artists ? ' - ' + d.artists : ''}（${d.company || '未标注厂牌'}）`, '');
    d.songs.forEach((s, i) => L.push(`${i + 1}. ${s.name} - ${s.ar || d.artists || '未知'}`));
    L.push('');
  }
  fs.mkdirSync(`${OUT}/排行与收藏`, { recursive: true });
  fs.writeFileSync(`${OUT}/排行与收藏/20_收藏专辑.md`, L.join('\n'));
  const csv = ['收藏序号,专辑,艺人,曲目数,发行公司,发行时间,专辑ID'];
  details.forEach((d, i) => csv.push([i + 1, d.name, d.artists, d.size, d.company, d.publishTime ? new Date(d.publishTime).toISOString().slice(0, 10) : '', d.id].map(v => `"${String(v || '').replace(/"/g, '""')}"`).join(',')));
  fs.mkdirSync(`${OUT}/表格`, { recursive: true });
  fs.writeFileSync(`${OUT}/collected_albums.json`, JSON.stringify(details.map(d => ({
    id: String(d.id), name: d.name, artists: d.artists, company: d.company,
    publishTime: d.publishTime, size: d.size, picUrl: d.picUrl,
    songs: d.songs,
  }))));
  // 合并封面到 covers.json
  const COV = `${OUT}/covers.json`;
  const cov = fs.existsSync(COV) ? JSON.parse(fs.readFileSync(COV, 'utf8')) : {};
  cov.albums = { ...(cov.albums || {}) };
  for (const d of details) if (d.picUrl) cov.albums[String(d.id)] = d.picUrl;
  fs.writeFileSync(COV, JSON.stringify(cov));
  fs.writeFileSync(`${OUT}/表格/albums.csv`, '\ufeff' + csv.join('\n'));
  log(`收藏专辑完成 ${details.length} 张`);
}

const mode = process.argv[2] || 'all';
fs.mkdirSync(OUT, { recursive: true });
if (mode === 'rank' || mode === 'all') {
  await exportRank(0, '全部时间');
  await exportRank(1, '最近一周');
}
if (mode === 'albums' || mode === 'all') {
  await exportCollectedAlbums();
}
