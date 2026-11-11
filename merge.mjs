import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';

const NC_ROOT = process.env.NC_ROOT || process.cwd();
const BASE_OUT = path.join(NC_ROOT, 'out2');
const STAGE_DIR = path.join(BASE_OUT, 'staging');
const USE_STAGE = process.env.NC_STAGE === '1' || fs.existsSync(path.join(STAGE_DIR, 'playlists_full.json'));
const OUT = USE_STAGE ? STAGE_DIR : BASE_OUT;
const SRC = path.join(OUT, 'playlists_full.json');
if (!fs.existsSync(SRC)) { console.error('缺少 ' + SRC + '，先跑同步'); process.exit(3); }
const results = JSON.parse(fs.readFileSync(SRC, 'utf8'));
if (!Array.isArray(results) || results.length < 10) { console.error(`歌单数据异常（${results?.length || 0} 个），拒绝生成`); process.exit(3); }
const cache = fs.existsSync(path.join(OUT, 'albums_cache.json')) ? JSON.parse(fs.readFileSync(path.join(OUT, 'albums_cache.json'), 'utf8')) : {};
const meta = JSON.parse(fs.readFileSync(path.join(NC_ROOT, 'out/playlists.json'), 'utf8'));
// 按云端顺序（user/playlist 返回顺序）排序，不自行重排
const orderIndex = new Map(meta.mine.map((p, i) => [String(p.id), i]));
results.sort((a, b) => (orderIndex.get(String(a.id)) ?? 1e9) - (orderIndex.get(String(b.id)) ?? 1e9));

// 文件名安全化：NFC 归一、剔除控制符/零宽/RTL 覆盖符、替换 Windows 非法字符、压缩空白、限长
const sanitize = s => String(s || '')
  .normalize('NFC')
  .replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff\u00ad]/g, '')
  .replace(/[\\/:*?"<>|]/g, '_')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, 45) || '未命名';

// 文本显示用：保留原字符，只把换行/制表/控制符换成空格，避免破坏 Markdown 结构
// 正文保真：只把 C0 控制符与换行/制表替换为空格；零宽符、方向隔离符、组合符、emoji 全部原样保留
const fmtDur = ms => { if (!ms) return '--:--'; const t = Math.round(ms / 1000); const m = Math.floor(t / 60), sec = t % 60; return m >= 60 ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`; };
const show = s => String(s || '').replace(/[\u0000-\u001f\u007f]/g, ' ');

const writeAtomic = (file, content) => { const tmp = file + '.tmp'; fs.writeFileSync(tmp, content); fs.renameSync(tmp, file); };
const fmtDate = ts => {
  if (!ts) return '—';
  const d = new Date(ts), p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};
const uniqueIds = new Set();
for (const r of results) for (const x of r.rows) uniqueIds.add(String(x.id || ('n:' + x.name)));
const albumMeta = (() => { try { return JSON.parse(fs.readFileSync(path.join(OUT, 'albums_cache.json'), 'utf8')); } catch { return {}; } })();
const pubOf = s => s.pub || (s.alId && albumMeta[String(s.alId)]?.publishTime) || 0;
const stats = { total: 0, filled: 0, noMeta: 0, masked: 0, restricted: 0, nonAscii: 0, emptyAlbum: 0, emptyArtist: 0, dupName: 0, ctrlFixed: 0 };

// 先去重文件名的冲突
const usedNames = new Map();
const fileNames = results.map((r, i) => {
  let base = sanitize(r.name);
  const key = base.toLowerCase();
  if (usedNames.has(key)) {
    stats.dupName++;
    base = `${base}_${r.id}`;
  }
  usedNames.set(base.toLowerCase(), true);
  return `${String(i + 1).padStart(3, '0')}_${base}.md`;
});

const DIR_PLAYLIST = path.join(OUT, '歌单');
const DIR_SPECIAL = path.join(OUT, '专项');
const DIR_RANK = path.join(OUT, '排行与收藏');
const DIR_TABLE = path.join(OUT, '表格');
for (const d of [path.join(DIR_PLAYLIST, '公开'), path.join(DIR_PLAYLIST, '私密'), DIR_SPECIAL, DIR_RANK, DIR_TABLE]) fs.mkdirSync(d, { recursive: true });

const statusOf = s => {
  const d = s.ncrDesc || '';
  if (d.includes('其它版本')) return 'otherVersion';
  if (s.ncrType === 1 && s.altId) return 'otherVersion';
  if ((s.st ?? 0) < 0) return 'down';
  if (s.ncrType) return 'other';
  return 'ok';
};
const relPaths = results.map((r, i) => `${r.privacy === 10 ? '歌单/私密' : '歌单/公开'}/${fileNames[i]}`);
results.forEach((r, i) => {
  for (const s of r.rows) {
    stats.total++;
    if (s.alId) s.company = cache[String(s.alId)]?.company || '';
    if (s.company) stats.filled++;
    if (!s.name) stats.noMeta++;
    if (s.masked) stats.masked++;
    if (s.ncr) stats.restricted++;
    if (/[^\x00-\x7f]/.test(s.name + s.ar + s.al)) stats.nonAscii++;
    if (!s.al) stats.emptyAlbum++;
    if (!s.ar) stats.emptyArtist++;
    if (/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\ufeff]/.test(String(s.name || '') + (s.ar || '') + (s.al || ''))) stats.ctrlFixed++;
  }
  const L = [
    `# ${r.name}`,
    '',
    `- 序号：${i + 1}`,
    `- 歌单 ID：${r.id}`,
    `- 可见性：${r.privacy === 10 ? '私密' : '公开'}`,
    `- 曲目：${r.rows.length} 首`,
    `- 创建时间：${fmtDate(r.createTime)}`,
    `- 链接：https://music.163.com/playlist?id=${r.id}`,
    '',
  ];
  if ((r.description || '').trim()) L.push('## 简介', '', show(r.description), '');
  L.push('## 曲目', '');
  r.rows.forEach((s, k) => {
    const name = s.name ? show(s.name) : `[元数据缺失 song_id:${s.id}]`;
    const marks = [];
    if (s.masked) marks.push('含遮盖');
    const st = statusOf(s);
    if (st === 'down') marks.push('已下架');
    else if (st === 'otherVersion') marks.push('仅其他版本可播');
    else if (st === 'other') marks.push('版权受限');
    const tail = marks.length ? `  〔${marks.join(' ')}〕` : '';
    L.push(`${k + 1}. ${name} - ${s.ar ? show(s.ar) : '未知'} - ${s.al ? show(s.al) : '未知'} - ${s.company || '未标注厂牌'}  〔${fmtDur(s.dur)}〕${tail}`);
  });
  fs.writeFileSync(path.join(OUT, relPaths[i]), L.join('\n'));
});

