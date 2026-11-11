import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { post } from './export.mjs';

const NC_ROOT = process.env.NC_ROOT || process.cwd();
const BASE_OUT = path.join(NC_ROOT, 'out2');
const OUT = process.env.NC_STAGE === '1' ? path.join(BASE_OUT, 'staging') : BASE_OUT;
const EKEY = 'e82ckenh8dichen8';
const EUA = 'NeteaseMusic/8.9.70.240407164325(8009070);Dalvik/2.1.0 (Linux; U; Android 13; PJZ110 Build/TP1A.220905.001)';
const cookieStr = () => fs.readFileSync(path.join(process.cwd(), 'cookie.txt'), 'utf8').trim();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

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
    headers: {
      'User-Agent': EUA,
      'Content-Type': 'application/x-www-form-urlencoded',
      Cookie: cookieStr() + '; os=android; appver=8.9.70',
    },
    body: 'params=' + eapiEncrypt('/api' + short, { ...body, header: { os: 'android', appver: '8.9.70', osver: '13', deviceId: 'com.netease.cloudmusic' } }),
    signal: AbortSignal.timeout(25000),
  });
  return r.json().catch(() => null);
}

async function retry(fn, n = 3) {
  for (let i = 0; i < n; i++) {
    try {
      const r = await fn();
      if (r && (r.code === 200 || r.code === undefined)) return r;
      if (r && r.code === 200) return r;
      if (i === n - 1) return r;
    } catch (e) { if (i === n - 1) throw e; }
    await sleep(600 * (i + 1));
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

async function songsByIds(ids) {
  const map = new Map();
  for (let i = 0; i < ids.length; i += 800) {
    const batch = ids.slice(i, i + 800);
    const r = await retry(() => post('/weapi/v3/song/detail', { c: JSON.stringify(batch.map(id => ({ id }))) }));
    for (const s of r?.songs || []) map.set(s.id, s);
    log(`      歌曲批次 ${Math.floor(i / 800) + 1}/${Math.ceil(ids.length / 800)} → ${r?.songs?.length || 0} 首`);
    await sleep(100);
  }
  return map;
}

const albumCache = new Map();
export async function albumInfo(alId) {
  if (albumCache.has(alId)) return albumCache.get(alId);
  const r = await retry(() => post('/weapi/v1/album/' + alId, {}));
  const a = r?.album;
  const info = {
    company: a?.company || '',
    publishTime: a?.publishTime || 0,
    name: a?.name || '',
    artists: (a?.artists || []).map(x => x.name).join(' / '),
  };
  albumCache.set(alId, info);
  return info;
}

const clean = s => String(s || '').replace(/[\\/:*?"<>|\n\r]/g, '_').slice(0, 60);
const one = s => String(s || '').replace(/\s+/g, ' ').trim();

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
      id: s.id,
      name: one(s.name) || '',
      ar, al: one(al.name), alId: al.id || 0, company: '',
      fee: s.fee ?? null,
      dur: s.dt || 0,
      ncr: s.noCopyrightRcmd ? (s.noCopyrightRcmd.typeDesc || '版权受限') : '',
      masked: /\*{2,}|＊{2,}/.test(s.name || ''),
    });
  }
  // 专辑去重后并发补厂牌
  const alIds = [...new Set(rows.map(r => r.alId).filter(Boolean))];
  log(`      曲目 ${rows.length}，专辑去重 ${alIds.length}${process.env.NO_ALBUM ? '（跳过厂牌抓取）' : '，抓厂牌…'}`);
  if (!process.env.NO_ALBUM) {
    const infos = new Map();
    await mapLimit(alIds, 12, async id => {
      const info = await albumInfo(id);
      infos.set(id, info.company);
    });
    for (const r of rows) if (r.alId) r.company = infos.get(r.alId) || '';
  }
  return { ...p, description: pl.description || '', trackCount: ids.length, rows };
}

