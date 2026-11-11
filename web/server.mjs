import http from 'node:http';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import QRCode from 'qrcode';
import { ProxyAgent, setGlobalDispatcher } from 'undici';

const PORT = Number(process.env.PORT || 8789);
const ROOT = process.cwd();          // 代码与默认数据所在
const PUBLIC = path.join(ROOT, 'web/public');
const REG_FILE = path.join(ROOT, 'accounts.json');
const EKEY = 'e82ckenh8dichen8';
const UA_APP = 'NeteaseMusic/8.9.70.240407164325(8009070);Dalvik/2.1.0 (Linux; U; Android 13; PJZ110 Build/TP1A.220905.001)';

/* ---------------- 通用 ---------------- */
const fmt = ts => {
  if (!ts) return '—';
  const d = new Date(ts), p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};
const clock = () => new Date().toLocaleTimeString('zh-CN', { hour12: false });
const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };

/* ---------------- 网络代理 ---------------- */
const PROXY_FILE = path.join(ROOT, 'proxy.json');
let proxyCfg = (() => { try { return JSON.parse(fs.readFileSync(PROXY_FILE, 'utf8')); } catch { return { enabled: false, url: '' }; } })();
let proxyApplied = false;
function applyProxy() {
  if (proxyCfg.enabled && proxyCfg.url) {
    try { setGlobalDispatcher(new ProxyAgent(proxyCfg.url)); proxyApplied = true; return true; }
    catch (e) { console.log('代理设置失败:', e.message); proxyApplied = false; }
  }
  return false;
}
applyProxy();


/* ---------------- 出口检测（自动，不内置代理） ---------------- */
import net from 'node:net';
const PORT_CANDIDATES = [7890, 7891, 7892, 7893, 1080, 1081, 1087, 10809, 8888, 8118, 20171, 2080];
function tcpOpen(port, host = '127.0.0.1') {
  return new Promise(resolve => {
    const s = net.connect({ host, port });
    const done = v => { try { s.destroy(); } catch {} resolve(v); };
    s.setTimeout(400);
    s.once('connect', () => done(true));
    s.once('timeout', () => done(false));
    s.once('error', () => done(false));
  });
}
let exitInfo = { at: 0, url: '', source: '直连', port: 0 };
async function detectExit(force = false) {
  if (!force && Date.now() - exitInfo.at < 30000) return exitInfo;
  const env = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.ALL_PROXY;
  if (env) {
    exitInfo = { at: Date.now(), url: env, source: '环境变量', port: 0 };
    applyProxyUrl(env);
    return exitInfo;
  }
  for (const port of PORT_CANDIDATES) {
    if (await tcpOpen(port)) {
      const url = 'http://127.0.0.1:' + port;
      exitInfo = { at: Date.now(), url, source: '本地端口', port };
      applyProxyUrl(url);
      return exitInfo;
    }
  }
  exitInfo = { at: Date.now(), url: '', source: '直连', port: 0 };
  return exitInfo;
}
let appliedUrl = '';
function applyProxyUrl(url) {
  if (!url || url === appliedUrl) return;
  try { setGlobalDispatcher(new ProxyAgent(url)); appliedUrl = url; }
  catch (e) { appliedUrl = ''; }
}

/* ---------------- 账号 ---------------- */
let REG = (() => {
  try { return JSON.parse(fs.readFileSync(REG_FILE, 'utf8')); }
  catch { return { current: 'default', accounts: [{ id: 'default', nick: '默认账号', uid: '', root: ROOT, dest: '/workspace/mounts/Download/网易云歌单导出' }] }; }
})();
const saveReg = () => fs.writeFileSync(REG_FILE, JSON.stringify(REG, null, 2));
const curAcc = () => {
  const a = REG.accounts.find(x => x.id === REG.current) || REG.accounts[0];
  a.root = path.resolve(a.root || '.');
  a.dest = path.resolve(a.dest || './导出');
  return a;
};
const curOut = () => path.join(curAcc().root, 'out2');
const BASE_OUT_DIR = () => path.join(curAcc().root, 'out2');
const curCookie = () => path.join(curAcc().root, 'cookie.txt');
const curZip = () => path.resolve(curAcc().dest) + '.zip';

/* ---------------- 缓存读取 ---------------- */
const cache = new Map();
function cached(key, file, ttl = 30000) {
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && now - hit.at < ttl) return hit.data;
  let data = null;
  try { if (fs.existsSync(file)) data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  cache.set(key, { at: now, data });
  return data;
}
const getPlaylists = () => cached('playlists:' + curAcc().id, path.join(curOut(), 'playlists_full.json')) || [];
const getCovers = () => cached('covers:' + curAcc().id, path.join(curOut(), 'covers.json')) || {};
const getAlbums = () => cached('albums:' + curAcc().id, path.join(curOut(), 'collected_albums.json')) || [];
const getCollectedPlaylists = () => {
  const v = cached('cpl:' + curAcc().id, path.join(curOut(), 'collected_playlists.json'));
  return Array.isArray(v) ? v : [];
};
const getCreatedAlbums = () => {
  const v = cached('cal:' + curAcc().id, path.join(curOut(), 'created_albums.json'));
  return v?.albums || [];
};
const getRemoved = () => cached('removed:' + curAcc().id, path.join(curOut(), 'history/removed.json')) || [];