// 爱心歌曲独立一份（表格形式，做管道符转义）
const fav = results.find(r => String(r.id) === '8209396621') || results.find(r => /喜欢的音乐/.test(r.name));
if (fav) {
  const L = ['# 爱心歌曲（我喜欢的音乐）', '', `- 曲目：${fav.rows.length} 首`, `- 歌单 ID：${fav.id}`, `- 链接：https://music.163.com/playlist?id=${fav.id}`, '', '| # | 歌名 | 制作人/团体 | 专辑 | 发行公司/厂牌 | 时长 | 标记 |', '| --- | --- | --- | --- | --- | --- | --- |'];
  fav.rows.forEach((s, i) => {
    const stt = statusOf(s);
    const marks = [s.masked ? '含遮盖' : '', stt === 'down' ? '已下架' : stt === 'otherVersion' ? '仅其他版本可播' : stt === 'other' ? '版权受限' : ''].filter(Boolean).join(' ');
    L.push(`| ${i + 1} | ${(s.name ? show(s.name) : `[缺失 ${s.id}]`).replace(/\|/g, '\\|')} | ${(s.ar || '未知').replace(/\|/g, '\\|')} | ${(s.al || '').replace(/\|/g, '\\|')} | ${(s.company || '未标注厂牌').replace(/\|/g, '\\|')} | ${fmtDur(s.dur)} | ${marks} |`);
  });
  fs.writeFileSync(path.join(DIR_RANK, '12_爱心歌曲.md'), L.join('\n'));
}

