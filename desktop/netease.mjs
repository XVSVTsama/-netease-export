// 网络与网易云数据接口（桌面版），对齐 APK 侧的 api.rs
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const IV = '0102030405060708';
const PRESET = '0CoJUm6Qyw8W8jud';
const PUBKEY = '010001';
const MODULUS = '00e0b509f6259df8642dbc35662901477df22677ec152b5ff68ace615bb7b725152b3ab17a876aea8a5aa76d2e417629ec4ee341f56135fccf695280104e0312ecbda92557c93870114af6c9d05c4f7f0c3685b7a46bee255932575cce10b424d813cfe4875d3e82047b97ddef52741d546b8e289dc6935b3ece0462db0a22b8e7';
const EKEY = 'e82ckenh8dichen8';
const UA_WEB = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const UA_APP = 'NeteaseMusic/8.9.70.240407164325(8009070);Dalvik/2.1.0 (Linux; U; Android 13; PJZ110 Build/TP1A.220905.001)';
const BASE = 'https://music.163.com';

const sleep = ms => new Promise(r => setTimeout(r, ms));

function aesCbc(text, key) {
  const c = crypto.createCipheriv('aes-128-cbc', Buffer.from(key, 'utf8'), Buffer.from(IV, 'utf8'));
  return Buffer.concat([c.update(Buffer.from(text, 'utf8')), c.final()]).toString('base64');
}
function rsaEnc(secret) {
  const base = BigInt('0x' + Buffer.from(secret.split('').reverse().join(''), 'utf8').toString('hex'));
  const m = BigInt('0x' + MODULUS);
  let r = 1n, b = base, e = BigInt('0x' + PUBKEY);
  while (e > 0n) { if (e & 1n) r = (r * b) % m; b = (b * b) % m; e >>= 1n; }
  return r.toString(16).padStart(256, '0');
}
function weapiBody(obj) {
  const text = JSON.stringify(obj);
  const secret = crypto.randomBytes(16).toString('base64').slice(0, 16);
  return new URLSearchParams({
    params: aesCbc(aesCbc(text, PRESET), secret),
    encSecKey: rsaEnc(secret),
  }).toString();
}
function eapiBody(p, obj) {
  const text = JSON.stringify(obj);
  const digest = crypto.createHash('md5').update(`nobody${p}use${text}md5forencrypt`).digest('hex');
  const data = `${p}-36cd479b6b5-${text}-36cd479b6b5-${digest}`;
  const c = crypto.createCipheriv('aes-128-ecb', Buffer.from(EKEY), null);
  return 'params=' + Buffer.concat([c.update(Buffer.from(data, 'utf8')), c.final()]).toString('hex').toUpperCase();
}

export class Netease {
  constructor(root) {
    this.root = root;
    this.cookies = new Map();
    this.loadCookie();
  }
  get cookieFile() { return path.join(this.root, 'cookie.txt'); }
  loadCookie() {
    try {
      const raw = fs.readFileSync(this.cookieFile, 'utf8').trim();
      for (const part of raw.split(';')) {
        const [k, ...v] = part.split('=');
        if (k && k.trim()) this.cookies.set(k.trim(), v.join('=').trim());
      }
    } catch {}
  }
  cookieHeader() {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }
  setCookie(raw) {
    for (const part of String(raw || '').split(';')) {
      const [k, ...v] = part.split('=');
      if (k && k.trim()) this.cookies.set(k.trim(), v.join('=').trim());
    }
    this.saveCookie();
  }
  saveCookie() {
    try { fs.mkdirSync(this.root, { recursive: true }); } catch {}
    fs.writeFileSync(this.cookieFile, this.cookieHeader());
  }
  clearCookie() {
    this.cookies.clear();
    try { fs.unlinkSync(this.cookieFile); } catch {}
  }
  get logged() { return this.cookies.has('MUSIC_U'); }

  async weapi(pathname, body = {}, ua = UA_WEB) {
    const ck = this.cookieHeader();
    const res = await fetch(BASE + pathname, {
      method: 'POST',
      headers: {
        'User-Agent': ua,
        Referer: 'https://music.163.com/',
        'Content-Type': 'application/x-www-form-urlencoded',
        ...(ck ? { Cookie: ck } : {}),
      },
      body: weapiBody(body),
      signal: AbortSignal.timeout(15000),
    });
    const j = await res.json().catch(() => null);
    if (!j) throw new Error(`HTTP ${res.status} 解析失败`);
    return j;
  }