function statusOf(s) {
  const d = s.ncrDesc || '';
  if (d.includes('其它版本')) return 'otherVersion';
  if (s.ncrType === 1 && s.altId) return 'otherVersion';
  if ((s.st ?? 0) < 0) return 'down';
  if (s.ncrType) return 'other';
  return 'ok';
}
const SCRIPT_DEFS = [
  ['西里尔文', /\p{Script=Cyrillic}/u], ['日文假名', /[\p{Script=Hiragana}\p{Script=Katakana}]/u],
  ['韩文', /\p{Script=Hangul}/u], ['阿拉伯文', /\p{Script=Arabic}/u], ['希伯来文', /\p{Script=Hebrew}/u],
  ['希腊文', /\p{Script=Greek}/u], ['天城文', /\p{Script=Devanagari}/u], ['孟加拉文', /\p{Script=Bengali}/u],
  ['泰米尔文', /\p{Script=Tamil}/u], ['泰卢固文', /\p{Script=Telugu}/u], ['卡纳达文', /\p{Script=Kannada}/u],
  ['马拉雅拉姆文', /\p{Script=Malayalam}/u], ['古吉拉特文', /\p{Script=Gujarati}/u], ['果鲁穆奇文', /\p{Script=Gurmukhi}/u],
  ['僧伽罗文', /\p{Script=Sinhala}/u], ['藏文', /\p{Script=Tibetan}/u], ['彝文', /\p{Script=Yi}/u],
  ['蒙古文', /\p{Script=Mongolian}/u], ['格鲁吉亚文', /\p{Script=Georgian}/u], ['亚美尼亚文', /\p{Script=Armenian}/u],
  ['埃塞俄比亚文', /\p{Script=Ethiopic}/u], ['塔纳文', /\p{Script=Thaana}/u], ['泰文', /\p{Script=Thai}/u],
  ['老挝文', /\p{Script=Lao}/u], ['高棉文', /\p{Script=Khmer}/u], ['缅甸文', /\p{Script=Myanmar}/u],
  ['拉丁扩展/变音字母', /[\u1E00-\u1EFF\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u00FF\u0100-\u017F]/u],
];

function getSpecial() {
  const rs = getPlaylists();
  const bySong = new Map();
  for (const r of rs) for (const s of r.rows || []) {
    const k = String(s.id || ('n:' + s.name));
    if (!bySong.has(k)) bySong.set(k, { ...s, playlists: [] });
    const e = bySong.get(k);
    if (!e.playlists.some(p => p.id === String(r.id))) e.playlists.push({ id: String(r.id), name: r.name, privacy: r.privacy });
  }
  const all = [...bySong.values()];
  const pick = s => ({ name: s.name, ar: s.ar, al: s.al, dur: s.dur || 0, company: s.company || '', id: String(s.id || ''), playlists: s.playlists.map(p => ({ id: String(p.id), name: p.name, privacy: p.privacy })) });
  const list = cat => all.filter(s => statusOf(s) === cat).map(pick);
  const special = all.map(s => ({
    ...s, kinds: [
      /\p{Mn}|\p{Mc}/u.test(s.name || '') ? '组合附加符号' : '',
      /\p{Cf}/u.test(s.name || '') ? '零宽/方向控制符' : '',
      /\p{So}|\p{Co}/u.test(s.name || '') ? '符号/图形字符' : '',
    ].filter(Boolean),
  })).filter(s => s.kinds.length).map(s => ({ ...pick(s), kinds: s.kinds }));
  const nonLatin = all.map(s => ({ ...s, langs: SCRIPT_DEFS.filter(([, re]) => re.test(s.name || '')).map(([k]) => k) }))
    .filter(s => s.langs.length).map(s => ({ ...pick(s), langs: s.langs }));
  const deleted = getRemoved().map(x => ({ name: x.name, ar: x.ar, al: x.al, company: '', id: String(x.id || ''), playlists: x.playlists || [], lastSeen: x.lastSeen || '' }));
  return { deleted, down: list('down'), otherVersion: list('otherVersion'), other: list('other'), special, nonLatin };
}

function playlistFeatures() {
  const key = 'plf:' + curAcc().id;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 60000) return hit.data;
  const map = {};
  for (const r of getPlaylists()) {
    let down = 0, special = 0, nonLatin = 0;
    for (const s of r.rows || []) {
      const cat = statusOf(s);
      if (cat !== 'ok') down++;
      const n = s.name || '';
      if (/[\p{Mn}\p{Mc}\p{Cf}\p{So}\p{Co}]/u.test(n)) special++;
      if (SCRIPT_DEFS.some(([, re]) => re.test(n))) nonLatin++;
    }
    map[String(r.id)] = { down, special, nonLatin };
  }
  cache.set(key, { at: Date.now(), data: map });
  return map;
}

