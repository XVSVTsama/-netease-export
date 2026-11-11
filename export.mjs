import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// ---------- 网易云 weapi 加密 ----------
const IV = '0102030405060708';
const PRESET = '0CoJUm6Qyw8W8jud';
const PUBKEY = '010001';
const MOD = '00e0b509f6259df8642dbc35662901477df22677ec152b5ff68ace615bb7b725152b3ab17a876aea8a5aa76d2e417629ec4ee341f56135fccf695280104e0312ecbda92557c93870114af6c9d05c4f7f0c3685b7a46bee255932575cce10b424d813cfe4875d3e82047b97ddef52741d546b8e289dc6935b3ece0462db0a22b8e7';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const NC_ROOT = process.env.NC_ROOT || process.cwd();
const COOKIE_FILE = path.join(NC_ROOT, 'cookie.txt');

function aes2(t, k) {
  const c = crypto.createCipheriv('aes-128-cbc', Buffer.from(k, 'utf8'), Buffer.from(IV, 'utf8'));
  return Buffer.concat([c.update(Buffer.from(t, 'utf8')), c.final()]).toString('base64');
}
function rsa(t) {
  const rev = Buffer.from(t.split('').reverse().join(''), 'utf8').toString('hex');
  let b = BigInt('0x' + rev), e = BigInt('0x' + PUBKEY), m = BigInt('0x' + MOD), r = 1n;
  while (e > 0n) { if (e & 1n) r = (r * b) % m; b = (b * b) % m; e >>= 1n; }
  return r.toString(16).padStart(256, '0');
}
function weapiBody(o) {
  const t = JSON.stringify(o);
  const k = crypto.randomBytes(16).toString('base64').slice(0, 16);
  return new URLSearchParams({ params: aes2(aes2(t, PRESET), k), encSecKey: rsa(k) }).toString();
}
export function cookie() {
  try { return fs.readFileSync(COOKIE_FILE, 'utf8').trim(); } catch { return ''; }
}
export async function post(p, body = {}) {
  const ck = cookie();
  const r = await fetch('https://music.163.com' + p, {
    method: 'POST',
    headers: {
      'User-Agent': UA,
      Referer: 'https://music.163.com/',
      'Content-Type': 'application/x-www-form-urlencoded',
      ...(ck ? { Cookie: ck } : {}),
    },
    body: weapiBody(body),
    signal: AbortSignal.timeout(25000),
  });
  const sc = typeof r.headers.getSetCookie === 'function' ? r.headers.getSetCookie() : [];
  if (sc.length) {
    const jar = new Map();
    for (const kv of sc) {
      const pair = kv.split(';')[0];
      const i = pair.indexOf('=');
      if (i > 0) jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
    }
    globalThis.__lastSetCookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
  }
  return r.json().catch(() => null);
}

// ---------- 导出 ----------
const sleep = ms => new Promise(r => setTimeout(r, ms));
const CONCURRENCY = 5;

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx], idx); }
  }));
  return out;
}

