import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { post } from './export.mjs';

const NC_ROOT = process.env.NC_ROOT || process.cwd();
const BASE_OUT = path.join(NC_ROOT, 'out2');
const OUT = process.env.NC_STAGE === '1' ? path.join(BASE_OUT, 'staging') : BASE_OUT;
const SNAP = path.join(NC_ROOT, 'out/playlists.json');
const CACHE = path.join(OUT, 'albums_cache.json');
const EKEY = 'e82ckenh8dichen8';
const EUA = 'NeteaseMusic/8.9.70.240407164325(8009070);Dalvik/2.1.0 (Linux; U; Android 13; PJZ110 Build/TP1A.220905.001)';
const cookieStr = () => fs.readFileSync(path.join(NC_ROOT, 'cookie.txt'), 'utf8').trim();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const one = s => String(s || '').replace(/\s+/g, ' ').trim();

function eapiEncrypt(p, obj) {
  const text = JSON.stringify(obj);
  const digest = crypto.createHash('md5').update(`nobody${p}use${text}md5forencrypt`).digest('hex');
  const data = `${p}-36cd479b6b5-${text}-36cd479b6b5-${digest}`;
  const c = crypto.createCipheriv('aes-128-ecb', Buffer.from(EKEY), null);
  return Buffer.concat([c.update(Buffer.from(data, 'utf8')), c.final()]).toString('hex').toUpperCase();
}
async function eapi(short, body = {}) {
  const r = await fetch('https://music.163.com/eapi' + short, {
    method: 'POST',
    headers: { 'User-Agent': EUA, 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookieStr() + '; os=android; appver=8.9.70' },
    body: 'params=' + eapiEncrypt('/api' + short, { ...body, header: { os: 'android', appver: '8.9.70', osver: '13', deviceId: 'com.netease.cloudmusic' } }),
    signal: AbortSignal.timeout(25000),
  });
  return r.json().catch(() => null);
}
async function retry(fn, n = 3) {
  for (let i = 0; i < n; i++) {
    try { const r = await fn(); if (r && r.code === 200) return r; if (i === n - 1) return r; } catch (e) { if (i === n - 1) throw e; }
    await sleep(700 * (i + 1));
  }
}
async function songsByIds(ids) {
  const map = new Map();
  for (let i = 0; i < ids.length; i += 800) {
    const batch = ids.slice(i, i + 800);
    const r = await retry(() => post('/weapi/v3/song/detail', { c: JSON.stringify(batch.map(id => ({ id }))) }));
    for (const s of r?.songs || []) map.set(s.id, s);
    await sleep(120);
  }
  return map;
}
const cache = fs.existsSync(CACHE) ? JSON.parse(fs.readFileSync(CACHE, 'utf8')) : {};

async function exportPlaylist(p) {
  const det = await retry(() => eapi('/v6/playlist/detail', { id: String(p.id), n: 100000, s: 8, t: 0 }));
  const pl = det?.playlist || {};
  const ids = (pl.trackIds || []).map(x => x.id);
  const songMap = await songsByIds(ids);
  const rows = [];
  for (const id of ids) {
    const s = songMap.get(id);
    if (!s) { rows.push({ id, name: '', ar: '', al: '', alId: 0, company: '', fee: null, dur: 0, ncr: '接口无数据', masked: false }); continue; }
    const ar = (s.ar || []).map(a => one(a.name)).filter(Boolean).join(' / ');
    const al = s.al || {};
    rows.push({
      id: s.id, name: one(s.name) || '', ar, al: one(al.name), alId: al.id || 0, company: '',
      fee: s.fee ?? null, dur: s.dt || 0,
      ncr: s.noCopyrightRcmd ? (s.noCopyrightRcmd.typeDesc || '版权受限') : '',
      masked: /\*{2,}|＊{2,}/.test(s.name || ''),
    });
  }
  return { ...p, description: pl.description || p.description || '', trackCount: ids.length, rows };
}

const acc = await post('/weapi/w/nuser/account/get');
if (acc?.code !== 200 || !acc?.account) { console.error('登录失效'); process.exit(1); }
const uid = acc.account.id, nick = acc.profile?.nickname || '';
log(`登录：${nick} (${uid})`);

const r = await post('/weapi/user/playlist', { uid, limit: 1000, offset: 0, includeVideo: true });
let topMap = new Map();
try {
  const tr = await eapi('/user/playlist', { uid, limit: 1000, offset: 0, includeVideo: true, includeTop: true });
  topMap = new Map((tr?.playlist || []).map(p => [String(p.id), !!p.top]));
  log(`置顶标记：${[...topMap.values()].filter(Boolean).length} 个`);
} catch (e) { log('置顶标记获取失败：' + e.message); }
const seen = new Map();
for (const p of r?.playlist || []) if (!seen.has(p.id)) seen.set(p.id, p);
const all = [...seen.values()];
const mine = all.filter(p => p.userId === uid).map(p => ({ ...p, top: topMap.get(String(p.id)) || false }));
const other = all.filter(p => p.userId !== uid);
log(`自建 ${mine.length} / 收藏歌单 ${other.length}`);

