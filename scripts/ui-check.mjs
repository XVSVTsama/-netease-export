// 极简 DOM harness：在 Node 里跑 ui/index.html 的顶层脚本，验证没有运行时异常且按钮都绑定了
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const html = readFileSync(process.argv[2] || 'ui/index.html', 'utf8');
const code = html.match(/<script>([\s\S]*?)<\/script>/)[1];
writeFileSync('/tmp/h-ui.js', code);
execFileSync(process.execPath, ['--check', '/tmp/h-ui.js']);

const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map(x => x[1]);
const errors = [];

function el(id) {
  const e = {
    id, _html: '', textContent: '', className: '', hidden: false, disabled: false,
    dataset: {}, style: {}, value: '', content: '',
    classList: { toggle() {}, add() {}, remove() {}, contains() { return false; } },
    querySelectorAll() { return []; },
    addEventListener() {},
  };
  Object.defineProperty(e, 'innerHTML', {
    get() { return e._html; },
    set(v) {
      e._html = String(v ?? '');
      if (e._html.includes('undefined') || e._html.includes('NaN') || e._html.includes('[object Object]')) {
        errors.push('innerHTML 异常内容 @#' + id + ': ' + e._html.slice(0, 120));
      }
    },
  });
  return e;
}

const store = new Map(ids.map(i => [i, el(i)]));
const mkBtn = attrs => { const b = el('btn-' + Math.random()); Object.assign(b.dataset, attrs); return b; };
const groups = {
  '#loginTabs button': [mkBtn({ m: 'qr' }), mkBtn({ m: 'phone' }), mkBtn({ m: 'email' }), mkBtn({ m: 'cookie' })],
  '#plFilter .chip': [mkBtn({ f: 'all' }), mkBtn({ f: 'mine' }), mkBtn({ f: 'fav' })],
  '#dispModes button': [mkBtn({ d: 'raw' }), mkBtn({ d: 'mark' })],
  '#rankSeg button': [mkBtn({ r: 'all' }), mkBtn({ r: 'week' })],
  '.tabs a': [mkBtn({ v: 'home' }), mkBtn({ v: 'browse' }), mkBtn({ v: 'albums' }), mkBtn({ v: 'docs' }), mkBtn({ v: 'setting' })],
};

const meta = el('meta');
global.document = {
  documentElement: { dataset: {} },
  getElementById: id => store.get(id) || null,
  querySelector: sel => (sel.startsWith('meta') ? meta : null),
  querySelectorAll: sel => groups[sel] || [],
};
global.window = {
  addEventListener() {},
  scrollTo() {},
  __TAURI__: { core: { invoke } },
};
global.localStorage = { getItem: () => 'dark', setItem() {} };