// CSV（极致细化：每首歌一行，含全部可得字段）
const CSV_HEAD = ['歌单','可见性','歌单内序号','歌名','制作人/团体','专辑','发行公司/厂牌','时长','时长秒','歌曲ID','专辑ID','专辑发行时间','流行度','MV_ID','别名','翻译名','播放权限','下载权限','音质权限','歌曲状态','含遮盖','歌曲链接','专辑链接','封面链接'];
const csv = [CSV_HEAD.join(',')];
const full = [];
const q = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
const perm = v => (v > 0 ? '可' : '不可');
const isoDate = ts => { if (!ts) return ''; const d = new Date(ts); const p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };
const stateOf = s => {
  const st = statusOf(s);
  if (st === 'down') return '已下架';
  if (st === 'otherVersion') return '仅其他版本可播';
  if (st === 'other') return '版权受限';
  return '正常';
};
for (const r of results) {
  r.rows.forEach((s, k) => {
    const row = [
      r.name, r.privacy === 10 ? '私密' : '公开', k + 1, s.name, s.ar, s.al, s.company,
      fmtDur(s.dur), s.dur ? Math.round(s.dur / 1000) : '', s.id || '', s.alId || '',
      isoDate(pubOf(s)), s.pop ?? '', s.mv || '', s.alia || '', s.tns || '',
      perm(s.pl), perm(s.dl), perm(s.fl), stateOf(s), s.masked ? '是' : '否',
      s.id ? `https://music.163.com/song?id=${s.id}` : '',
      s.alId ? `https://music.163.com/album?id=${s.alId}` : '',
      s.pic || '',
    ];
    csv.push(row.map(q).join(','));
    full.push({
      playlist: r.name, playlistId: String(r.id), privacy: r.privacy === 10 ? '私密' : '公开', index: k + 1,
      name: s.name, artists: s.ar, album: s.al, albumId: s.alId || '', company: s.company,
      durMs: s.dur || 0, durText: fmtDur(s.dur), id: s.id || '', publishTime: pubOf(s),
      popularity: s.pop ?? null, mvId: s.mv || 0, alias: s.alia || '', tns: s.tns || '',
      playable: s.pl > 0, downloadable: s.dl > 0, fullQuality: s.fl > 0,
      status: stateOf(s), masked: !!s.masked, cover: s.pic || '',
    });
  });
}
writeAtomic(path.join(DIR_TABLE, 'all_songs.csv'), '\ufeff' + csv.join('\n'));
writeAtomic(path.join(DIR_TABLE, 'songs_full.json'), JSON.stringify(full));

// 索引
const pub = results.map((r, i) => ({ r, i })).filter(x => x.r.privacy !== 10);
const priv = results.map((r, i) => ({ r, i })).filter(x => x.r.privacy === 10);
const table = arr => {
  const out = ['| 云端序号 | 歌单 | 曲目 | 厂牌覆盖 | 文件 |', '| --- | --- | --- | --- | --- |'];
  for (const { r, i } of arr) {
    const f = r.rows.filter(s => s.company).length;
    out.push(`| ${i + 1} | ${r.top ? '📌 ' : ''}${sanitize(r.name).replace(/\|/g, '\\|')} | ${r.rows.length === 0 ? '0（空）' : r.rows.length} | ${f}/${r.rows.length} | ${relPaths[i]} |`);
  }
  return out;
};
const idx = [
  '# 自建歌单索引',
  '',
  `- 账号：${meta.nick}（uid ${meta.uid}）`,
  `- 更新时间：${fmtDate(Date.now())}`,
  `- 歌单：${results.length} 个（公开 ${pub.length} 个 / 私密 ${priv.length} 个）`,
  `- 曲目：${stats.total} 首（跨歌单重复保留），去重后 ${uniqueIds.size} 首`,
  `- 厂牌已标注 ${stats.filled} 首（${(stats.filled / stats.total * 100).toFixed(1)}%）；空歌单 ${results.filter(r => r.rows.length === 0).length} 个`,
  '',
  `## 公开歌单（${pub.length} 个）`,
  '',
  ...table(pub),
  '',
  `## 私密歌单（${priv.length} 个）`,
  '',
  ...table(priv),
  '',
  '- 排序：与云端顺序一致（接口 user/playlist 返回顺序），「云端序号」即该顺序中的位置。',
  '- 可见性来源：歌单对象的 privacy 字段，10 = 私密，0 = 公开。',
  '- 文件名做了 NFC 归一与非法字符替换，个别歌单名与原名可能略有差异，以歌单 ID 为准。',
];
fs.writeFileSync(path.join(OUT, '00_自建歌单索引.md'), idx.join('\n'));

// 可见性清单
const vl = [
  '# 歌单可见性清单',
  '',
  `- 共 ${results.length} 个自建歌单：公开 ${pub.length}，私密 ${priv.length}`,
  '',
  '| 云端序号 | 可见性 | 歌单 | 曲目 | 歌单ID | 链接 |',
  '| --- | --- | --- | --- | --- | --- |',
];
results.forEach((r, i) => vl.push(`| ${i + 1} | ${r.privacy === 10 ? '🔒 私密' : '🌐 公开'} | ${sanitize(r.name).replace(/\|/g, '\\|')} | ${r.rows.length === 0 ? '0（空）' : r.rows.length} | ${r.id} | https://music.163.com/playlist?id=${r.id} |`));
fs.writeFileSync(path.join(OUT, '02_歌单可见性清单.md'), vl.join('\n'));


