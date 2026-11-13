// 整理导出：与 APK 侧一致的「每个歌单四套文件」
import fs from 'node:fs';
import path from 'node:path';
import { blockReason, classify } from './netease.mjs';

const SUB = { pl: '歌单', plfav: '收藏歌单', al: '收藏专辑' };

export function subOf(kind) {
  return SUB[kind] || null;
}

const pad = n => String(n).padStart(2, '0');
export function fmtDur(ms) {
  if (!ms || ms <= 0) return '--:--';
  const total = Math.round((ms + 500) / 1000);
  return `${Math.floor(total / 60)}:${pad(total % 60)}`;
}

export function sanitize(name) {
  const s = String(name || '').replace(/[\\/:*?"<>|]/g, '_').replace(/[\u0000-\u001f]/g, '_').trim();
  return (s || '未命名').slice(0, 50);
}

function stateOf(r) {
  if (r.manual) return '人工补充';
  const reason = blockReason(r);
  return reason || '正常';
}

function companyText(r) {
  if (r.company) return r.company;
  return r.cstate === 'none' ? '未标注厂牌' : r.cstate === 'fail' ? '查询失败' : '未查询';
}

export function toCsv(rows, title) {
  const head = '\uFEFF序号,歌名,制作人/团体,专辑,发行公司/厂牌,时长,时长秒,歌曲ID,专辑ID,流行度,MV_ID,别名,权限,不可播放原因,状态\n';
  const q = v => '"' + String(v ?? '').replace(/"/g, '""') + '"';
  const lines = rows.map((r, i) => {
    const nm = r.name || (r.missing ? '（已下架·名称不可获取）' : '');
    const perm = { 0: '免费', 1: 'VIP', 4: '付费专辑', 8: '低音质' }[r.fee] || '其他';
    return [
      i + 1, q(nm), q(r.ar), q(r.al), q(companyText(r)),
      fmtDur(r.dur), Math.floor((r.dur || 0) / 1000),
      r.id || 0, r.alId || 0, r.pop || 0, r.mv || 0, q(r.alia || ''),
      perm, blockReason(r), stateOf(r),
    ].join(',');
  });
  return head + lines.join('\n') + (lines.length ? '\n' : '');
}

export function toMd(rows, title) {
  const out = [`# ${title}`, '', `- 曲目：${rows.length} 首`, '', '## 曲目', ''];
  rows.forEach((r, i) => {
    const nm = r.name || (r.missing ? '（已下架·名称不可获取）' : '未知');
    const mark = stateOf(r) === '正常' ? '' : `  〔${stateOf(r)}〕`;
    out.push(`${i + 1}. ${nm} - ${r.ar || '未知'} - ${r.al || '未知'} - ${companyText(r)}  〔${fmtDur(r.dur)}〕${mark}`);
  });
  return out.join('\n') + '\n';
}

function writeBoth(app, rel, content) {
  const saved = [];
  const priv = path.join(app.dataDir, 'exports', rel);
  fs.mkdirSync(path.dirname(priv), { recursive: true });
  fs.writeFileSync(priv, content);
  saved.push(priv);
  try {
    const pub = path.join(app.exportDir, rel);
    fs.mkdirSync(path.dirname(pub), { recursive: true });
    fs.writeFileSync(pub, content);
    saved.push(pub);
  } catch {}
  return saved;
}

function loadExtras(app, kind, id) {
  try {
    const p = path.join(app.dataDir, 'extras', kind, `${id}.json`);
    return JSON.parse(fs.readFileSync(p, 'utf8')).items || [];
  } catch { return []; }
}

function loadArchive(app, kind, id) {
  try {
    const p = path.join(app.dataDir, 'archive', kind, `${id}.json`);
    return JSON.parse(fs.readFileSync(p, 'utf8')).items || [];
  } catch { return []; }
}

export function saveArchive(app, kind, id, rows) {
  const p = path.join(app.dataDir, 'archive', kind, `${id}.json`);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const old = loadArchive(app, kind, id);
  const seen = new Set(old.map(r => r.id));
  let added = 0;
  for (const r of rows) {
    if (!blockReason(r) || !r.id || seen.has(r.id)) continue;
    old.push(r); seen.add(r.id); added++;
  }
  if (added) fs.writeFileSync(p, JSON.stringify({ items: old }));
  return added;
}

function mergeArchive(app, kind, id, rows) {
  const items = loadArchive(app, kind, id);
  if (!items.length) return rows;
  const have = new Set(rows.map(r => r.id));
  const out = rows.slice();
  for (const it of items) {
    if (!it.id || have.has(it.id)) continue;
    out.push({ ...it, archived: true });
    have.add(it.id);
  }
  return out;
}

function mergeRows(base, extra) {
  const key = r => `${(r.name || '').toLowerCase()}|||${(r.ar || '').toLowerCase()}`;
  const seen = new Set(base.map(key));
  const out = base.slice();
  for (const r of extra) if (!seen.has(key(r))) { out.push(r); seen.add(key(r)); }
  return out;
}

function readStage(app, kind) {
  const dir = path.join(app.dataDir, 'stage', subOf(kind));
  const out = [];
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return out; }
  for (const f of names) {
    if (!f.endsWith('.json')) continue;
    try {
      const v = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      out.push({ file: f, id: v.id || Number(f.replace('.json', '')), data: v });
    } catch {}
  }
  return out;
}

// 同步单个歌单/专辑到 stage
export async function stageOne(app, api, kind, id) {
  const sub = subOf(kind);
  if (!sub) throw new Error('未知类型');
  const dir = path.join(app.dataDir, 'stage', sub);
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, `${id}.json`);
  // 覆盖前把旧的受限曲目记进档案
  try {
    const old = JSON.parse(fs.readFileSync(p, 'utf8'));
    saveArchive(app, kind, id, old.rows || []);
  } catch {}
  const d = kind === 'al' ? await api.albumDetail(id) : await api.playlistDetail(id, false);
  saveArchive(app, kind, id, d.rows || []);
  d.rows = mergeArchive(app, kind, id, d.rows || []);
  d.count = d.rows.length;
  fs.writeFileSync(p, JSON.stringify(d));
  return { name: d.name, count: d.count, stats: d.stats };
}

export function stageIds(app, kind) {
  return readStage(app, kind).map(x => x.id);
}

export function stageStats(app, kind) {
  const files = readStage(app, kind);
  const ids = new Set();
  let total = 0, down = 0, other = 0, special = 0, nonLatin = 0;
  for (const { data } of files) {
    for (const r of data.rows || []) { if (r.id) ids.add(r.id); total++; }
    const st = classify(data.rows || []);
    down += st.down; other += st.otherVersion; special += st.special; nonLatin += st.nonLatin;
  }
  return { lists: files.length, total, unique: ids.size, down, otherVersion: other, special, nonLatin };
}

export function specialItems(app) {
  const items = [];
  const seen = new Set();
  let down = 0, other = 0, special = 0, nonLatin = 0;
  for (const kind of ['pl', 'plfav', 'al']) {
    for (const { data } of readStage(app, kind)) {
      const st = classify(data.rows || []);
      down += st.down; other += st.otherVersion; special += st.special; nonLatin += st.nonLatin;
      for (const it of st.items) {
        if (it.id && seen.has(it.id)) continue;
        if (it.id) seen.add(it.id);
        items.push(it);
      }
    }
  }
  return { total: items.length, items, stats: { down, otherVersion: other, special, nonLatin } };
}

// 整理：四套文件 + 索引 + 总表
export function tidy(app, kind) {
  const sub = subOf(kind);
  if (!sub) throw new Error('未知类型');
  let files = 0, items = 0, songs = 0, extrasTotal = 0, failed = 0;
  const indexRows = [];
  const allRows = [];
  const seen = new Set();
  const usedNames = new Set();

  for (const { id, data } of readStage(app, kind)) {
    let name = sanitize(data.name);
    if (usedNames.has(name)) {
      let i = 2;
      while (usedNames.has(`${name}~${i}`)) i++;
      name = `${name}~${i}`;
    }
    usedNames.add(name);
    const rows = mergeArchive(app, kind, id, data.rows || []);
    const extras = loadExtras(app, kind, id);
    extrasTotal += extras.length;
    const blocked = rows.filter(r => blockReason(r));
    const full = mergeRows(rows, extras);
    const sets = [
      ['', '完整歌单', full],
      ['-网易云', '网易云现状', rows],
      ['-受限', '受限曲目', blocked],
      ['-补充', '人工补充', extras],
    ];
    let wrote = 0;
    for (const [tag, label, list] of sets) {
      const title = `${data.name || '未命名'}（${label}）`;
      try {
        writeBoth(app, `${sub}/${name}${tag}.csv`, toCsv(list, title));
        writeBoth(app, `${sub}/${name}${tag}.md`, toMd(list, title));
        wrote += 2;
      } catch {}
    }
    if (!wrote) { failed++; continue; }
    files += wrote; items++;
    songs += rows.length;
    indexRows.push(`| ${name} | ${rows.length} | ${blocked.length} | ${extras.length} | ${extras.length ? '（含人工补充）' : ''} |`);
    if (kind === 'pl') {
      for (const r of full) if (r.id && !seen.has(r.id)) { seen.add(r.id); allRows.push(r); }
    }
  }

  if (indexRows.length) {
    const idx = [
      `# ${sub}`, '',
      `- 项数：${items}`,
      `- 曲目合计：${songs} 首（人工补充 ${extrasTotal} 首）`,
      `- 生成时间：${new Date().toLocaleString('zh-CN', { hour12: false })}`, '',
      '每个歌单四套文件：`名字.csv/md` 是完整歌单，`名字-网易云` 是当前状态，`名字-受限` 是下架/无版权/仅其他版本，`名字-补充` 是人工添加。', '',
      '| 名称 | 曲目 | 受限 | 人工补充 | 文件 |',
      '| --- | --- | --- | --- | --- |',
      ...indexRows, '',
    ].join('\n');
    writeBoth(app, `${sub}/00_索引.md`, idx);
    files++;
  }

  let unique = 0;
  if (kind === 'pl' && allRows.length) {
    unique = allRows.length;
    writeBoth(app, '表格/all_songs.csv', toCsv(allRows, '全部曲目'));
    files++;
  }
  return { items, files, songs, unique, extras: extrasTotal, failed, sub };
}

export function check(app, kind) {
  const sub = subOf(kind);
  let okCount = 0, badCount = 0, songs = 0;
  const items = [];
  for (const { file, data } of readStage(app, kind)) {
    const name = sanitize(data.name);
    const count = (data.rows || []).length;
    songs += count;
    const issues = [];
    let rows = 0;
    try {
      const t = fs.readFileSync(path.join(app.dataDir, 'exports', sub, `${name}.csv`), 'utf8');
      rows = t.split('\n').filter(Boolean).length - 1;
      if (rows < count) issues.push(`完整歌单只有 ${rows} 行，少于曲目 ${count}`);
      if (!t.includes('发行公司/厂牌')) issues.push('CSV 缺厂牌列');
    } catch { issues.push('缺少完整歌单 CSV'); }
    for (const tag of ['', '-网易云', '-受限', '-补充']) {
      for (const ext of ['csv', 'md']) {
        try { fs.accessSync(path.join(app.dataDir, 'exports', sub, `${name}${tag}.${ext}`)); }
        catch { issues.push(`缺少 ${name}${tag}.${ext}`); }
      }
    }
    if (issues.length) badCount++; else okCount++;
    items.push({ file, name, count, rows, ok: !issues.length, issues });
  }
  return { ok: true, okCount, badCount, songs, items, sub };
}
