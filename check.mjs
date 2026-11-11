import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const NC_ROOT = process.env.NC_ROOT || process.cwd();
const BASE_OUT = path.join(NC_ROOT, 'out2');
const STAGE_DIR = path.join(BASE_OUT, 'staging');
const USE_STAGE = process.env.NC_STAGE === '1' || fs.existsSync(path.join(STAGE_DIR, 'playlists_full.json'));
const OUT = process.env.NC_OUT_DIR || (USE_STAGE ? STAGE_DIR : BASE_OUT);
const ZIP = process.env.NC_ZIP || path.resolve(process.env.NC_DEST || path.join(NC_ROOT, '导出')) + '.zip';

const report = [];
const problems = [];
const add = (name, ok, detail, extra) => {
  report.push({ name, ok, detail });
  if (!ok) problems.push(`${name}：${detail}${extra ? ' — ' + extra : ''}`);
};
const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };

/* ---------- 1. 索引与文件 ---------- */
const dirs = ['歌单/公开', '歌单/私密'];
for (const d of dirs) {
  if (!fs.existsSync(path.join(OUT, d))) add(`目录 ${d}`, false, '缺失');
}
const files = dirs.flatMap(d => (fs.existsSync(path.join(OUT, d)) ? fs.readdirSync(path.join(OUT, d)).map(f => `${d}/${f}`) : []));
const countSongs = p => fs.readFileSync(p, 'utf8').split('\n').filter(l => /^\d+\. /.test(l)).length;

const idxLines = fs.readFileSync(path.join(OUT, '00_自建歌单索引.md'), 'utf8').split('\n');
const idxMap = new Map();
let pinnedInIndex = 0;
for (const l of idxLines) {
  const m = l.match(/^\| (\d+) \| (📌 )?(.+?) \| (\d+)(?:（空）)? \| (\d+)\/(\d+) \| (.+?) \|$/);
  if (!m) continue;
  if (m[2]) pinnedInIndex++;
  idxMap.set(m[7], { count: +m[4], filled: +m[5], name: m[3] });
}
add('索引条目数', idxMap.size === files.length, `索引 ${idxMap.size} 行 / 实际文件 ${files.length} 份`);
add('公开+私密文件数', true, `公开 ${fs.existsSync(path.join(OUT, '歌单/公开')) ? fs.readdirSync(path.join(OUT, '歌单/公开')).length : 0} 份，私密 ${fs.existsSync(path.join(OUT, '歌单/私密')) ? fs.readdirSync(path.join(OUT, '歌单/私密')).length : 0} 份`);

/* ---------- 2. 每份文件 ---------- */
let fileSongs = 0;
const mismatch = [];
const emptyFiles = [];
for (const rel of files) {
  const n = countSongs(path.join(OUT, rel));
  fileSongs += n;
  if (n === 0) emptyFiles.push(rel);
  const ref = idxMap.get(rel);
  if (!ref) mismatch.push(`${rel} 未出现在索引`);
  else if (ref.count !== n) mismatch.push(`${rel}（索引 ${ref.count} / 实际 ${n}）`);
}
add('文件曲目数与索引一致', mismatch.length === 0, mismatch.length ? `${mismatch.length} 份不一致` : `${files.length} 份全部一致`, mismatch.slice(0, 3).join('；'));

/* ---------- 3. 数据源一致性 ---------- */
const full = readJson(path.join(OUT, 'playlists_full.json'));
let dataSongs = 0, dataPinned = 0;
if (!full) add('数据源 playlists_full.json', false, '缺失或无法解析');
else {
  for (const r of full) { dataSongs += (r.rows || []).length; if (r.top) dataPinned++; }
  add('数据源曲目数 = 文件曲目数', dataSongs === fileSongs, `数据源 ${dataSongs} / 文件 ${fileSongs}`);
  add('置顶标记一致', dataPinned === pinnedInIndex, `数据源 ${dataPinned} 个 / 索引 📌 ${pinnedInIndex} 个`);
  const noId = full.filter(r => !r.id).length;
  add('歌单 ID 完整性', noId === 0, noId ? `${noId} 个歌单缺 ID` : '全部有 ID');
}

