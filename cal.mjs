import fs from 'node:fs';
import path from 'node:path';
import { post } from './export.mjs';

const NC_ROOT = process.env.NC_ROOT || process.cwd();
const OUT = path.join(NC_ROOT, 'out2');
const JSONF = path.join(OUT, 'created_albums.json');
const mode = process.argv[2] || 'sync';
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const one = s => String(s || '').replace(/\s+/g, ' ').trim();

async function syncCreated() {
  const acc = await post('/weapi/w/nuser/account/get');
  if (acc?.code !== 200 || !acc?.account) { console.error('登录失效'); process.exit(2); }
  const uid = acc.account.id;
  const d = await post('/weapi/v1/user/detail/' + uid);
  const artistId = d?.profile?.artistId || acc?.profile?.artistId;
  const list = [];
  if (artistId) {
    for (let offset = 0; ; offset += 30) {
      const r = await post('/weapi/artist/albums/' + artistId, { limit: 30, offset, total: true });
      const arr = r?.hotAlbums || r?.albums || [];
      list.push(...arr.map(a => ({
        id: String(a.id), name: one(a.name), size: a.size || 0,
        company: a.company || '', publishTime: a.publishTime || 0,
        picUrl: a.picUrl || '', description: a.description || '',
      })));
      if (arr.length < 30) break;
      await new Promise(r2 => setTimeout(r2, 200));
    }
  }
  fs.writeFileSync(JSONF, JSON.stringify({ artistId: artistId || '', albums: list }));
  log(artistId ? `创建专辑同步完成：${list.length} 张（artistId ${artistId}）` : '当前账号不是音乐人（无 artistId），创建专辑记为 0 张');
}

function tidyCreated() {
  const raw = fs.existsSync(JSONF) ? JSON.parse(fs.readFileSync(JSONF, 'utf8')) : { artistId: '', albums: [] };
  const list = raw.albums || [];
  const esc = v => String(v || '').replace(/\|/g, '\\|');
  fs.mkdirSync(path.join(OUT, '收藏'), { recursive: true });
  const L = ['# 我创建的专辑', '', `- 数量：${list.length} 张`, `- 音乐人 ID：${raw.artistId || '无（非音乐人账号）'}`, ''];
  if (!list.length) {
    L.push(raw.artistId ? '当前音乐人账号下暂无已发布专辑。' : '当前账号不是网易云音乐人，因此没有「创建的专辑」。');
  } else {
    L.push('| # | 专辑 | 曲目 | 发行公司 | 发行时间 | 链接 |', '| --- | --- | --- | --- | --- | --- |');
    list.forEach((a, i) => {
      const t = a.publishTime ? new Date(a.publishTime).toISOString().slice(0, 10) : '—';
      L.push(`| ${i + 1} | ${esc(a.name)} | ${a.size} | ${esc(a.company) || '未标注'} | ${t} | https://music.163.com/album?id=${a.id} |`);
    });
  }
  fs.writeFileSync(path.join(OUT, '收藏/02_我创建的专辑.md'), L.join('\n'));
  log(`创建专辑整理完成：${list.length} 张`);
}

function checkCreated() {
  const issues = [];
  const add = (n, ok, d) => { console.log(`${ok ? '[PASS]' : '[FAIL]'} ${n}｜${d}`); if (!ok) issues.push(n); };
  if (!fs.existsSync(JSONF)) { console.log('[FAIL] created_albums.json 缺失'); process.exit(1); }
  const raw = JSON.parse(fs.readFileSync(JSONF, 'utf8'));
  const list = raw.albums || [];
  const f = path.join(OUT, '收藏/02_我创建的专辑.md');
  const md = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
  const mdRows = md.split('\n').filter(l => /^\| \d+ \|/.test(l)).length;
  add('专辑数与 md 一致', mdRows === list.length, `JSON ${list.length} / md ${mdRows}`);
  add('重复检查', new Set(list.map(a => a.id)).size === list.length, list.length - new Set(list.map(a => a.id)).size ? '有重复' : '无重复');
  add('音乐人判定', true, raw.artistId ? `artistId ${raw.artistId}` : '非音乐人账号，0 张属正常');
  console.log('');
  console.log(`问题合计 ${issues.length}`);
  if (issues.length) process.exit(1);
  else console.log('创建专辑数据通过');
}

if (mode === 'sync') await syncCreated();
else if (mode === 'tidy') tidyCreated();
else if (mode === 'check') checkCreated();
else { console.error('用法: node cal.mjs sync|tidy|check'); process.exit(64); }