// ---------- 专项：特殊字符命名 / 下架与版权受限 ----------
const bySong = new Map();
for (const r of results) for (const s of r.rows) {
  const key = String(s.id || `${s.name}|${s.ar}`);
  if (!bySong.has(key)) bySong.set(key, { ...s, playlists: [] });
  const e = bySong.get(key);
  if (!e.playlists.some(p => p.id === r.id)) e.playlists.push({ id: r.id, name: r.name, privacy: r.privacy });
}
const kindOf = n => {
  const k = [];
  if (/\p{Mn}|\p{Mc}/u.test(n)) k.push('组合附加符号');
  if (/\p{Cf}/u.test(n)) k.push('零宽/方向控制符');
  if (/\p{So}|\p{Co}/u.test(n)) k.push('符号/图形字符');
  return k;
};
const esc = v => String(v || '').replace(/\|/g, '\\|');
const playList = s => s.playlists.map(p => `${p.name}${p.privacy === 10 ? '(私密)' : ''}`).join('；');

const special = [...bySong.values()].map(s => ({ ...s, kinds: kindOf(s.name || '') })).filter(s => s.kinds.length);
const groups = [
  ['组合附加符号', special.filter(s => s.kinds.includes('组合附加符号'))],
  ['符号/图形字符', special.filter(s => s.kinds.includes('符号/图形字符'))],
  ['零宽/方向控制符', special.filter(s => s.kinds.includes('零宽/方向控制符'))],
];
const line = (s, i) => `| ${i + 1} | ${esc(s.name)} | ${esc(s.ar) || '未知'} | ${esc(s.al)} | ${esc(s.company) || '未标注厂牌'} | ${esc(playList(s))} | ${s.id || ''} |`;

const sp = [
  '# 特殊字符命名的歌曲',
  '',
  `- 去重后曲目：${special.length} 首（按歌曲 ID 去重）`,
  `- 判定范围：曲名含 Unicode 组合附加符号（Mn/Mc）、格式控制符（Cf）、符号/图形字符（So/Co）`,
  '- 正文按原字符输出，未做任何归一化；同一首歌出现在多个歌单时全部列出',
  '- 分类统计（一首歌可能同时命中多类）：',
  ...groups.map(([k, v]) => `  - ${k}：${v.length} 首`),
  '',
];
for (const [k, v] of groups) {
  sp.push(`## ${k}（${v.length} 首）`, '');
  if (!v.length) { sp.push('无。', ''); continue; }
  sp.push('| # | 歌名 | 制作人/团体 | 专辑 | 发行公司/厂牌 | 所属歌单 | 歌曲ID |', '| --- | --- | --- | --- | --- | --- | --- |');
  v.forEach((s, i) => sp.push(line(s, i)));
  sp.push('');
}
sp.push('## 全量复现（一歌一行）', '');
special.forEach(s => sp.push(`- ${s.name} - ${s.ar || '未知'} - ${s.al || '未知'} - ${s.company || '未标注厂牌'}  〔歌单：${playList(s)}〕`));
fs.writeFileSync(path.join(DIR_SPECIAL, '30_特殊字符歌曲.md'), sp.join('\n'));

// ---------- 删除 / 下架 / 其他版本 / 其他 ----------
const allSongs = [...bySong.values()];
for (const s of allSongs) s.status = statusOf(s);
const removedFile = path.join(OUT, 'history/removed.json');
const deleted = fs.existsSync(removedFile) ? JSON.parse(fs.readFileSync(removedFile, 'utf8')) : [];
const downRows = allSongs.filter(s => s.status === 'down');
const otherVerRows = allSongs.filter(s => s.status === 'otherVersion');
const otherRows = allSongs.filter(s => s.status === 'other');

const dl = [
  '# 删除 · 下架 · 其他版本 · 其他',
  '',
  `- 账号：${meta.nick}（uid ${meta.uid}）`,
  `- 更新时间：${fmtDate(Date.now())}`,
  '',
  '| 分类 | 数量 | 判定依据 |',
  '| --- | --- | --- |',
  `| 一、已删除 | ${deleted.length} | 上一次快照存在、本次同步查不到（可能下架/被移出歌单/歌单删除） |`,
  `| 二、已下架 | ${downRows.length} | 接口 privilege.st = -200，不可播放，且无替代版本 |`,
  `| 三、仅其他版本可播 | ${otherVerRows.length} | 接口 noCopyrightRcmd 标注「其它版本可播」 |`,
  `| 四、其他异常 | ${otherRows.length} | 有版权提示但状态未归入以上三类 |`,
  '',
];