async function main() {
  const demoUid = process.env.NC_UID;
  let uid, nick = '';
  if (demoUid) {
    uid = Number(demoUid);
    const u = await post('/weapi/v1/user/detail/' + uid);
    nick = u?.profile?.nickname || '';
    console.log(`[匿名模式] 用户：${nick} (uid=${uid})`);
  } else {
    const cookieStr = cookie();
    if (!cookieStr) { console.error('缺少 cookie.txt，需先登录'); process.exit(1); }
    const acc = await post('/weapi/w/nuser/account/get');
    if (acc?.code !== 200 || !acc?.account) { console.error('登录态无效：', JSON.stringify(acc?.code)); process.exit(2); }
    uid = acc.account.id;
    nick = acc.profile?.nickname || '';
  }
  console.log(`已登录：${nick} (uid=${uid})`);

  const lists = [];
  for (let offset = 0; ; offset += 100) {
    const r = await post('/weapi/user/playlist', { uid, limit: 100, offset, includeVideo: true });
    const ps = r?.playlist || [];
    lists.push(...ps);
    if (ps.length < 100) break;
    await sleep(200);
  }
  const created = lists.filter(p => p.userId === uid);
  const collected = lists.filter(p => p.userId !== uid);
  console.log(`歌单：自建 ${created.length}，收藏 ${collected.length}`);

  const all = [...created, ...collected].slice(0, Number(process.env.NC_LIMIT || 9999));
  const albumCache = new Map();
  const results = [];

  for (const p of all) {
    const d = await post('/weapi/playlist/detail', { id: p.id, n: 100000, s: 8 });
    const det = d?.result; if (d?.code !== 200) { console.log('  ! 跳过（code ' + d?.code + '）' + p.name); continue; }
    const tracks = det?.tracks || det?.playlist?.tracks || [];
    const songInfo = [];
    for (const t of tracks) {
      const ar = (t.ar || t.artists || []).map(a => a.name).join(' / ');
      const al = t.al || t.album || {};
      let company = '';
      if (al.id) {
        if (albumCache.has(al.id)) company = albumCache.get(al.id);
        else {
          const a = await post('/weapi/v1/album/' + al.id, {});
          company = a?.album?.company || '';
          albumCache.set(al.id, company);
          await sleep(120);
        }
      }
      songInfo.push({ name: t.name, ar, al: al.name || '', company, albumId: al.id });
    }
    results.push({
      name: p.name || det?.playlist?.name || String(p.id),
      id: p.id,
      desc: det?.playlist?.description || p.description || '',
      kind: p.userId === uid ? '自建' : '收藏',
      count: songInfo.length,
      songs: songInfo,
    });
    console.log(`  ✓ ${p.name} (${songInfo.length} 首)`);
    await sleep(180);
  }

  const outDir = path.join(process.cwd(), 'out');
  fs.mkdirSync(outDir, { recursive: true });
  const esc = s => (s || '').replace(/\|/g, '\\|').replace(/\n/g, ' ').trim();
  const missing = results.reduce((n, r) => n + r.songs.filter(s => !s.company).length, 0);
  const totalSongs = results.reduce((n, r) => n + r.songs.length, 0);

  // 索引
  const idx = [`# 网易云歌单导出`, '', `账号：${nick}（uid ${uid}）`, `导出时间：${new Date().toLocaleString('zh-CN')}`, '', `共 ${results.length} 个歌单 / ${totalSongs} 首歌，其中 ${missing} 首未标注厂牌。`, '', '| 歌单 | 类型 | 曲目数 | 链接 |', '| --- | --- | --- | --- |'];
  for (const r of results) idx.push(`| ${esc(r.name)} | ${r.kind} | ${r.count} | https://music.163.com/playlist?id=${r.id} |`);

  // 全部 CSV
  const csv = ['歌单,歌名,制作人/团体,专辑,发行公司/厂牌'];
  for (const r of results) for (const s of r.songs) csv.push([r.name, s.name, s.ar, s.al, s.company].map(v => `"${String(v || '').replace(/"/g, '""')}"`).join(','));
  fs.writeFileSync(path.join(outDir, 'all.csv'), '\ufeff' + csv.join('\n'));

  // 每个歌单一个 md
  for (const r of results) {
    const lines = [`# ${r.name}`, '', `- 类型：${r.kind}`, `- 曲目：${r.count} 首`, `- 链接：https://music.163.com/playlist?id=${r.id}`, ''];
    if (r.desc.trim()) lines.push('## 简介', '', r.desc.trim(), '');
    lines.push('## 曲目', '');
    r.songs.forEach((s, i) => lines.push(`${i + 1}. ${s.name} - ${s.ar || '未知'} - ${s.al || '未知'} - ${s.company || '未标注厂牌'}`));
    fs.writeFileSync(path.join(outDir, `${String(results.indexOf(r) + 1).padStart(2, '0')}_${r.name.replace(/[\\/:*?"<>|]/g, '_')}.md`), lines.join('\n'));
  }

  fs.writeFileSync(path.join(outDir, '00_歌单索引.md'), idx.join('\n'));
  fs.writeFileSync(path.join(outDir, 'raw.json'), JSON.stringify({ uid, nick, results }, null, 2));
  console.log(`完成：${results.length} 个歌单 ${totalSongs} 首 → ${outDir}`);
}

if (process.argv[1] && process.argv[1].endsWith('export.mjs')) main().catch(e => { console.error(e); process.exit(1); });
