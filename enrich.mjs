import fs from 'node:fs';
import path from 'node:path';
import { post } from './export.mjs';

const NC_ROOT = process.env.NC_ROOT || process.cwd();
const BASE_OUT = path.join(NC_ROOT, 'out2');
const STAGE_DIR = path.join(BASE_OUT, 'staging');
const USE_STAGE = process.env.NC_STAGE === '1' || fs.existsSync(path.join(STAGE_DIR, 'playlists_full.json'));
const OUT = USE_STAGE ? STAGE_DIR : BASE_OUT;
const FILE = path.join(OUT, 'playlists_full.json');
const rs = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const ids = [...new Set(rs.flatMap(r => r.rows.map(s => s.id)).filter(Boolean))];
console.log('曲目 ID', ids.length);

const meta = new Map();
const albumCovers = new Map();
for (let i = 0; i < ids.length; i += 800) {
  const batch = ids.slice(i, i + 800);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await post('/weapi/v3/song/detail', { c: JSON.stringify(batch.map(id => ({ id }))) });
      if (r?.code !== 200) throw new Error('code ' + r?.code);
      const priv = new Map((r.privileges || []).map(p => [p.id, p]));
      for (const s of r.songs || []) {
        const p = priv.get(s.id) || {};
        if (s.al?.id && s.al?.picUrl) albumCovers.set(String(s.al.id), s.al.picUrl);
        const st = typeof p.st === 'number' ? p.st : (typeof s.st === 'number' ? s.st : 0);
        const ncrType = s.noCopyrightRcmd ? s.noCopyrightRcmd.type : 0;
        const ncrDesc = s.noCopyrightRcmd ? (s.noCopyrightRcmd.typeDesc || '') : '';
        const altId = s.noCopyrightRcmd?.songId || '';
        let cat = 'ok';
        if (st < 0 || s.st < 0) {
          if (ncrType === 1 || altId) cat = 'otherVersion';
          else if (ncrType) cat = 'down';
          else cat = 'down';
        } else if (ncrType) {
          cat = ncrType === 1 || altId ? 'otherVersion' : 'other';
        }
        meta.set(s.id, {
          st, ncrType, ncrDesc, altId, cat, fee: s.fee ?? p.fee ?? 0,
          pop: s.pop ?? 0, mv: s.mv || 0,
          alia: (s.alia || []).filter(Boolean).join(' / '),
          tns: (s.tns || []).filter(Boolean).join(' / '),
          pl: p.pl ?? 0, dl: p.dl ?? 0, fl: p.fl ?? 0,
          pub: s.al?.publishTime || 0, pic: s.al?.picUrl || '',
        });
      }
      break;
    } catch (e) {
      if (attempt === 2) console.log('批次失败', i, e.message);
      await new Promise(r => setTimeout(r, 800 * (attempt + 1)));
    }
  }
  if ((i / 800) % 5 === 0) console.log('  进度', Math.min(i + 800, ids.length), '/', ids.length);
  await new Promise(r => setTimeout(r, 120));
}

let n = 0;
for (const r of rs) for (const s of r.rows) {
  const m = meta.get(s.id);
  if (!m) { s.cat = 'ok'; continue; }
  Object.assign(s, { st: m.st, ncrType: m.ncrType, ncrDesc: m.ncrDesc, altId: m.altId, cat: m.cat, pop: m.pop, mv: m.mv, alia: m.alia, tns: m.tns, pl: m.pl, dl: m.dl, fl: m.fl, pub: m.pub, pic: m.pic });
  if (m.cat !== 'ok') n++;
}
fs.writeFileSync(FILE, JSON.stringify(rs));

// 专辑封面 URL 落盘（供面板多源加载）
const COV = path.join(OUT, 'covers.json');
const cov = fs.existsSync(COV) ? JSON.parse(fs.readFileSync(COV, 'utf8')) : {};
cov.albums = { ...(cov.albums || {}), ...Object.fromEntries(albumCovers) };
fs.writeFileSync(COV, JSON.stringify(cov));
console.log('专辑封面', albumCovers.size, '张，累计', Object.keys(cov.albums).length);

const count = {};
for (const r of rs) for (const s of r.rows) count[s.cat] = (count[s.cat] || 0) + 1;
console.log('分类计数（按曲目行）', JSON.stringify(count));
const uniq = new Map();
for (const r of rs) for (const s of r.rows) if (s.cat !== 'ok') uniq.set(s.id, s.cat);
const uc = {};
for (const v of uniq.values()) uc[v] = (uc[v] || 0) + 1;
console.log('去重后', JSON.stringify(uc), '共', uniq.size);
for (const [id, cat] of [...uniq].filter(([, c]) => c === 'down').slice(0, 5)) {
  const s = rs.flatMap(r => r.rows).find(x => x.id === id);
  console.log('  下架样例:', s.name, '| st', s.st, '| ncr', s.ncrType, s.ncrDesc);
}