function playlistMd(p, idx) {
  const L = [
    `# ${p.name}`,
    '',
    `- 序号：${idx}`,
    `- 可见性：${p.privacy === 10 ? '私密' : '公开'}`,
    `- 曲目：${p.trackCount} 首`,
    `- 创建时间：${p.createTime ? new Date(p.createTime).toLocaleString('zh-CN') : '—'}`,
    `- 链接：https://music.163.com/playlist?id=${p.id}`,
    '',
  ];
  if ((p.description || '').trim()) L.push('## 简介', '', p.description.trim(), '');
  L.push('## 曲目', '');
  p.rows.forEach((r, i) => L.push(`${i + 1}. ${r.name} - ${r.ar || '未知'} - ${r.al || '未知'} - ${r.company || '未标注厂牌'}`));
  return L.join('\n');
}

async function main() {
  const only = Number(process.env.LIMIT || 0);
  const meta = JSON.parse(fs.readFileSync(path.join(NC_ROOT, 'out/playlists.json'), 'utf8'));
  const mine = meta.mine.slice().sort((a, b) => (b.trackCount || 0) - (a.trackCount || 0));
  const idsEnv = process.env.IDS ? process.env.IDS.split(',').map(s => s.trim()) : null;
  let list = idsEnv ? mine.filter(p => idsEnv.includes(String(p.id))) : (only ? mine.slice(0, only) : mine);
  fs.mkdirSync(path.join(OUT, 'playlists'), { recursive: true });

  const results = [];
  for (let i = 0; i < list.length; i++) {
    const p = list[i];
    try {
      const r = await exportPlaylist(p);
      results.push(r);
      const file = `${String(i + 1).padStart(3, '0')}_${clean(r.name) || r.id}.md`;
      fs.writeFileSync(path.join(OUT, 'playlists', file), playlistMd(r, i + 1));
      const filled = r.rows.filter(x => x.company).length;
      log(`[${i + 1}/${list.length}] ${r.name} ${r.trackCount} 首 (厂牌 ${filled})`);
    } catch (e) {
      log(`[${i + 1}/${list.length}] 失败 ${p.name}: ${e.message}`);
    }
    await sleep(120);
  }

  fs.writeFileSync(path.join(OUT, 'album_ids.txt'), [...new Set(results.flatMap(r => r.rows.map(x => x.alId)).filter(Boolean))].join('\n'));

  // CSV
  const csv = ['歌单,序号,歌名,制作人/团体,专辑,发行公司/厂牌'];
  for (const r of results) r.rows.forEach((s, k) => csv.push([r.name, k + 1, s.name, s.ar, s.al, s.company].map(v => `"${String(v || '').replace(/"/g, '""')}"`).join(',')));
  fs.writeFileSync(path.join(OUT, 'all_songs.csv'), '\ufeff' + csv.join('\n'));

  // 索引
  const idx = ['# 自建歌单（整理结果）', '', `- 账号：${meta.nick}（uid ${meta.uid}）`, `- 生成时间：${new Date().toLocaleString('zh-CN')}`, `- 歌单数：${results.length}，曲目：${results.reduce((n, r) => n + r.rows.length, 0)} 首`, '', '| # | 歌单 | 可见性 | 曲目 | 有厂牌 | 文件 |', '| --- | --- | --- | --- | --- | --- |'];
  results.forEach((r, i) => idx.push(`| ${i + 1} | ${r.name.replace(/\|/g, '\\|')} | ${r.privacy === 10 ? '私密' : '公开'} | ${r.rows.length} | ${r.rows.filter(x => x.company).length} | ${String(i + 1).padStart(3, '0')}_${clean(r.name)}.md |`));
  fs.writeFileSync(path.join(OUT, '00_自建歌单索引.md'), idx.join('\n'));
  fs.writeFileSync(path.join(OUT, 'playlists_full.json'), JSON.stringify(results.map(r => ({ ...r, rows: r.rows })), null, 0));
  log(`完成 ${results.length} 个歌单，${results.reduce((n, r) => n + r.rows.length, 0)} 首歌`);
}

main().catch(e => { console.error(e); process.exit(1); });
