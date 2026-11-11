import fs from 'node:fs';
import path from 'node:path';
import { post } from './export.mjs';

const NC_ROOT = process.env.NC_ROOT || process.cwd();
const BASE_OUT = path.join(NC_ROOT, 'out2');
const STAGE_DIR = path.join(BASE_OUT, 'staging');
const USE_STAGE = process.env.NC_STAGE === '1' || fs.existsSync(path.join(STAGE_DIR, 'playlists_full.json'));
const OUT = USE_STAGE ? STAGE_DIR : BASE_OUT;
const JSONF = path.join(OUT, 'collected_playlists.json');
const COV = path.join(OUT, 'covers.json');
const mode = process.argv[2] || 'sync';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const one = s => String(s || '').replace(/\s+/g, ' ').trim();

async function syncCollected() {
  const acc = await post('/weapi/w/nuser/account/get');
  if (acc?.code !== 200 || !acc?.account) { console.error('登录失效'); process.exit(2); }
  const uid = acc.account.id;
  const nick = acc.profile?.nickname || '';
  const r = await post('/weapi/user/playlist', { uid, limit: 1000, offset: 0, includeVideo: true });
  const all = [];
  const seen = new Set();
  for (const p of r?.playlist || []) {
    if (String(p.userId) === String(uid)) continue;   // 只要收藏的
    if (seen.has(p.id)) continue;
    seen.add(p.id);
    all.push({
      id: String(p.id),
      name: one(p.name),
      creator: one(p.creator?.nickname),
      creatorId: String(p.creator?.userId || ''),
      trackCount: p.trackCount || 0,
      playCount: p.playCount || 0,
      description: p.description || '',
      updateTime: p.updateTime || 0,
      coverImgUrl: p.coverImgUrl || '',
    });
  }
  fs.writeFileSync(JSONF, JSON.stringify(all));
  const cov = fs.existsSync(COV) ? JSON.parse(fs.readFileSync(COV, 'utf8')) : {};
  cov.playlists = { ...(cov.playlists || {}) };
  for (const p of all) if (p.coverImgUrl) cov.playlists[p.id] = p.coverImgUrl;
  fs.writeFileSync(COV, JSON.stringify(cov));
  const totalSongs = all.reduce((n, p) => n + p.trackCount, 0);
  log(`收藏歌单同步完成：${all.length} 个（曲目合计 ${totalSongs}），账号 ${nick}`);
}

function tidyCollected() {
  if (!fs.existsSync(JSONF)) { console.error('缺少 collected_playlists.json，先跑收藏歌单同步'); process.exit(3); }
  const list = JSON.parse(fs.readFileSync(JSONF, 'utf8'));
  const esc = v => String(v || '').replace(/\|/g, '\\|');
  const fmtDate = ts => { if (!ts) return '—'; const d = new Date(ts), p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };
  const L = [
    '# 我收藏的歌单', '',
    `- 数量：${list.length} 个`,
    `- 曲目合计：${list.reduce((n, p) => n + p.trackCount, 0)} 首（含跨歌单重复）`,
    `- 更新时间：${new Date().toLocaleString('zh-CN', { hour12: false })}`,
    '',
    '| # | 歌单 | 创建者 | 曲目 | 播放量 | 更新时间 | 链接 |',
    '| --- | --- | --- | --- | --- | --- | --- |',
  ];
  list.forEach((p, i) => L.push(`| ${i + 1} | ${esc(p.name)} | ${esc(p.creator)} | ${p.trackCount} | ${p.playCount} | ${fmtDate(p.updateTime)} | https://music.163.com/playlist?id=${p.id} |`));
  fs.mkdirSync(path.join(OUT, '收藏'), { recursive: true });
  fs.writeFileSync(path.join(OUT, '收藏/00_收藏歌单索引.md'), L.join('\n'));

  const csv = ['序号,歌单,创建者,曲目数,播放量,更新时间,歌单ID'];
  list.forEach((p, i) => csv.push([i + 1, p.name, p.creator, p.trackCount, p.playCount, fmtDate(p.updateTime), p.id].map(v => `"${String(v || '').replace(/"/g, '""')}"`).join(',')));
  fs.mkdirSync(path.join(OUT, '表格'), { recursive: true });
  fs.writeFileSync(path.join(OUT, '表格/collected_playlists.csv'), '\ufeff' + csv.join('\n'));
  log(`收藏歌单整理完成：md + csv（${list.length} 个）`);
}

function checkCollected() {
  const issues = [];
  const add = (name, ok, detail) => { console.log(`${ok ? '[PASS]' : '[FAIL]'} ${name}｜${detail}`); if (!ok) issues.push(name); };
  if (!fs.existsSync(JSONF)) { console.log('[FAIL] collected_playlists.json 缺失'); process.exit(1); }
  const list = JSON.parse(fs.readFileSync(JSONF, 'utf8'));
  const mdF = path.join(OUT, '收藏/00_收藏歌单索引.md');
  const md = fs.existsSync(mdF) ? fs.readFileSync(mdF, 'utf8') : '';
  const mdRows = md.split('\n').filter(l => /^\| \d+ \|/.test(l)).length;
  const csvF = path.join(OUT, '表格/collected_playlists.csv');
  const csvRows = fs.existsSync(csvF) ? fs.readFileSync(csvF, 'utf8').trim().split('\n').length - 1 : 0;
  const ids = new Set(list.map(p => p.id));
  add('歌单数与 md 一致', mdRows === list.length, `JSON ${list.length} / md ${mdRows}`);
  add('歌单数与 csv 一致', csvRows === list.length, `JSON ${list.length} / csv ${csvRows}`);
  add('无重复歌单', ids.size === list.length, list.length - ids.size ? `${list.length - ids.size} 条重复` : '无重复');
  add('封面覆盖', true, `${list.filter(p => p.coverImgUrl).length} / ${list.length} 有封面`);
  add('创建者信息', true, `${list.filter(p => p.creator).length} / ${list.length} 有创建者`);
  console.log('');
  console.log(`问题合计 ${issues.length}`);
  if (issues.length) process.exit(1);
  else console.log('收藏歌单数据全部通过');
}

if (mode === 'sync') await syncCollected();
else if (mode === 'tidy') tidyCollected();
else if (mode === 'check') checkCollected();
else { console.error('用法: node cpl.mjs sync|tidy|check'); process.exit(64); }