function buildStats() {
  const rs = getPlaylists();
  let total = 0, filled = 0;
  const ids = new Set();
  for (const r of rs) for (const s of r.rows || []) {
    total++; filled += s.company ? 1 : 0;
    ids.add(String(s.id || ('n:' + s.name)));
  }
  const sp = getSpecial();
  const albums = getAlbums();
  const cpl = getCollectedPlaylists();
  const cal = getCreatedAlbums();
  let lastSync = '';
  const hf = path.join(curOut(), 'history/latest_songs.json');
  try { lastSync = JSON.parse(fs.readFileSync(hf, 'utf8')).generated || ''; } catch {}
  const stat = f => { try { return fs.statSync(f).mtimeMs; } catch { return 0; } };
  return {
    playlists: rs.length, priv: rs.filter(r => r.privacy === 10).length,
    total, unique: ids.size, uniqueActive: Math.max(0, ids.size - sp.down.length), filled, albums: albums.length,
    collectedPlaylists: cpl.length, createdAlbums: cal.length,
    collectedPlaylistSongs: cpl.reduce((n, x) => n + (x.trackCount || 0), 0),
    pendingStage: fs.existsSync(path.join(BASE_OUT_DIR(), 'staging', 'playlists_full.json')),
    down: sp.down.length, special: sp.special.length,
    lastSync: lastSync ? fmt(new Date(lastSync).getTime()) : '—',
    docTime: fmt(stat(path.join(curOut(), '00_自建歌单索引.md'))),
    cookieTime: fmt(stat(curCookie())),
    zipSize: stat(curZip()) ? fs.statSync(curZip()).size : 0,
    zipTime: fmt(stat(curZip())),
  };
}
let statsCache = { at: 0, data: null };
function getStats() {
  if (statsCache.data && Date.now() - statsCache.at < 20000) return statsCache.data;
  try { statsCache = { at: Date.now(), data: buildStats() }; }
  catch (e) { statsCache = { at: Date.now(), data: {} }; }
  return statsCache.data;
}

/* ---------------- 任务 ---------------- */
const MODES = { check: '核验', tidy: '整理', sync: '同步到暂存区', full: '同步 + 整理 + 核查', favSync: '收藏专辑同步', favTidy: '收藏专辑整理', favCheck: '收藏专辑核验', cplSync: '收藏歌单同步', cplCheck: '收藏歌单核验', calSync: '创建专辑同步', calTidy: '创建专辑整理', calCheck: '创建专辑核验', cplTidy: '收藏歌单整理' };
let job = { mode: null, name: null, running: false, start: 0, end: 0, exit: null, lines: [], failedStep: '' };
const history = [];
function pushLine(line) {
  for (const l of String(line).split('\n')) {
    if (!l.trim()) continue;
    job.lines.push(l.replace(/\s+$/, ''));
    if (l.startsWith('::ERROR_STEP::')) job.failedStep = l.replace('::ERROR_STEP::', '').trim();
  }
  if (job.lines.length > 2000) job.lines.splice(0, job.lines.length - 2000);
}
const targetAccLabel = id => { const a = REG.accounts.find(x => x.id === (id || REG.current)); return a ? `（${a.nick || a.id}）` : ''; };
function startJob(mode, accId) {
  if (job.running) return { ok: false, error: '已有任务在运行' };
  if (!MODES[mode]) return { ok: false, error: '未知任务类型' };
  job = { mode, name: MODES[mode] + (targetAccLabel(accId)), running: true, start: Date.now(), end: 0, exit: null, lines: [], failedStep: '' };
  pushLine(`[${clock()}] 启动：${MODES[mode]}`);
  const targetAcc = accId && REG.accounts.some(a => a.id === accId) ? accId : REG.current;
  const p = spawn('node', ['runner.mjs', mode, targetAcc], { cwd: ROOT });
  p.stdout.on('data', d => pushLine(d.toString()));
  p.stderr.on('data', d => pushLine('::STDERR::' + d.toString()));
  p.on('error', e => { pushLine('::ERROR::无法启动 runner：' + e.message); job.running = false; job.exit = -1; job.end = Date.now(); });
  p.on('close', code => {
    job.running = false; job.exit = code; job.end = Date.now();
    pushLine(`[${clock()}] 任务结束，退出码 ${code}`);
    history.unshift({ name: job.name, start: job.start, end: job.end, exit: job.exit, failedStep: job.failedStep });
    if (history.length > 6) history.pop();
    statsCache.at = 0;
    cache.clear();
  });
  return { ok: true };
}


