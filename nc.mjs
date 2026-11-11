import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const IV = '0102030405060708';
const PRESET = '0CoJUm6Qyw8W8jud';
const PUBKEY = '010001';
const MODULUS = '00e0b509f6259df8642dbc35662901477df22677ec152b5ff68ace615bb7b725152b3ab17a876aea8a5aa76d2e417629ec4ee341f56135fccf695280104e0312ecbda92557c93870114af6c9d05c4f7f0c3685b7a46bee255932575cce10b424d813cfe4875d3e82047b97ddef52741d546b8e289dc6935b3ece0462db0a22b8e7';

function aes(text, key) {
  const c = crypto.createCipheriv('aes-128-cbc', Buffer.from(key, 'utf8'), Buffer.from(IV, 'utf8'));
  return Buffer.concat([c.update(Buffer.from(text, 'utf8')), c.final()]).toString('base64');
}

function rsaEncrypt(text) {
  const reversed = text.split('').reverse().join('');
  const hex = Buffer.from(reversed, 'utf8').toString('hex');
  const base = BigInt('0x' + hex);
  const e = BigInt('0x' + PUBKEY);
  const m = BigInt('0x' + MODULUS);
  let r = 1n, b = base, exp = e;
  while (exp > 0n) {
    if (exp & 1n) r = (r * b) % m;
    b = (b * b) % m;
    exp >>= 1n;
  }
  return r.toString(16).padStart(256, '0');
}

function weapi(object) {
  const text = JSON.stringify(object);
  const secretKey = crypto.randomBytes(16).toString('base64').slice(0, 16);
  return {
    params: aes(aes(text, PRESET), secretKey),
    encSecKey: rsaEncrypt(secretKey),
  };
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

async function call(path, object, extraHeaders = {}) {
  const body = new URLSearchParams(weapi(object)).toString();
  const cookieFile = path.join(process.cwd(), 'cookie.txt');
  let cookie = '';
  try { cookie = fs.readFileSync(cookieFile, 'utf8').trim(); } catch {}
  const res = await fetch('https://music.163.com' + path, {
    method: 'POST',
    headers: {
      'User-Agent': UA,
      'Referer': 'https://music.163.com/',
      'Content-Type': 'application/x-www-form-urlencoded',
      'Origin': 'https://music.163.com',
      ...(cookie ? { Cookie: cookie } : {}),
      ...extraHeaders,
    },
    body,
  });
  const setCookie = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  const json = await res.json().catch(() => null);
  return { status: res.status, json, setCookie };
}

const cmd = process.argv[2];

if (cmd === 'test') {
  const r = await call('/weapi/cloudsearch/get/web', { s: '周杰伦', type: 1, limit: 3, offset: 0 });
  console.log(JSON.stringify({ status: r.status, code: r.json?.code, songs: r.json?.result?.songs?.map(s => s.name + ' / ' + s.ar.map(a => a.name).join(',') + ' / ' + s.al.name) }, null, 2));
} else if (cmd === 'qr') {
  const r = await call('/weapi/login/qrcode/unikey', { type: 1 });
  console.log(JSON.stringify(r.json));
} else if (cmd === 'poll') {
  const key = process.argv[3];
  let done = false;
  for (let i = 0; i < 120 && !done; i++) {
    const r = await call('/weapi/login/qrcode/client/login', { key, type: 1 });
    const code = r.json?.code;
    if (code === 803) {
      const ck = r.setCookie.map(c => c.split(';')[0]).join('; ');
      fs.writeFileSync(path.join(process.cwd(), 'cookie.txt'), ck);
      console.log('LOGIN_OK ' + (r.json?.message || ''));
      done = true;
    } else if (code === 800 || code === 8821 || code === 8810) {
      console.log('EXPIRED code=' + code); done = true;
    } else {
      console.log('state ' + code + ' ' + (r.json?.message || ''));
    }
    if (!done) await new Promise(r => setTimeout(r, 1200));
  }
}