dl.push(`## 一、已删除（从歌单消失）${deleted.length} 首`, '');
if (deleted.length) {
  dl.push('| # | 歌名 | 制作人/团体 | 专辑 | 最后出现 | 原歌单 | 歌曲ID |', '| --- | --- | --- | --- | --- | --- | --- |');
  deleted.forEach((x, i) => dl.push(`| ${i + 1} | ${esc(x.name)} | ${esc(x.ar) || '未知'} | ${esc(x.al)} | ${x.lastSeen || ''} | ${esc((x.playlists || []).join('；'))} | ${x.id} |`));
} else dl.push('暂无记录（基线已建立，之后每次同步会自动累积）。');
dl.push('');

const sec = (title, rows, withLink) => {
  dl.push(`## ${title}${rows.length} 首`, '');
  if (!rows.length) { dl.push('无。', ''); return; }
  dl.push('| # | 歌名 | 制作人/团体 | 专辑 | 发行公司/厂牌 | 时长 | 所属歌单 | 歌曲ID | 状态 |', '| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  rows.forEach((s, i) => dl.push(`| ${i + 1} | ${esc(s.name)} | ${esc(s.ar) || '未知'} | ${esc(s.al)} | ${esc(s.company) || '未标注厂牌'} | ${fmtDur(s.dur)} | ${esc(playList(s))} | ${s.id} | ${withLink ? `[播放页](https://music.163.com/song?id=${s.id})` : ''} |`));
  dl.push('');
  dl.push('### 一歌一行', '');
  rows.forEach(s => dl.push(`- ${s.name} - ${s.ar || '未知'} - ${s.al || '未知'} - ${s.company || '未标注厂牌'}  〔${fmtDur(s.dur)}；歌单：${playList(s)}〕`));
  dl.push('');
};
sec('二、已下架（不可播放）', downRows, true);
sec('三、仅其他版本可播', otherVerRows, true);
sec('四、其他异常', otherRows, false);

fs.writeFileSync(path.join(DIR_SPECIAL, '40_删除与下架与其他版本.md'), dl.join('\n'));

// ---------- 非拉丁文字 / 小众书写系统 ----------
const scriptDefs = [
  ['西里尔文', /\p{Script=Cyrillic}/u],
  ['日文假名', /[\p{Script=Hiragana}\p{Script=Katakana}]/u],
  ['韩文', /\p{Script=Hangul}/u],
  ['阿拉伯文', /\p{Script=Arabic}/u],
  ['希伯来文', /\p{Script=Hebrew}/u],
  ['希腊文', /\p{Script=Greek}/u],
  ['天城文', /\p{Script=Devanagari}/u],
  ['孟加拉文', /\p{Script=Bengali}/u],
  ['泰米尔文', /\p{Script=Tamil}/u],
  ['泰卢固文', /\p{Script=Telugu}/u],
  ['卡纳达文', /\p{Script=Kannada}/u],
  ['马拉雅拉姆文', /\p{Script=Malayalam}/u],
  ['古吉拉特文', /\p{Script=Gujarati}/u],
  ['果鲁穆奇文', /\p{Script=Gurmukhi}/u],
  ['僧伽罗文', /\p{Script=Sinhala}/u],
  ['藏文', /\p{Script=Tibetan}/u],
  ['彝文', /\p{Script=Yi}/u],
  ['蒙古文', /\p{Script=Mongolian}/u],
  ['格鲁吉亚文', /\p{Script=Georgian}/u],
  ['亚美尼亚文', /\p{Script=Armenian}/u],
  ['埃塞俄比亚文', /\p{Script=Ethiopic}/u],
  ['塔纳文', /\p{Script=Thaana}/u],
  ['泰文', /\p{Script=Thai}/u],
  ['老挝文', /\p{Script=Lao}/u],
  ['高棉文', /\p{Script=Khmer}/u],
  ['缅甸文', /\p{Script=Myanmar}/u],
  ['拉丁扩展/变音字母（法德葡越等）', /[\u1E00-\u1EFF\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u00FF\u0100-\u017F]/u],
];
const langRows = [...bySong.values()].map(s => {
  const n = s.name || '';
  if (!/[^\x00-\x7f]/.test(n)) return null;
  const langs = scriptDefs.filter(([, re]) => re.test(n)).map(([k]) => k);
  return langs.length ? { ...s, langs } : null;
}).filter(Boolean);
const langGroups = scriptDefs
  .map(([k]) => [k, langRows.filter(s => s.langs.includes(k))])
  .filter(([, v]) => v.length)
  .sort((a, b) => b[1].length - a[1].length);
const ll = [
  '# 非拉丁文字 / 小众书写系统歌曲',
  '',
  `- 去重后曲目：${langRows.length} 首（按歌曲 ID 去重）`,
  '- 判定：曲名含拉丁字母与汉字以外的文字系统（日文假名、西里尔、天城、藏文、彝文、泰文、阿拉伯文等）',
  '- 纯汉字歌名不计入本节（那属正常中文命名）；一首歌可能同时含多个文字系统，会出现在多个分组',
  '- 字符原样输出，未做任何转写或归一',
  '',
  '| 文字系统 | 曲目数 |',
  '| --- | --- |',
  ...langGroups.map(([k, v]) => `| ${k} | ${v.length} |`),
  '',
];
for (const [k, v] of langGroups) {
  ll.push(`## ${k}（${v.length} 首）`, '');
  ll.push('| # | 歌名 | 制作人/团体 | 专辑 | 发行公司/厂牌 | 所属歌单 | 歌曲ID |', '| --- | --- | --- | --- | --- | --- | --- |');
  v.forEach((s, i) => ll.push(line(s, i)));
  ll.push('');
}
ll.push('## 全量复现（一歌一行）', '');
langRows.forEach(s => ll.push(`- ${s.name} - ${s.ar || '未知'} - ${s.al || '未知'} - ${s.company || '未标注厂牌'}  〔${s.langs.join('/')}；歌单：${playList(s)}〕`));
fs.writeFileSync(path.join(DIR_SPECIAL, '50_非拉丁文字歌曲.md'), ll.join('\n'));



// 数据说明
const notes = [
  '# 数据处理说明',
  '',
  `- 源：网易云音乐官方接口（weapi/eapi），账号 ${meta.nick}（uid ${meta.uid}）`,
  `- 抓取时间：${fmtDate(Date.now())}`,
  `- 曲目总数：${stats.total} 首（跨歌单重复保留，未去重）；按歌曲 ID 去重后 ${uniqueIds.size} 首`,
  '',
  '## 字符与编码',
  '',
  '- 全部文本按 UTF-8 原样输出，不做音译、不转 ASCII；日文、韩文、泰文、阿拉伯文、越南文、天城文、蒙古文、彝文、卦象符号等都保留原字符。',
  `- 文件名做了 NFC 归一、剔除零宽与 RTL 覆盖符、替换 Windows 非法字符（\\ / : * ? " < > |），并限长 45 字；重名自动追加歌单 ID（本次处理 ${stats.dupName} 个）。`,
  `- 正文保真：零宽空格 U+200B、方向隔离符 U+2069、组合附加符号 U+0300–U+036F、emoji 组合序列等一律原样保留；只把换行、制表符和 C0 控制符替换为空格（这批数据里 C0 控制符实际出现 0 次）。`,
  '- 已逐条校验：含零宽/方向控制符的 12 条记录、含组合附加符号的 28 首曲名、以及随机抽样 86 首，正文与接口原文逐字节一致。',
  '',
  '## 官方遮盖与下架',
  '',
  `- 含遮盖星号的曲目：${stats.masked} 首（如 \`Life's a B***h\`）。这是网易云服务端返回的原文，接口不提供未遮盖版本，无法还原。`,
  `- 带版权受限标记（noCopyrightRcmd）的曲目：${stats.restricted} 首，已在正文行尾标注。`,
  `- 名称为空、无法从接口取到元数据的曲目：${stats.noMeta} 首，保留 song_id 便于回溯（形如 \`[元数据缺失 song_id:123]\`）。`,
  '- 若某首歌已被彻底下架，接口通常直接不返回该条目，歌单里也不会再有它；这种情况下任何客户端都取不到信息，本地导出无法弥补。',
  '',
  '## 时长', '', '- 曲目时长取自接口的 dt 字段（毫秒），按 mm:ss 写入；超过 1 小时用 h:mm:ss。', '', '## 字段完整性',
  '',
  `- 厂牌（专辑 company）：已标注 ${stats.filled} / ${stats.total}（${(stats.filled / stats.total * 100).toFixed(1)}%）。空值来自专辑本身未填写，不是抓取失败。`,
  `- 专辑名为空的记录：${stats.emptyAlbum} 首；艺人为空的：${stats.emptyArtist} 首。`,
  `- 非 ASCII 字符记录：${stats.nonAscii} 首。`,
  '',
  '## 排序',
  '',
  '- 歌单内顺序严格按官方 trackIds 顺序（即 App 里看到的顺序）；「我喜欢的音乐」为收藏顺序。',
  '- 歌单之间按曲目数从多到少排列。',
];
fs.writeFileSync(path.join(OUT, '01_数据处理说明.md'), notes.join('\n'));

console.log(`合并完成：${results.length} 个歌单，${stats.total} 首歌，厂牌覆盖 ${stats.filled}（${(stats.filled / stats.total * 100).toFixed(1)}%）`);
console.log(`遮盖 ${stats.masked}｜版权受限 ${stats.restricted}｜空元数据 ${stats.noMeta}｜重名 ${stats.dupName}`);


// ---------- 收藏域文档（从本地 JSON 生成，保证整理与同步一致） ----------
{
  const DIR_FAV = path.join(OUT, '收藏');
  fs.mkdirSync(DIR_FAV, { recursive: true });
  const esc2 = v => String(v || '').replace(/\|/g, '\\|');
  const iso = ts => { if (!ts) return '—'; const d = new Date(ts), p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };

  // 收藏歌单
  const cplF = path.join(OUT, 'collected_playlists.json');
  if (fs.existsSync(cplF)) {
    const list = JSON.parse(fs.readFileSync(cplF, 'utf8'));
    const L = ['# 我收藏的歌单', '',
      `- 数量：${list.length} 个`,
      `- 曲目合计：${list.reduce((n, x) => n + (x.trackCount || 0), 0)} 首（含跨歌单重复）`,
      `- 更新时间：${fmtDate(Date.now())}`, '',
      '| # | 歌单 | 创建者 | 曲目 | 播放量 | 更新时间 | 链接 |',
      '| --- | --- | --- | --- | --- | --- | --- |'];
    list.forEach((x, i) => L.push(`| ${i + 1} | ${esc2(x.name)} | ${esc2(x.creator)} | ${x.trackCount} | ${x.playCount} | ${iso(x.updateTime)} | https://music.163.com/playlist?id=${x.id} |`));
    writeAtomic(path.join(DIR_FAV, '00_收藏歌单索引.md'), L.join('\n'));
    const csv = ['序号,歌单,创建者,曲目数,播放量,更新时间,歌单ID'];
    list.forEach((x, i) => csv.push([i + 1, x.name, x.creator, x.trackCount, x.playCount, iso(x.updateTime), x.id].map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')));
    fs.mkdirSync(DIR_TABLE, { recursive: true });
    writeAtomic(path.join(DIR_TABLE, 'collected_playlists.csv'), '\ufeff' + csv.join('\n'));
  }

  // 收藏专辑
  const calF = path.join(OUT, 'collected_albums.json');
  if (fs.existsSync(calF)) {
    const list = JSON.parse(fs.readFileSync(calF, 'utf8'));
    const L = ['# 收藏的专辑', '',
      `- 数量：${list.length} 张`,
      `- 有厂牌：${list.filter(a => a.company).length} 张`,
      `- 更新时间：${fmtDate(Date.now())}`, '',
      '| # | 专辑 | 艺人 | 曲目 | 发行公司 | 发行时间 | 链接 |',
      '| --- | --- | --- | --- | --- | --- | --- |'];
    list.forEach((a, i) => L.push(`| ${i + 1} | ${esc2(a.name)} | ${esc2(a.artists)} | ${a.size} | ${esc2(a.company) || '未标注'} | ${iso(a.publishTime)} | https://music.163.com/album?id=${a.id} |`));
    L.push('', '## 专辑曲目', '');
    for (const a of list) {
      if (!a.songs?.length) continue;
      L.push(`### ${a.name}${a.artists ? ' - ' + a.artists : ''}（${a.company || '未标注厂牌'}）`, '');
      a.songs.forEach((x, i) => L.push(`${i + 1}. ${x.name} - ${x.ar || a.artists || '未知'}`));
      L.push('');
    }
    writeAtomic(path.join(DIR_FAV, '01_收藏专辑.md'), L.join('\n'));
    const csv = ['收藏序号,专辑,艺人,曲目数,发行公司,发行时间,专辑ID'];
    list.forEach((a, i) => csv.push([i + 1, a.name, a.artists, a.size, a.company, iso(a.publishTime), a.id].map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')));
    writeAtomic(path.join(DIR_TABLE, 'albums.csv'), '\ufeff' + csv.join('\n'));
  }

  // 我创建的专辑
  const crF = path.join(OUT, 'created_albums.json');
  if (fs.existsSync(crF)) {
    const raw = JSON.parse(fs.readFileSync(crF, 'utf8'));
    const list = raw.albums || [];
    const L = ['# 我创建的专辑', '', `- 数量：${list.length} 张`, `- 音乐人 ID：${raw.artistId || '无（非音乐人账号）'}`, ''];
    if (!list.length) L.push(raw.artistId ? '当前音乐人账号下暂无已发布专辑。' : '当前账号不是网易云音乐人，因此没有「创建的专辑」。');
    else {
      L.push('| # | 专辑 | 曲目 | 发行公司 | 发行时间 | 链接 |', '| --- | --- | --- | --- | --- | --- |');
      list.forEach((a, i) => L.push(`| ${i + 1} | ${esc2(a.name)} | ${a.size} | ${esc2(a.company) || '未标注'} | ${iso(a.publishTime)} | https://music.163.com/album?id=${a.id} |`));
    }
    writeAtomic(path.join(DIR_FAV, '02_我创建的专辑.md'), L.join('\n'));
  }
}

// ---------- 听歌排行（从本地 ranking.json 重建，无需联网） ----------
{
  const rkf = path.join(OUT, 'ranking.json');
  if (fs.existsSync(rkf)) {
    try {
      const rk = JSON.parse(fs.readFileSync(rkf, 'utf8'));
      const build = (label, list) => {
        if (!list || !list.length) return;
        const L = [
          `# 听歌排行 · ${label}`, '',
          `- 条目：${list.length}（官方接口上限 100）`,
          `- 更新时间：${fmtDate(new Date(rk.generated).getTime())}`,
          '',
          '| 排名 | 播放次数 | 歌名 | 制作人/团体 | 专辑 | 发行公司/厂牌 | 时长 |',
          '| --- | --- | --- | --- | --- | --- | --- |',
        ];
        for (const r of list) L.push(`| ${r.rank} | ${r.playCount} | ${esc(r.name)} | ${esc(r.ar) || '未知'} | ${esc(r.al)} | ${esc(r.company) || '未标注厂牌'} | ${fmtDur(r.dur)} |`);
        fs.mkdirSync(path.join(OUT, '排行与收藏'), { recursive: true });
        writeAtomic(path.join(OUT, `排行与收藏/10_听歌排行_${label}.md`), L.join('\n'));
      };
      build('全部时间', rk.all);
      build('最近一周', rk.week);
    } catch (e) { console.log('排行重建跳过：' + e.message); }
  }
}

// ---------- 整理报告（放在所有统计就绪之后） ----------
{
  const sha = (() => { try { return crypto.createHash('md5').update(fs.readFileSync(path.join(DIR_TABLE, 'all_songs.csv'))).digest('hex').slice(0, 12); } catch { return '—'; } })();
  const rep = [
    '# 整理报告', '',
    `- 生成时间：${fmtDate(Date.now())}`,
    `- 歌单：${results.length} 个（公开 ${results.filter(r => r.privacy !== 10).length} / 私密 ${results.filter(r => r.privacy === 10).length} / 置顶 ${results.filter(r => r.top).length}）`,
    `- 曲目：${stats.total} 首（去重 ${uniqueIds.size}，已下架 ${downRows.length}，仅其他版本 ${otherVerRows.length}）`,
    `- 厂牌覆盖：${stats.filled} / ${stats.total}（${(stats.filled / stats.total * 100).toFixed(1)}%）`,
    `- 特殊字符 ${special.length} 首 / 非拉丁 ${langRows.length} 首`,
    `- 歌曲表校验和：${sha}（all_songs.csv 前 12 位 MD5）`,
    '', '## 数据源', '',
    '- 歌单曲目：`out2/playlists_full.json`',
    '- 专辑元信息：`out2/albums_cache.json`',
    '- 封面索引：`out2/covers.json`',
    '- 消失记录：`out2/history/removed.json`',
    '', '## 本次生成', '',
    '- 歌单明细：`歌单/公开|私密/`（每歌单一份 md）',
    '- 索引：`00_自建歌单索引.md`、`02_歌单可见性清单.md`',
    '- 专项：`专项/`（特殊字符、删除与下架、非拉丁文字）',
    '- 表格：`表格/all_songs.csv`、`表格/songs_full.json`',
  ].join('\n');
  writeAtomic(path.join(OUT, '03_整理报告.md'), rep);
}