/* ---------- 4. CSV ---------- */
const csvPath = path.join(OUT, '表格/all_songs.csv');
let csvRows = 0, csvBadCols = 0, csvHeaderCols = 0;
if (!fs.existsSync(csvPath)) add('CSV 文件', false, '缺失');
else {
  const lines = fs.readFileSync(csvPath, 'utf8').replace(/^\ufeff/, '').trim().split('\n');
  const countCols = line => {
    let inQ = false, cols = 1;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') inQ = !inQ;
      else if (ch === ',' && !inQ) cols++;
    }
    return cols;
  };
  csvHeaderCols = countCols(lines[0]);
  csvRows = lines.length - 1;
  for (let i = 1; i < lines.length; i++) {
    if (countCols(lines[i]) !== csvHeaderCols) csvBadCols++;
  }
  add('CSV 行数 = 曲目总数', csvRows === fileSongs, `CSV ${csvRows} 行 / 文件曲目 ${fileSongs} 首`);
  add('CSV 列数一致', csvBadCols === 0, csvBadCols ? `${csvBadCols} 行列数异常（表头 ${csvHeaderCols} 列）` : `全部 ${csvHeaderCols} 列`);
}

/* ---------- 5. songs_full.json ---------- */
const sf = readJson(path.join(OUT, '表格/songs_full.json'));
if (Array.isArray(sf)) {
  add('songs_full.json 行数 = CSV', sf.length === csvRows, `JSON ${sf.length} / CSV ${csvRows}`);
  const missDur = sf.filter(x => !x.durMs).length;
  const missPub = sf.filter(x => !x.publishTime).length;
  add('时长覆盖（信息）', true, `${sf.length - missDur} / ${sf.length} 有时长`);
  add('专辑发行时间覆盖（信息）', true, `${sf.length - missPub} / ${sf.length} 有发行时间`);
} else add('songs_full.json', false, '缺失或无法解析');

/* ---------- 6. 专项文档 ---------- */
for (const [f, re] of [['30_特殊字符歌曲.md', /去重后曲目：(\d+) 首/], ['50_非拉丁文字歌曲.md', /去重后曲目：(\d+) 首/]]) {
  const p = path.join(OUT, '专项', f);
  if (!fs.existsSync(p)) { add(f, false, '文件缺失'); continue; }
  const t = fs.readFileSync(p, 'utf8');
  const declared = t.match(re);
  const oneLine = t.split('\n').filter(l => /^- .+ - .+ - .+ - /.test(l)).length;
  add(f, declared && +declared[1] === oneLine, `声明 ${declared ? declared[1] : '?'} 首 / 复现行 ${oneLine} 条`);
}