  async eapi(short, body = {}) {
    const ck = this.cookieHeader();
    const cookie = (ck ? ck + '; ' : '') + 'os=android; appver=8.9.70; osver=13';
    const res = await fetch(BASE + '/eapi' + short, {
      method: 'POST',
      headers: { 'User-Agent': UA_APP, Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: eapiBody('/api' + short, {
        ...body,
        header: { os: 'android', appver: '8.9.70', osver: '13', deviceId: 'com.netease.cloudmusic', buildver: '1793900000', resolution: '1440x3200', mobilename: 'PJZ110' },
      }),
      signal: AbortSignal.timeout(25000),
    });
    const j = await res.json().catch(() => null);
    if (!j) throw new Error(`HTTP ${res.status} 解析失败`);
    return j;
  }

  // 账号信息
  async account() {
    if (!this.logged) return { logged: false };
    const r = await this.weapi('/weapi/w/nuser/account/get', {});
    const p = r.profile || r.account;
    if (!p) return { logged: false };
    return { logged: true, uid: p.userId || p.id, nickname: p.nickname || '' };
  }

  // 全部歌单（自己创建 + 收藏）
  async playlists(uid) {
    const out = [];
    let offset = 0;
    for (;;) {
      const r = await this.weapi('/weapi/user/playlist', { uid, limit: 1000, offset, includeVideo: true });
      const arr = r.playlist || [];
      for (const p of arr) {
        out.push({
          id: p.id,
          name: p.name,
          count: p.trackCount || 0,
          privacy: p.privacy || 0,
          creator: (p.creator && p.creator.nickname) || '',
          mine: !!(p.creator && p.creator.userId === uid),
          cover: p.coverImgUrl || '',
        });
      }
      if (arr.length < 1000) break;
      offset += 1000;
      await sleep(250);
      if (offset > 20000) break;
    }
    return out;
  }

  // 歌单详情（含 privilege，补齐超过 1000 首的部分）
  async playlistDetail(id, withCompany = false) {
    const r = await this.eapi('/v6/playlist/detail', { id: String(id), n: 100000, s: 8, t: 0 });
    if (r.code !== 200) throw new Error(`拉取歌单失败: ${r.message || r.code}`);
    const pl = r.playlist;
    const tracks = pl.tracks || [];
    const ids = (pl.trackIds || []).map(x => x.id);
    const privs = new Map();
    for (const p of r.privileges || []) privs.set(p.id, [p.st || 0, p.pl === undefined ? 1 : p.pl]);

    const got = new Map(tracks.map(t => [t.id, t]));
    if (ids.length > got.size) {
      for (let i = 0; i < ids.length; i += 400) {
        if (got.size >= ids.length) break;
        const chunk = ids.slice(i, i + 400);
        const sr = await this.weapi('/weapi/v3/song/detail', { c: JSON.stringify(chunk.map(x => ({ id: x }))) });
        for (const s of sr.songs || []) got.set(s.id, s);
        for (const p of sr.privileges || []) privs.set(p.id, [p.st || 0, p.pl === undefined ? 1 : p.pl]);
        await sleep(200);
      }
    }
    const order = ids.length ? ids : tracks.map(t => t.id);
    const rows = [];
    for (const sid of order) {
      const [st, plv] = privs.get(sid) || [0, 1];
      const s = got.get(sid);
      if (s) {
        rows.push(rowOf(s, st, plv, false));
      } else {
        rows.push({
          id: sid, name: '', ar: '', al: '', alId: 0, dur: 0, ncr: true, company: '',
          pop: 0, alia: '', mv: 0, fee: 0, st: st === 0 ? -200 : st, pl: 0, missing: true, cover: '',
        });
      }
    }
    if (withCompany) await this.fillCompanies(rows);
    return {
      id, name: pl.name || '', cover: pl.coverImgUrl || '',
      count: rows.length, rows,
      stats: classify(rows),
    };
  }

  async albumDetail(id) {
    const r = await this.weapi(`/weapi/album/${id}`, {});
    const a = r.album;
    if (!a) throw new Error(`专辑不存在或接口拒绝: ${r.code}`);
    const rows = (a.songs || []).map(s => rowOf(s, 0, 1, false, a.company || ''));
    return {
      id, name: a.name || '',
      artists: (a.artists || []).map(x => x.name).join(' / '),
      company: a.company || '',
      publishTime: a.publishTime || 0,
      cover: a.picUrl || '',
      count: rows.length, rows,
      stats: classify(rows),
    };
  }

  async collectedAlbums() {
    const out = [];
    let offset = 0;
    for (;;) {
      const r = await this.weapi('/weapi/album/sublist', { limit: 25, offset, total: true });
      const arr = r.data || r.albums || [];
      for (const a of arr) {
        out.push({
          id: a.id, name: a.name,
          artists: (a.artists || []).map(x => x.name).join(' / '),
          size: a.size || 0, company: a.company || '',
          publishTime: a.publishTime || 0, cover: a.picUrl || '',
        });
      }
      if (arr.length < 25) break;
      offset += 25;
      await sleep(250);
      if (out.length > 20000) break;
    }
    return out;
  }

  // 专辑厂牌：三种办法各试十次
  async fillCompanies(rows) {
    const ids = [...new Set(rows.map(r => r.alId).filter(x => x > 0))];
    const cache = new Map();
    for (const aid of ids) {
      const cmp = await this.albumCompany(aid);
      if (cmp !== null) cache.set(aid, cmp);
    }
    for (const r of rows) {
      if (r.alId && cache.has(r.alId) && !r.company) r.company = cache.get(r.alId);
    }
    return cache;
  }

  async albumCompany(aid) {
    const pathname = `/weapi/v1/album/${aid}`;
    for (let i = 0; i < 10; i++) {
      try {
        const j = await this.weapi(pathname, {});
        if (j.code === 200) return (j.album && j.album.company) || '';
      } catch {}
      await sleep(200 + i * 150);
    }
    for (let i = 0; i < 10; i++) {
      try {
        const j = await this.eapi(`/v1/album/${aid}`, { id: String(aid) });
        if (j.code === 200) return (j.album && j.album.company) || '';
      } catch {}
      await sleep(200 + i * 150);
    }
    return null;
  }
}

function rowOf(s, st, pl, missing, forcedCompany) {
  const al = s.al || s.album || {};
  const ar = s.ar || s.artists || [];
  return {
    id: s.id,
    name: s.name || '',
    ar: ar.map(x => x.name).join(' / '),
    al: al.name || '',
    alId: al.id || 0,
    dur: s.dt || s.duration || 0,
    ncr: !!s.noCopyrightRcmd,
    company: forcedCompany || '',
    pop: s.pop || s.popularity || 0,
    alia: (s.alia || s.alias || []).join(' / '),
    mv: s.mv || s.mvid || 0,
    fee: s.fee || 0,
    st, pl, missing: !!missing,
    cover: al.picUrl || '',
  };
}

export function blockReason(r) {
  if (r.missing) return '详情缺失';
  if (r.st === -200) return '已下架';
  if (r.pl === 0) return '无版权';
  if (r.ncr) return '仅其他版本可播';
  return '';
}

export function classify(rows) {
  let down = 0, otherVersion = 0, special = 0, nonLatin = 0;
  const specialRe = /[\p{Mn}\p{Mc}\p{Cf}\p{So}\p{Co}]/u;
  const nonLatinRe = /[\p{Script=Cyrillic}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Greek}\p{Script=Devanagari}\p{Script=Tibetan}\p{Script=Thai}\p{Script=Yi}\p{Script=Mongolian}\p{Script=Georgian}\p{Script=Armenian}\p{Script=Ethiopic}\p{Script=Sinhala}\p{Script=Khmer}\p{Script=Lao}\p{Script=Myanmar}]/u;
  const items = [];
  for (const r of rows) {
    if (blockReason(r)) down++;
    if (r.ncr) otherVersion++;
    if (specialRe.test(r.name || '')) special++;
    if (nonLatinRe.test(r.name || '')) nonLatin++;
    const kinds = [];
    if (blockReason(r)) kinds.push('down');
    if (r.ncr) kinds.push('otherVersion');
    if (specialRe.test(r.name || '')) kinds.push('special');
    if (nonLatinRe.test(r.name || '')) kinds.push('nonLatin');
    if (kinds.length) items.push({ id: r.id, name: r.name, ar: r.ar, al: r.al, company: r.company, missing: !!r.missing, kinds });
  }
  return { down, otherVersion, special, nonLatin, total: rows.length, items };
}