const prev = JSON.parse(fs.readFileSync(path.join(OUT, 'playlists_full.json'), 'utf8'));
const prevMap = new Map(prev.map(x => [String(x.id), x]));
const oldSnap = JSON.parse(fs.readFileSync(SNAP, 'utf8'));
const oldMap = new Map(oldSnap.mine.map(p => [String(p.id), p]));

const results = [];
let refetched = 0;
for (const p of mine) {
  const old = oldMap.get(String(p.id));
  const had = prevMap.get(String(p.id));
  const dirty = !had || !old || old.trackCount !== p.trackCount || old.updateTime !== p.updateTime || old.name !== p.name;
  if (dirty) {
    try {
      const res = await exportPlaylist(p);
      results.push(res);
      refetched++;
      log(`  重抓 ${res.name}（${res.rows.length} 首）`);
      await sleep(120);
    } catch (e) {
      log(`  失败 ${p.name}: ${e.message}`);
      if (had) results.push(had);
    }
  } else {
    results.push(had);
  }
}

// 顺序对齐云端
const orderIndex = new Map(mine.map((p, i) => [String(p.id), i]));
results.sort((a, b) => (orderIndex.get(String(a.id)) ?? 1e9) - (orderIndex.get(String(b.id)) ?? 1e9));

// 补缺失专辑厂牌
const need = [...new Set(results.flatMap(x => x.rows.map(s => s.alId)).filter(Boolean).map(String))].filter(id => !(id in cache));
log(`专辑需补抓：${need.length}`);
let done = 0;
for (const id of need) {
  try {
    const a = await retry(() => post('/weapi/v1/album/' + id, {}));
    if (a?.code === 200) {
      const al = a.album || {};
      cache[id] = { company: al.company || '', name: al.name || '', publishTime: al.publishTime || 0, artists: (al.artists || []).map(x => x.name).join(' / '), size: al.size || 0 };
    }
  } catch {}
  if (++done % 100 === 0) { fs.writeFileSync(CACHE, JSON.stringify(cache)); log(`  专辑 ${done}/${need.length}`); }
  await sleep(150);
}
fs.writeFileSync(CACHE, JSON.stringify(cache));

for (const res of results) for (const s of res.rows) if (s.alId) s.company = cache[String(s.alId)]?.company || '';

fs.writeFileSync(path.join(OUT, 'playlists_full.json'), JSON.stringify(results));
fs.mkdirSync(path.dirname(SNAP), { recursive: true });
fs.writeFileSync(SNAP, JSON.stringify({ uid, nick, mine, other }, null, 1));

const total = results.reduce((n, x) => n + x.rows.length, 0);
log(`同步完成：重抓 ${refetched} 个歌单，共 ${total} 首，补专辑 ${need.length} 张`);

// ---------- 历史对比：记录消失的曲目（疑似下架/被移出） ----------
const HIST = path.join(OUT, 'history');
fs.mkdirSync(HIST, { recursive: true });
const latestFile = path.join(HIST, 'latest_songs.json');
const removedFile = path.join(HIST, 'removed.json');
const cur = {};
for (const res of results) for (const s of res.rows) {
  const k = String(s.id || ('n:' + s.name));
  if (!cur[k]) cur[k] = { n: s.name, ar: s.ar, al: s.al, alId: s.alId, pl: [] };
  if (!cur[k].pl.includes(String(res.id))) cur[k].pl.push(String(res.id));
}
const removedList = fs.existsSync(removedFile) ? JSON.parse(fs.readFileSync(removedFile, 'utf8')) : [];
const removedIds = new Set(removedList.map(x => String(x.id)));
let newlyGone = 0;
if (fs.existsSync(latestFile)) {
  const old = JSON.parse(fs.readFileSync(latestFile, 'utf8')).songs || {};
  const plName = new Map(results.map(x => [String(x.id), x.name]));
  for (const [k, v] of Object.entries(old)) {
    if (cur[k] || removedIds.has(k)) continue;
    removedList.push({
      id: k, name: v.n || '', ar: v.ar || '', al: v.al || '',
      playlists: (v.pl || []).map(id => plName.get(String(id)) || id),
      lastSeen: new Date().toISOString().slice(0, 10),
    });
    removedIds.add(k);
    newlyGone++;
  }
}
fs.writeFileSync(removedFile, JSON.stringify(removedList, null, 1));
fs.writeFileSync(latestFile, JSON.stringify({ generated: new Date().toISOString(), songs: cur }));
log(`历史对比：新增消失记录 ${newlyGone} 首，累计 ${removedList.length} 首`);