const f40 = path.join(OUT, '专项/40_删除与下架与其他版本.md');
if (fs.existsSync(f40)) {
  const t = fs.readFileSync(f40, 'utf8');
  const secs = [...t.matchAll(/## (一、已删除（从歌单消失）|二、已下架（不可播放）|三、仅其他版本可播|四、其他异常)(\d+) 首/g)];
  let bad = 0;
  for (const m of secs) {
    const start = m.index;
    const nextIdx = t.indexOf('\n## ', start + 1);
    const body = t.slice(start, nextIdx === -1 ? t.length : nextIdx);
    const rows = body.split('\n').filter(l => /^\| \d+ \|/.test(l)).length;
    if (rows !== +m[2]) bad++;
  }
  add('40 四分类计数', secs.length === 4 && bad === 0, `${secs.length} 节，${bad} 节数量不符`);
} else add('40 文档存在', false, '文件缺失');

/* ---------- 7. 收藏域 ---------- */
const cplJson = readJson(path.join(OUT, 'collected_playlists.json'));
const cplMd = path.join(OUT, '收藏/00_收藏歌单索引.md');
if (Array.isArray(cplJson) && fs.existsSync(cplMd)) {
  const mdRows = fs.readFileSync(cplMd, 'utf8').split('\n').filter(l => /^\| \d+ \|/.test(l)).length;
  add('收藏歌单数一致', mdRows === cplJson.length, `JSON ${cplJson.length} / md ${mdRows}`);
} else add('收藏歌单数据', false, '缺失');

const calJson = readJson(path.join(OUT, 'collected_albums.json'));
const calMd = path.join(OUT, '收藏/01_收藏专辑.md');
if (Array.isArray(calJson) && fs.existsSync(calMd)) {
  const mdRows = fs.readFileSync(calMd, 'utf8').split('\n').filter(l => /^\| \d+ \|/.test(l)).length;
  add('收藏专辑数一致', mdRows === calJson.length, `JSON ${calJson.length} / md ${mdRows}`);
} else add('收藏专辑数据', false, '缺失');

/* ---------- 8. 表格结构 ---------- */
const tableFiles = ['收藏/00_收藏歌单索引.md', '收藏/01_收藏专辑.md', '收藏/02_我创建的专辑.md', '排行与收藏/12_爱心歌曲.md', '排行与收藏/20_收藏专辑.md', '专项/30_特殊字符歌曲.md', '专项/40_删除与下架与其他版本.md', '专项/50_非拉丁文字歌曲.md', '00_自建歌单索引.md', '02_歌单可见性清单.md'];
for (const f of tableFiles) {
  const p = path.join(OUT, f);
  if (!fs.existsSync(p)) { add(`表格结构 ${f}`, true, '文件不存在（可选）'); continue; }
  const lines = fs.readFileSync(p, 'utf8').split('\n');
  let cols = null, bad = 0;
  for (const l of lines) {
    if (!l.startsWith('|')) { cols = null; continue; }
    const n = (l.replace(/\\\|/g, ' ').match(/\|/g) || []).length;
    if (cols === null) cols = n;
    else if (n !== cols) bad++;
  }
  add(`表格结构 ${f}`, bad === 0, bad ? `${bad} 行列数异常` : '正常');
}

/* ---------- 9. 文件名与日期 ---------- */
const badName = files.filter(f => /[\\:*?"<>|\u0000-\u001f]/.test(path.basename(f)));
add('文件名合法性', badName.length === 0, badName.length ? `${badName.length} 个含非法字符` : '全部合法', badName.slice(0, 3).join('；'));

let badDate = 0;
for (const d of dirs) {
  if (!fs.existsSync(path.join(OUT, d))) continue;
  for (const f of fs.readdirSync(path.join(OUT, d))) {
    const m = fs.readFileSync(path.join(OUT, d, f), 'utf8').match(/创建时间：(.+)/);
    if (m && !/^\d{4}-\d{2}-\d{2}/.test(m[1].trim()) && m[1].trim() !== '—') badDate++;
  }
}
add('日期格式统一', badDate === 0, badDate ? `${badDate} 份文件仍是旧格式` : '全部 YYYY-MM-DD HH:mm');

/* ---------- 10. 压缩包 ---------- */
if (fs.existsSync(ZIP)) {
  const size = fs.statSync(ZIP).size;
  add('压缩包存在', true, `${(size / 1048576).toFixed(2)} MB，更新于 ${new Date(fs.statSync(ZIP).mtimeMs).toLocaleString('zh-CN', { hour12: false })}`);
} else add('压缩包存在', false, '未找到压缩包');

/* ---------- 11. 空歌单 ---------- */
add('空歌单统计', true, `${emptyFiles.length} 个空歌单（索引中已标注「0（空）」）`);

/* ---------- 输出 ---------- */
console.log('===== 核查明细 =====');
for (const r of report) console.log(`${r.ok ? '[PASS]' : '[FAIL]'} ${r.name}｜${r.detail}`);
console.log('');
console.log(`检查项 ${report.length} 个，问题合计 ${problems.length}`);
if (problems.length) {
  problems.forEach((p, i) => console.log(`  ${i + 1}. ${p}`));
  process.exitCode = 1;
} else {
  console.log('全部通过');
}