/* ---------------- weapi（匿名搜索） ---------------- */
const IV = '0102030405060708', PRESET = '0CoJUm6Qyw8W8jud', PUBKEY = '010001';
const MOD = '00e0b509f6259df8642dbc35662901477df22677ec152b5ff68ace615bb7b725152b3ab17a876aea8a5aa76d2e417629ec4ee341f56135fccf695280104e0312ecbda92557c93870114af6c9d05c4f7f0c3685b7a46bee255932575cce10b424d813cfe4875d3e82047b97ddef52741d546b8e289dc6935b3ece0462db0a22b8e7';
const UA_WEB = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
function aes2(t, k) {
  const c = crypto.createCipheriv('aes-128-cbc', Buffer.from(k, 'utf8'), Buffer.from(IV, 'utf8'));
  return Buffer.concat([c.update(Buffer.from(t, 'utf8')), c.final()]).toString('base64');
}
function rsaEnc(t) {
  const rev = Buffer.from(t.split('').reverse().join(''), 'utf8').toString('hex');
  let b = BigInt('0x' + rev), e = BigInt('0x' + PUBKEY), m = BigInt('0x' + MOD), r = 1n;
  while (e > 0n) { if (e & 1n) r = (r * b) % m; b = (b * b) % m; e >>= 1n; }
  return r.toString(16).padStart(256, '0');
}
function weapiBody(o) {
  const t = JSON.stringify(o);
  const k = crypto.randomBytes(16).toString('base64').slice(0, 16);
  return new URLSearchParams({ params: aes2(aes2(t, PRESET), k), encSecKey: rsaEnc(k) }).toString();
}
async function wpost(pathname, body = {}) {
  const r = await fetch('https://music.163.com' + pathname, {
    method: 'POST',
    headers: { 'User-Agent': UA_WEB, Referer: 'https://music.163.com/', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: weapiBody(body),
    signal: AbortSignal.timeout(12000),
  });
  return r.json().catch(() => null);
}

/* ---------------- 跨平台查找 ---------------- */
const PLATFORMS = [
  { key: 'qq', name: 'QQ 音乐', probe: 'https://y.qq.com/' },
  { key: 'kugou', name: '酷狗', probe: 'https://www.kugou.com/' },
  { key: 'kuwo', name: '酷我', probe: 'https://www.kuwo.cn/' },
  { key: 'migu', name: '咪咕', probe: 'https://music.migu.cn/' },
  { key: 'spotify', name: 'Spotify', probe: 'https://open.spotify.com/' },
  { key: 'apple', name: 'Apple Music', probe: 'https://music.apple.com/' },
  { key: 'youtube', name: 'YouTube Music', probe: 'https://music.youtube.com/' },
];
let platCache = { at: 0, data: null };
// 每次调用都实测（不缓存），并发发起，5 秒超时，语义对齐 Mihomo 的 URL Test
async function probeAll() {
  await detectExit();
  const t0 = Date.now();
  const results = await Promise.all(PLATFORMS.map(async pf => {
    const t = Date.now();
    try {
      const r = await fetch(pf.probe, {
        method: 'GET', redirect: 'follow',
        headers: { 'User-Agent': 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36' },
        signal: AbortSignal.timeout(5000),
      });
      return { key: pf.key, name: pf.name, ok: r.status < 500, status: r.status, ms: Date.now() - t };
    } catch (e) {
      const timeout = e.name === 'TimeoutError' || /timeout/i.test(e.message || '');
      return { key: pf.key, name: pf.name, ok: false, status: 0, ms: Date.now() - t, reason: timeout ? '超时' : '连接失败' };
    }
  }));
  order: {
    // 保持声明顺序
    results.sort((a, b) => PLATFORMS.findIndex(p => p.key === a.key) - PLATFORMS.findIndex(p => p.key === b.key));
  }
  const out = { at: Date.now(), totalMs: Date.now() - t0, items: results };
  lastProbe = out;
  return out;
}
let lastProbe = null;
const findCache = new Map();

async function searchNetease(name, artist) {
  const r = await wpost('/weapi/search/get', { s: `${name} ${artist}`.trim(), type: 1, limit: 6, offset: 0 });
  return (r?.result?.songs || []).map(s => ({
    name: s.name,
    artist: (s.artists || s.ar || []).map(x => x.name).join(' / '),
    album: (s.album || s.al || {}).name || '',
    dur: s.duration || s.dt || 0,
    id: s.id,
    url: 'https://music.163.com/song?id=' + s.id,
  }));
}
async function searchQQ(name, artist) {
  const key = `${name} ${artist}`.trim();
  try {
    const r = await fetch('https://c.y.qq.com/splcloud/fcgi-bin/smartbox_new.fcg?key=' + encodeURIComponent(key) + '&format=json&inCharset=utf8&outCharset=utf-8', {
      headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://y.qq.com/' },
      signal: AbortSignal.timeout(9000),
    });
    const j = await r.json();
    return (j?.data?.song?.itemlist || []).slice(0, 6).map(x => ({
      name: x.name, artist: x.singer || '', id: x.mid || x.id,
      url: 'https://y.qq.com/n/ryqq/songDetail/' + (x.mid || ''),
    }));
  } catch { return []; }
}
async function searchKugou(name, artist) {
  const kw = `${name} ${artist}`.trim();
  try {
    const r = await fetch('https://songsearch.kugou.com/song_search_v2?keyword=' + encodeURIComponent(kw) + '&page=1&pagesize=5&platform=WebFilter&userid=-1&clientver=&tag=em', {
      headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://www.kugou.com/' }, signal: AbortSignal.timeout(6000),
    });
    const j = await r.json();
    return (j?.data?.lists || []).slice(0, 5).map(x => ({
      name: String(x.SongName || '').replace(/<[^>]+>/g, ''), artist: String(x.SingerName || '').replace(/<[^>]+>/g, ''), album: String(x.AlbumName || '').replace(/<[^>]+>/g, ''),
      url: x.FileHash ? 'https://www.kugou.com/song/#hash=' + x.FileHash : 'https://www.kugou.com/',
    }));
  } catch { return null; }
}
async function searchKuwo(name, artist) {
  const kw = `${name} ${artist}`.trim();
  try {
    const r = await fetch('http://search.kuwo.cn/r.s?client=kt&all=' + encodeURIComponent(kw) + '&pn=0&rn=5&uid=&ver=kwplayer_ar_9.2.2.1&vipver=1&show_copyright_off=1&newver=1&ft=music&encoding=utf8&rformat=json&mobi=1', {
      headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://www.kuwo.cn/' }, signal: AbortSignal.timeout(6000),
    });
    const txt = await r.text();
    const j = JSON.parse(txt.replace(/^callback\(|\)$/g, ''));
    return (j?.abslist || []).slice(0, 5).map(x => ({
      name: String(x.SONGNAME || '').replace(/&nbsp;/g, ' '), artist: String(x.ARTIST || '').replace(/&nbsp;/g, ' '),
      album: String(x.ALBUM || '').replace(/&nbsp;/g, ' '),
      url: x.MUSICRID ? 'https://www.kuwo.cn/play_detail/' + String(x.MUSICRID).replace('MUSIC_', '') : 'https://www.kuwo.cn/',
    }));
  } catch { return null; }
}
async function searchMigu(name, artist) {
  const kw = `${name} ${artist}`.trim();
  try {
    const sw = encodeURIComponent(JSON.stringify({ song: 1, album: 0, singer: 0, tagSong: 0, mvSong: 0, bestShow: 1 }));
    const r = await fetch('https://app.c.nf.migu.cn/MIGUM2.0/v1.0/content/search_all.do?text=' + encodeURIComponent(kw) + '&pageNo=1&pageSize=5&companyId=17&isCorrect=1&sort=1&searchSwitch=' + sw, {
      headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://music.migu.cn/' }, signal: AbortSignal.timeout(6000),
    });
    const j = await r.json();
    const list = j?.songResultData?.result || [];
    return list.slice(0, 5).map(x => ({
      name: x.songName || x.name, artist: (x.singerList || []).map(v => v.name).join(' / '),
      album: x.album || x.albumName || '',
      url: x.copyrightId ? 'https://music.migu.cn/v3/music/song/' + x.copyrightId : 'https://music.migu.cn/',
    }));
  } catch { return null; }
}
async function findEverywhere(name, artist, withProbe = false) {
  const key = name + '|' + artist;
  const hit = findCache.get(key);
  if (hit && Date.now() - hit.at < 300000) return hit.data;
  const platforms = withProbe ? (await probeAll()).items : (lastProbe?.items || []);
  const [qq, kugou, kuwo, migu] = await Promise.all([
    searchQQ(name, artist).catch(() => []),
    searchKugou(name, artist),
    searchKuwo(name, artist),
    searchMigu(name, artist),
  ]);
  const q = encodeURIComponent(`${name} ${artist}`.trim());
  const reach = Object.fromEntries(platforms.map(p => [p.key, p.ok]));
  const data = {
    query: { name, artist },
    results: { qq, kugou, kuwo, migu },
    qq,
    platforms,
    probeAt: lastProbe?.at || 0,
    links: {
      qq: 'https://y.qq.com/n/ryqq/search?w=' + q,
      kugou: 'https://www.kugou.com/yy/html/search.html#searchType=song&searchKeyWord=' + q,
      kuwo: 'https://www.kuwo.cn/search/list?key=' + q,
      migu: 'https://music.migu.cn/v3/search?keyword=' + q,
      spotify: 'https://open.spotify.com/search/' + q,
      apple: 'https://music.apple.com/cn/search?term=' + q,
      youtube: 'https://music.youtube.com/search?q=' + q,
    },
    reachable: reach,
  };
  findCache.set(key, { at: Date.now(), data });
  return data;
}

/* ---------------- 登录 ---------------- */
const eapiHeader = { os: 'android', appver: '8.9.70', osver: '13', deviceId: 'com.netease.cloudmusic', buildver: '1793900000', resolution: '1440x3200', mobilename: 'PJZ110' };
function eapiParams(p, obj) {
  const text = JSON.stringify(obj);
  const digest = crypto.createHash('md5').update(`nobody${p}use${text}md5forencrypt`).digest('hex');
  const data = `${p}-36cd479b6b5-${text}-36cd479b6b5-${digest}`;
  const c = crypto.createCipheriv('aes-128-ecb', Buffer.from(EKEY), null);
  return Buffer.concat([c.update(Buffer.from(data, 'utf8')), c.final()]).toString('hex').toUpperCase();
}
let jar = new Map();
const cookieHeader = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
function mergeCookie(list) {
  for (const kv of list) {
    const pair = kv.split(';')[0];
    const i = pair.indexOf('=');
    if (i > 0) jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
  }
}
async function eapi(short, body = {}) {
  const ck = cookieHeader();
  const r = await fetch('https://music.163.com/eapi' + short, {
    method: 'POST',
    headers: { 'User-Agent': UA_APP, 'Content-Type': 'application/x-www-form-urlencoded', Cookie: (ck ? ck + '; ' : '') + 'os=android; appver=8.9.70; osver=13' },
    body: 'params=' + eapiParams('/api' + short, { ...body, header: eapiHeader }),
    signal: AbortSignal.timeout(20000),
  });
  mergeCookie(typeof r.headers.getSetCookie === 'function' ? r.headers.getSetCookie() : []);
  return r.json().catch(() => null);
}
let qr = { key: null, img: null, at: 0, state: 'idle', who: '', target: 'default' };
async function newQr(target) {
  const r = await eapi('/login/qrcode/unikey', { type: 1 });
  if (r?.code !== 200) throw new Error('生成二维码失败：' + (r?.message || r?.code));
  qr = { key: r.unikey, img: await QRCode.toDataURL('https://music.163.com/login?codekey=' + r.unikey, { width: 520, margin: 1 }), at: Date.now(), state: 'waiting', who: '', target: target || qr.target || 'default' };
  return qr;
}
let polling = false;
async function pollLogin() {
  if (polling || !qr.key || qr.state === 'ok') return;
  polling = true;
  try {
    const r = await eapi('/login/qrcode/client/login', { key: qr.key, type: 1 });
    const code = r?.code;
    if (code === 803) {
      const acc = await eapi('/api/w/nuser/account/get', {});
      const uid = String(acc?.account?.id || '');
      const nick = acc?.profile?.nickname || '';
      if ((qr.target || 'default') === 'new') {
        const id = 'acc' + (uid || Date.now());
        const root = path.join(ROOT, 'accounts', uid || id);
        fs.mkdirSync(path.join(root, 'out2'), { recursive: true });
        fs.writeFileSync(path.join(root, 'cookie.txt'), cookieHeader());
        if (!REG.accounts.some(a => a.id === id)) REG.accounts.push({ id, nick, uid, root, dest: `/workspace/mounts/Download/网易云歌单导出-${nick || uid}` });
        REG.current = id;
      } else {
        const a = REG.accounts.find(x => x.id === qr.target) || REG.accounts[0];
        fs.writeFileSync(path.join(a.root, 'cookie.txt'), cookieHeader());
        if (nick) a.nick = nick;
      }
      saveReg(); cache.clear(); statsCache.at = 0;
      qr.state = 'ok'; qr.who = nick; jar = new Map();
    } else if (code === 802) qr.state = 'scanned';
    else if (code === 801) { if (qr.state !== 'scanned') { qr.state = 'waiting'; if (Date.now() - qr.at > 55000) await newQr(); } }
    else if (qr.state !== 'scanned') await newQr();
  } catch {} finally { polling = false; }
}
setInterval(pollLogin, 2000);

/* ---------------- 图片 ---------------- */
const IMG_CACHE = () => { const d = path.join(curOut(), 'imgcache'); fs.mkdirSync(d, { recursive: true }); return d; };
const PLACEHOLDER = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120"><rect width="120" height="120" fill="#e8e8ed"/><text x="60" y="70" font-size="34" text-anchor="middle" fill="#b0b0b6">♪</text></svg>');
async function grabImage(url) {
  const urls = [];
  if (url.startsWith('http://')) urls.push(url.replace('http://', 'https://'));
  urls.push(url);
  const m = url.match(/:\/\/(p\d)\.music\.126\.net\//);
  if (m) for (const n of ['p1', 'p2', 'p3', 'p4']) if (n !== m[1]) urls.push(url.replace(/:\/\/p\d\.music\.126\.net\//, `://${n}.music.126.net/`));
  for (const u of urls) {
    try {
      const r = await fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://music.163.com/' }, signal: AbortSignal.timeout(7000) });
      if (r.ok) { const b = Buffer.from(await r.arrayBuffer()); if (b.length > 200) return b; }
    } catch {}
  }
  return null;
}

/* ---------------- 字体 ---------------- */
const FONT_PKGS = ['noto-sans-symbols-2', 'noto-sans-yi', 'noto-sans-devanagari', 'noto-sans-thai', 'noto-sans-arabic', 'noto-sans-hebrew', 'noto-sans-armenian', 'noto-sans-ethiopic', 'noto-sans-georgian', 'noto-sans-sinhala', 'noto-sans-khmer', 'noto-sans-lao', 'noto-sans-myanmar', 'noto-serif-tibetan'];
let fontCss = null;
function buildFontCss() {
  if (fontCss) return fontCss;
  fontCss = FONT_PKGS.map(pkg => {
    const f = path.join(ROOT, 'node_modules/@fontsource', pkg, '400.css');
    return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').replace(/\.\/files\//g, `/fonts/${pkg}/`) : '';
  }).join('\n');
  return fontCss;
}

/* ---------------- HTTP ---------------- */
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url || '/', 'http://x');
  const p = decodeURIComponent(u.pathname);
  const json = o => { res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(o)); };
  const sendFile = (f, type) => {
    if (!fs.existsSync(f)) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': type || mime[path.extname(f)] || 'application/octet-stream' });
    fs.createReadStream(f).pipe(res);
  };

  /* API */
  if (p === '/api/status') {
    return json({
      accounts: REG.accounts.map(a => ({ id: a.id, nick: a.nick, uid: a.uid })),
      current: REG.current, dest: curAcc().dest, job, stats: getStats(), history,
    });
  }
  if (p === '/api/switch' && req.method === 'POST') {
    const id = u.searchParams.get('acc');
    if (!REG.accounts.some(a => a.id === id)) return json({ ok: false, error: '账号不存在' });
    REG.current = id; saveReg(); cache.clear(); statsCache.at = 0;
    return json({ ok: true });
  }
  if (p === '/api/playlists') {
    const feat = playlistFeatures();
    return json(getPlaylists().map(r => ({
      id: String(r.id), name: r.name, privacy: r.privacy, count: (r.rows || []).length, top: !!r.top,
      down: feat[String(r.id)]?.down || 0, special: feat[String(r.id)]?.special || 0,
      nonLatin: feat[String(r.id)]?.nonLatin || 0,
    })));
  }
  if (p.startsWith('/api/playlist/')) {
    const id = p.slice(14);
    const r = getPlaylists().find(x => String(x.id) === id);
    if (!r) { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: '未找到该歌单' })); }
    return json({
      id: String(r.id), name: r.name, privacy: r.privacy, description: r.description || '',
      company_filled: (r.rows || []).filter(s => s.company).length,
      rows: (r.rows || []).map(s => ({ name: s.name, ar: s.ar, al: s.al, alId: s.alId || 0, sid: s.id || 0, dur: s.dur || 0, company: s.company, masked: s.masked, ncr: s.ncr, cat: statusOf(s) })),
    });
  }
  if (p === '/api/proxy') {
    const e = await detectExit(true);
    return json({ url: e.url, source: e.source, port: e.port, at: e.at });
  }
  if (p === '/api/proxy/test' && req.method === 'POST') {
    let body = '';
    await new Promise(r => { req.on('data', c => body += c); req.on('end', r); });
    let url = '';
    try { url = JSON.parse(body || '{}').url || proxyCfg.url; } catch { url = proxyCfg.url; }
    const targets = ['https://www.youtube.com/', 'https://open.spotify.com/'];
    const out = [];
    for (const t of targets) {
      const t0 = Date.now();
      try {
        const opt = { method: 'GET', headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(8000) };
        if (url) opt.dispatcher = new ProxyAgent(url);
        const r = await fetch(t, opt);
        out.push({ target: t, ok: r.status < 500, status: r.status, ms: Date.now() - t0 });
      } catch (e) {
        out.push({ target: t, ok: false, reason: e.name === 'TimeoutError' ? '超时' : (e.message || '失败'), ms: Date.now() - t0 });
      }
    }
    return json({ via: url || '直连', results: out });
  }
  if (p === '/api/settings') {
    if (req.method === 'POST') {
      let body = '';
      await new Promise(r => { req.on('data', c => body += c); req.on('end', r); });
      try {
        const d = JSON.parse(body || '{}');
        const a = REG.accounts.find(x => x.id === d.id);
        if (!a) return json({ ok: false, error: '账号不存在' });
        if (typeof d.dest === 'string' && d.dest.trim()) a.dest = d.dest.trim();
        if (d.makeCurrent) REG.current = a.id;
        saveReg(); cache.clear(); statsCache.at = 0;
        return json({ ok: true });
      } catch (e) { return json({ ok: false, error: e.message }); }
    }
    return json({
      current: REG.current,
      accounts: REG.accounts.map(a => ({
        id: a.id, nick: a.nick, uid: a.uid, root: a.root, dest: a.dest,
        hasCookie: fs.existsSync(path.join(a.root, 'cookie.txt')),
        dataSize: (() => { try { return fs.statSync(path.join(a.root, 'out2/playlists_full.json')).size; } catch { return 0; } })(),
      })),
    });
  }
  if (p === '/api/dirs') {
    const base = u.searchParams.get('path') || '/workspace/mounts/Download';
    try {
      const items = fs.readdirSync(base, { withFileTypes: true })
        .filter(d => d.isDirectory() && !d.name.startsWith('.'))
        .map(d => ({ name: d.name, path: path.join(base, d.name) }))
        .slice(0, 80);
      return json({ base, items });
    } catch (e) { return json({ base, items: [], error: e.message }); }
  }
  if (p === '/api/collected-playlists') return json(getCollectedPlaylists().map(x => ({ id: x.id, name: x.name, creator: x.creator, count: x.trackCount })));
  if (p === '/api/created-albums') return json(getCreatedAlbums().map(x => ({ id: x.id, name: x.name, size: x.size, company: x.company, publishTime: x.publishTime })));
  if (p === '/api/collected-albums') return json(getAlbums().map(a => ({ id: a.id, name: a.name, artists: a.artists, size: a.size, company: a.company, publishTime: a.publishTime })));
  if (p === '/api/albums') return json(getAlbums().map(a => ({ id: a.id, name: a.name, artists: a.artists, size: a.size, company: a.company, publishTime: a.publishTime })));
  if (p.startsWith('/api/album/')) {
    const a = getAlbums().find(x => String(x.id) === p.slice(11));
    if (!a) { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: '未找到该专辑' })); }
    return json(a);
  }
  if (p === '/api/special') return json(getSpecial());
  if (p === '/api/find-batch') {
    const tab = u.searchParams.get('tab') || 'down';
    if (!['down', 'otherVersion', 'other', 'deleted'].includes(tab)) return json({ error: '分类无效' });
    try { return json(await findBatch(tab)); } catch (e) { return json({ error: e.message }); }
  }
  if (p === '/api/platforms') {
    try { return json(await probeAll()); } catch (e) { return json({ error: e.message }); }
  }
  if (p === '/api/find') {
    const n = u.searchParams.get('n') || '';
    const a = u.searchParams.get('a') || '';
    if (!n) return json({ error: '缺少歌名' });
    try { return json(await findEverywhere(n, a, u.searchParams.get('probe') === '1')); } catch (e) { return json({ error: e.message }); }
  }
  if (p.startsWith('/run/')) {
    if (req.method !== 'POST') { res.writeHead(405); return res.end('{}'); }
    return json(startJob(p.slice(5), u.searchParams.get('acc') || ''));
  }
  if (p === '/api/log/download') {
    res.writeHead(200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Disposition': `attachment; filename="netease-${job.mode || 'log'}-${fmt(Date.now()).replace(/[: ]/g, '-')}.log"`,
    });
    return res.end((job.lines || []).join('\n') || '（暂无日志）');
  }
  if (p === '/zip') {
    if (!fs.existsSync(curZip())) { res.writeHead(404); res.end('还没有压缩包'); return; }
    res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Disposition': 'attachment; filename="netease-export.zip"', 'Content-Length': fs.statSync(curZip()).size });
    return fs.createReadStream(curZip()).pipe(res);
  }
  if (p === '/api/login') {
    try {
      const acc = u.searchParams.get('acc') || '';
      if (acc) qr.target = acc;
      if (u.searchParams.get('new') === '1' || !qr.img) await newQr(qr.target);
      return json({ img: qr.img, at: qr.at, state: qr.state, who: qr.who });
    } catch (e) { return json({ error: e.message }); }
  }

  /* 图片 / 字体 */
  if (p === '/img') {
    const kind = u.searchParams.get('kind') === 'pl' ? 'pl' : 'al';
    const id = u.searchParams.get('id') || '';
    const size = u.searchParams.get('s') || '200';
    const cov = getCovers();
    const url = (kind === 'pl' ? (cov.playlists || {})[id] : (cov.albums || {})[id]) || '';
    if (!url) { res.writeHead(200, { 'Content-Type': 'image/svg+xml' }); return res.end(PLACEHOLDER); }
    const withSize = url + (url.includes('?') ? '&' : '?') + 'param=' + size + 'y' + size;
    const file = path.join(IMG_CACHE(), crypto.createHash('md5').update(withSize).digest('hex') + '.img');
    if (fs.existsSync(file)) { res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public,max-age=86400' }); return fs.createReadStream(file).pipe(res); }
    const buf = await grabImage(withSize);
    if (!buf) { res.writeHead(200, { 'Content-Type': 'image/svg+xml' }); return res.end(PLACEHOLDER); }
    fs.writeFileSync(file, buf);
    res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public,max-age=86400' });
    return res.end(buf);
  }
  if (p === '/fonts.css') {
    res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': 'public,max-age=86400' });
    return res.end(buildFontCss());
  }
  if (p.startsWith('/fonts/')) {
    const [, , pkg, file] = p.split('/');
    return sendFile(path.join(ROOT, 'node_modules/@fontsource', pkg, 'files', (file || '').replace(/[^A-Za-z0-9._-]/g, '')), 'font/woff2');
  }

  /* 页面与静态 */
  const pages = { '/': 'index.html', '/browse': 'browse.html', '/albums': 'albums.html', '/docs': 'docs.html', '/login': 'login.html', '/settings': 'settings.html' };
  if (pages[p]) return sendFile(path.join(PUBLIC, pages[p]), 'text/html; charset=utf-8');
  return sendFile(path.join(PUBLIC, path.basename(p)));
});

server.listen(PORT, '0.0.0.0', () => console.log('web panel on ' + PORT));