const data = {
  account: { logged: true, uid: 8427986377, nickname: 'Xun-Starlight' },
  playlists: { total: 3, items: [
    { id: 1, name: 'Xun-Starlight喜欢的音乐', count: 9637, privacy: 0, creator: 'Xun-Starlight', mine: true },
    { id: 2, name: '私密\u200b歌单', count: 34, privacy: 10, creator: 'Xun-Starlight', mine: true },
    { id: 3, name: '空歌单', count: 0, privacy: 0, creator: 'Xun-Starlight', mine: true },
    { id: 4, name: '别人的收藏', count: 12, privacy: 0, creator: 'someone', mine: false },
  ] },
  playlist_detail: { id: 1, name: '测试歌单', count: 2, rows: [
    { name: 'Sodness Of Breeze', ar: 'A', al: 'B', company: 'C', dur: 200000, ncr: 0 },
    { name: 'RNG2\u0000STEP', ar: 'D', al: 'E', company: '', dur: 0, ncr: 1 },
  ], stats: { down: 1, otherVersion: 1, special: 1, nonLatin: 0, total: 2 } },
  collected_albums: { items: [{ id: 9, name: '专辑', artists: 'X', company: 'Y', size: 10 }] },
  album_detail: { id: 9, name: '专辑', artists: 'X', company: 'Y', count: 1, publishTime: 0, rows: [{ name: 's', ar: 'X', al: '专辑', dur: 1000 }] },
  special_items: { total: 1, items: [{ name: 'n', ar: 'a', al: 'b', company: 'c', id: 1, kinds: ['otherVersion'] }] },
  play_record: { items: [{ rank: 1, name: 'n', ar: 'a', al: 'b', dur: 1000, playCount: 3 }] },
  qr_new: { img: 'data:image/png;base64,AA' },
  qr_poll: { code: 802 },
  zip_exports: { files: 3, size: 2048, public: '/sdcard/Download/网易云导出.zip' },
  logout: { ok: true },
  save_text: { ok: true, paths: ['/sdcard/Download/网易云导出/x.csv'] },
  stage_one: { ok: true, name: '测试歌单', count: 2, stats: { down: 1, otherVersion: 1, special: 1, nonLatin: 0, total: 2 } },
  stage_stats: { ok: true, lists: 3, total: 9, unique: 8, down: 1, special: 2, nonLatin: 1, sub: '歌单' },
  stage_ids: { ids: [] },
  job_start: { ok: true, log: '/tmp/job.log' },
  job_status: { running: false, phase: 'done', kind: 'pl', step: '', total: 3, done: 3, ok: 3, fail: 0, songs: 9, elapsed: 1.4, logs: [{ k: 'ok', ts: '12:00:01', t: '测试歌单 · 2 首' }], times: { lastSync: '2026-11-12 12:00', lastTidy: '2026-11-12 12:01', lastCheck: '' }, logPath: '/tmp/job.log' },
  job_stop: { ok: true },
  copy_log: { ok: true, paths: ['/sdcard/Download/网易云导出/日志/job.log'] },
  fill_companies: { ok: true, checked: 300, found: 300, updated: 3, remaining: 0 },
  tidy: { ok: true, items: 3, files: 6, songs: 9, failed: 0, sub: '歌单' },
  check_exports: { ok: true, okCount: 3, badCount: 0, songs: 9, items: [], sub: '歌单' },
};

let called = [];
async function invoke(cmd, args) {
  called.push(cmd);
  if (!(cmd in data)) throw new Error('unknown command ' + cmd);
  return data[cmd];
}

// 运行脚本
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
const fn = new AsyncFunction('return (async () => {' + code + '\n})()');
try {
  await fn();
} catch (e) {
  console.log('TOP-LEVEL ERROR:', e && e.message);
  process.exit(1);
}

// 逐一点击已绑定的按钮
const clickables = new Map();
for (const [sel, list] of Object.entries(groups)) for (const b of list) clickables.set(sel + ':' + JSON.stringify(b.dataset), b);
for (const id of ids) { const e = store.get(id); if (typeof e.onclick === 'function') clickables.set('#' + id, e); }

let bound = 0, failed = 0;
for (const [name, b] of clickables) {
  if (typeof b.onclick !== 'function') { console.log('未绑定:', name); failed++; continue; }
  bound++;
  try { await b.onclick({ preventDefault() {}, target: b }); } catch (e) { console.log('点击异常', name, e && e.message); failed++; }
}
await new Promise(r => setTimeout(r, 50));

// 后台任务：三个「开始处理」都要能启动并显示完成
for (const id of ['btnRunPl', 'btnRunFav', 'btnRunAl']) {
  const b = store.get(id);
  if (!b || typeof b.onclick !== 'function') { console.log('未绑定:', id); failed++; continue; }
  try { await b.onclick({ preventDefault() {}, target: b }); } catch (e) { console.log('点击异常', id, e && e.message); failed++; }
  await new Promise(r => setTimeout(r, 150));
}
const bs = store.get('batchState').textContent || '';
if (!/完成|已同步|准备/.test(bs)) { console.log('任务文案不符', JSON.stringify(bs)); failed++; }
await new Promise(r => setTimeout(r, 50));

console.log('绑定数', bound, '失败', failed, 'invoke 调用', [...new Set(called)].join(','));
if (errors.length) { console.log('渲染告警:'); errors.slice(0, 10).forEach(e => console.log(' -', e)); }
process.exit(failed || errors.length ? 1 : 0);
