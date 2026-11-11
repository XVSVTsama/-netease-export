/* NetEase Exporter 前端（无框架，无动画库） */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const fmtTrack = ms => { if (!ms) return '--:--'; const t = Math.round(ms / 1000), m = Math.floor(t / 60), sec = t % 60; return m >= 60 ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`; };
const fmtDur = ms => { const s = Math.round(ms / 1000); return s < 60 ? s + ' 秒' : Math.floor(s / 60) + ' 分 ' + (s % 60) + ' 秒'; };

/* ---------- 主题 ---------- */
const savedTheme = localStorage.getItem('theme');
if (savedTheme) document.documentElement.dataset.theme = savedTheme;
else if (matchMedia('(prefers-color-scheme: dark)').matches) document.documentElement.dataset.theme = 'dark';
function toggleTheme() {
  const cur = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = cur;
  localStorage.setItem('theme', cur);
  const b = $('#themeBtn'); if (b) b.textContent = cur === 'dark' ? '☀' : '☾';
}
if ($('#themeBtn')) {
  $('#themeBtn').textContent = document.documentElement.dataset.theme === 'dark' ? '☀' : '☾';
  $('#themeBtn').onclick = toggleTheme;
}

/* ---------- 隐私模式（截图脱敏） ---------- */
let PRIVACY = localStorage.getItem('privacy') === '1';
const PL_ORDER = new Map();
async function loadPlaylistOrder() {
  try {
    const list = await fetch('/api/playlists').then(r => r.json());
    list.forEach((p, i) => PL_ORDER.set(String(p.id), i + 1));
  } catch {}
}
const maskAccount = (name, i) => PRIVACY ? `账号 ${i + 1}` : name;
function maskPlName(name, id) {
  if (!PRIVACY) return name;
  const idx = PL_ORDER.get(String(id));
  return idx ? `歌单 ${String(idx).padStart(3, '0')}` : '歌单 •••';
}
const plText = arr => (arr || []).map(p => typeof p === 'string' ? (PRIVACY ? '歌单 •••' : p) : maskPlName(p.name, p.id) + (p.privacy === 10 ? '(私密)' : '')).join('；');
function bindPrivacy() {
  const btn = document.getElementById('privacyBtn');
  if (!btn) return;
  btn.textContent = PRIVACY ? '🔓' : '🔒';
  btn.title = PRIVACY ? '当前已隐藏用户名与歌单名，点击恢复' : '隐藏用户名与歌单名（截图用）';
  btn.onclick = () => { localStorage.setItem('privacy', PRIVACY ? '0' : '1'); location.reload(); };
}

/* ---------- 字符显示模式 ---------- */
let CHARMODE = localStorage.getItem('charMode') || 'raw';
function setCharMode(m, rerender) {
  CHARMODE = m;
  localStorage.setItem('charMode', m);
  $$('.mode').forEach(x => x.classList.toggle('on', x.dataset.m === m));
  if (rerender) rerender();
}
function disp(s) {
  const t = String(s ?? '');
  if (CHARMODE === 'raw') return t;
  const invisible = cp => cp < 0x20 || cp === 0x7f || (cp >= 0x200b && cp <= 0x200f) ||
    (cp >= 0x202a && cp <= 0x202e) || (cp >= 0x2066 && cp <= 0x2069) || cp === 0xfeff || cp === 0xad ||
    (cp >= 0x0300 && cp <= 0x036f);
  if (CHARMODE === 'mark') return t.replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff\u00ad]/g, c => '⟨U+' + c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0') + '⟩');
  if (CHARMODE === 'esc') return [...t].map(c => { const cp = c.codePointAt(0); return invisible(cp) ? '\\u' + cp.toString(16).toUpperCase().padStart(4, '0') : c; }).join('');
  if (CHARMODE === 'cp') return [...t].map(c => 'U+' + c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')).join(' ');
  if (CHARMODE === 'skeleton') return t.replace(/[\p{Mn}\p{Mc}\p{Cf}]/gu, '');
  return t;
}
function bindModes(rerender) {
  $$('.mode').forEach(b => { b.onclick = () => setCharMode(b.dataset.m, rerender); });
  setCharMode(CHARMODE, null);
}
const MODES_HTML = `
<div class="modes">
  <button class="mode" data-m="raw">原始</button>
  <button class="mode" data-m="mark">标记不可见</button>
  <button class="mode" data-m="esc">转义 \\uXXXX</button>
  <button class="mode" data-m="cp">U+ 码点</button>
  <button class="mode" data-m="skeleton">去组合符</button>
</div>`;

/* ---------- 账号 ---------- */
async function renderAccounts(st) { /* 账号入口已移到右下角设置面板 */ }

/* ---------- 首页 ---------- */
async function bootHome() {
  const el = {
    sub: $('#sub'), stats: $('#stats'), log: $('#log'), banner: $('#banner'),
    jobName: $('#jobName'), dot: $('#dot'), jobState: $('#jobState'), hist: $('#hist'), zipHint: $('#zipHint'),
  };
  let lastLen = -1;
  async function tick() {
    const d = await fetch('/api/status').then(r => r.json()).catch(() => null);
    if (!d) return setTimeout(tick, 4000);
    await renderAccounts(d);
    const s = d.stats || {}, j = d.job || {};
    if (el.sub) el.sub.textContent = `同步 ${s.lastSync || '—'} · 文档 ${s.docTime || '—'}`;
    const pn = document.getElementById('pendingNote');
    if (pn) {
      if (s.pendingStage) { pn.style.display = 'block'; pn.textContent = '暂存区有待提交的同步结果：点「整理」生成文档，点「核验」校验并提交。'; }
      else pn.style.display = 'none';
    }
    const cm = document.getElementById('createdMeta'); if (cm) cm.textContent = '';
    const fm = document.getElementById('favMeta'); if (fm) fm.textContent = '';
    const cs = document.getElementById('createdStats');
    if (cs) {
      const active = Math.max(0, (s.unique || 0) - (s.down || 0));
      cs.innerHTML = [
        ['歌单', 'playlists', s.playlists, `公开 ${(s.playlists || 0) - (s.priv || 0)} · 私密 ${s.priv ?? 0}`],
        ['歌曲数目', 'songs', s.unique, `去重 ${active} · 下架 ${s.down ?? 0}`],
      ].map(([k, key, v, sub]) => `<div class="stat"><div class="k">${k}<button class="info" data-info="${key}" aria-label="说明">i</button></div><div class="v">${v ?? '—'}</div>${sub ? `<div class="sub">${sub}</div>` : ''}</div>`).join('');
      $$('#createdStats [data-info]').forEach(b => b.onclick = e => { e.stopPropagation(); showInfo(b.dataset.info); });
    }
    const fs2 = document.getElementById('favStats');
    if (fs2) fs2.innerHTML = [
      ['收藏歌单', s.collectedPlaylists], ['收藏专辑', s.albums], ['收藏曲目', s.collectedPlaylistSongs],
    ].map(([k, v]) => `<div class="stat"><div class="k">${k}</div><div class="v">${v ?? '—'}</div></div>`).join('');
    if (el.jobName) el.jobName.textContent = j.name || '空闲';
    if (el.jobState) el.jobState.textContent = j.running ? '运行中 · ' + fmtDur(Date.now() - j.start) : (j.exit === 0 ? '已完成' : j.exit !== null ? '失败(' + j.exit + ')' : '待命');
    if (el.dot) el.dot.className = 'dot ' + (j.running ? 'run' : j.exit === 0 ? 'ok' : j.exit !== null ? 'err' : '');
    if (el.banner) {
      if (!j.running && j.exit !== null && j.exit !== 0) {
        el.banner.style.display = 'block';
        el.banner.textContent = '任务失败：步骤「' + (j.failedStep || '未知') + '」，退出码 ' + j.exit;
      } else el.banner.style.display = 'none';
    }
    const lines = j.lines || [];
    if (el.log && lines.length !== lastLen) {
      lastLen = lines.length;
      const box = el.log;
      const bottom = box.scrollTop + box.clientHeight > box.scrollHeight - 40;
      box.innerHTML = lines.length ? lines.map(l => {
        let cls = '';
        if (l.startsWith('::STEP::')) cls = 'l-step';
        else if (l.startsWith('::ERROR') || l.startsWith('::STDERR') || /^\[FAIL\]/.test(l)) cls = 'l-err';
        else if (l.startsWith('::SUMMARY') || /^\[PASS\]/.test(l)) cls = 'l-ok';
        else if (l.startsWith('::SKIP') || /警告|WARN/.test(l)) cls = 'l-warn';
        else if (l.startsWith('::')) cls = 'l-dim';
        return `<div class="${cls}">${esc(l.replace(/^::\w+::/, ''))}</div>`;
      }).join('') : '<div class="l-dim">等待任务…</div>';
      if (bottom) box.scrollTop = box.scrollHeight;
    }
    if (el.hist) el.hist.innerHTML = (d.history || []).length
      ? d.history.map(h => {
          const t = new Date(h.start).toLocaleString('zh-CN', { hour12: false });
          const ok = h.exit === 0;
          return `<div class="row" style="cursor:default"><div class="body"><div class="title">${esc(h.name)}</div><div class="meta">${t}</div></div><div class="tail" style="color:${ok ? 'var(--ok)' : 'var(--accent)'}">${ok ? '成功' : '失败' + (h.failedStep ? '：' + esc(h.failedStep) : '')}</div></div>`;
        }).join('')
      : '<div class="empty">暂无记录</div>';
    if (el.zipHint) el.zipHint.textContent = (d.dest ? '导出目录：' + d.dest + '　' : '') + (s.zipTime ? `打包于 ${s.zipTime}，${((s.zipSize || 0) / 1048576).toFixed(2)} MB` : '');
    $$('button[data-run]').forEach(b => b.disabled = !!j.running);
    setTimeout(tick, j.running ? 1200 : 5000);
  }
  $$('button[data-run]').forEach(b => {
    b.onclick = async () => {
      const r = await fetch('/run/' + b.dataset.run, { method: 'POST' }).then(x => x.json());
      if (!r.ok) alert(r.error || '无法启动');
      tick();
    };
  });
  tick();
}

/* ---------- 歌单浏览 ---------- */
async function bootBrowse() {
  await PL_ORDER_READY;
  let SCOPE = new URLSearchParams(location.search).get('scope') === 'collected' ? 'collected' : 'created';
  let ALL = [], COLLECTED = [], tab = 'all', cur = null, page = 0, PAGE = 100;
  const listEl = $('#plist'), viewer = $('#viewer');
  const q = $('#q');

  async function load() {
    ALL = await fetch('/api/playlists').then(r => r.json());
    COLLECTED = await fetch('/api/collected-playlists').then(r => r.json()).catch(() => []);
    renderList();
  }
  function filtered() {
    const v = (q.value || '').trim().toLowerCase();
    if (SCOPE === 'collected') {
      return COLLECTED.filter(p => !v || p.name.toLowerCase().includes(v) || String(p.id).includes(v));
    }
    return ALL.filter(p => {
      if (tab === 'pub' && p.privacy === 10) return false;
      if (tab === 'priv' && p.privacy !== 10) return false;
      if (tab === 'top' && !p.top) return false;
      if (tab === 'empty' && p.count !== 0) return false;
      if (tab === 'small' && p.count >= 50) return false;
      if (tab === 'mid' && (p.count < 50 || p.count >= 500)) return false;
      if (tab === 'big' && p.count < 500) return false;
      if (!v) return true;
      return p.name.toLowerCase().includes(v) || String(p.id).includes(v);
    });
  }
  function renderList() {
    const arr = filtered();
    if (SCOPE === 'collected') {
      listEl.innerHTML = arr.length ? arr.map(p =>
        `<a class="row" href="https://music.163.com/playlist?id=${p.id}" target="_blank" style="text-decoration:none;color:inherit">
          <img class="thumb" loading="lazy" src="/img?kind=pl&id=${p.id}&s=96" alt="">
          <div class="body"><div class="title">${esc(PRIVACY ? '收藏歌单 ' + (COLLECTED.findIndex(x => x.id === p.id) + 1) : p.name)}</div>
          <div class="meta">${esc(p.creator || '未知作者')} · ${p.count} 首</div></div><div class="tail">↗</div></a>`).join('')
        : '<div class="empty">没有匹配的收藏歌单</div>';
      $('#cnt').textContent = `本地清单 · 收藏 ${arr.length} 个歌单（未导出逐曲，点击跳转网易云）`;
      return;
    }
    listEl.innerHTML = arr.length ? arr.map(p =>
      `<button class="row ${cur && cur.id === p.id ? 'on' : ''}" data-id="${p.id}">
        <img class="thumb" loading="lazy" src="/img?kind=pl&id=${p.id}&s=96" alt="">
        <div class="body"><div class="title">${p.top ? '<span style="color:var(--accent)">📌 </span>' : ''}${esc(maskPlName(p.name, p.id))}</div>
        <div class="meta">${p.privacy === 10 ? '🔒 私密' : '公开'} · ${p.count} 首</div></div>
      </button>`).join('') : '<div class="empty">没有匹配的歌单</div>';
    $('#cnt').textContent = `本地整理 · ${arr.length} / ${ALL.length} 个歌单${tab !== 'all' ? '（已筛选）' : ''}`;
    $$('#plist [data-id]').forEach(b => b.onclick = () => openPl(b.dataset.id));
  }
  $$('#tabs .chip').forEach(b => b.onclick = () => {
    tab = b.dataset.f;
    $$('#tabs .chip').forEach(x => x.classList.toggle('on', x === b));
    $('#viewer').style.display = 'none';
    renderList();
  });
  function setScope(sc) {
    SCOPE = sc;
    $$('#scopeSeg button').forEach(x => x.classList.toggle('on', x.dataset.scope === sc));
    $('#tabs').style.display = sc === 'collected' ? 'none' : 'flex';
    $('#viewer').style.display = 'none';
    cur = null;
    q.value = '';
    renderList();
  }
  $$('#scopeSeg button').forEach(b => b.onclick = () => setScope(b.dataset.scope));
  q.oninput = renderList;

  async function openPl(id) {
    const d = await fetch('/api/playlist/' + id).then(r => r.json());
    if (d.error) return alert(d.error);
    cur = d; page = 0; $('#sq').value = '';
    viewer.style.display = 'block';
    $('#vName').textContent = maskPlName(d.name, d.id);
    $('#vMeta').innerHTML = `${d.privacy === 10 ? '🔒 私密' : '公开'} · ${d.rows.length} 首 · ${d.company_filled} 首有厂牌 ·
      <a href="https://music.163.com/playlist?id=${d.id}" target="_blank">在网易云打开 ↗</a>`;
    const desc = $('#vDesc');
    if (d.description && d.description.trim()) { desc.style.display = 'block'; desc.textContent = d.description; }
    else desc.style.display = 'none';
    renderList(); renderTracks();
    viewer.scrollIntoView({ block: 'start' });
  }
  function trackRows() {
    const v = ($('#sq').value || '').trim().toLowerCase();
    // 一律去失效：只保留正常曲目（已下架 / 仅其他版本 / 其他异常不进列表）
    const alive = cur.rows.filter(s => (s.cat || 'ok') === 'ok');
    if (!v) return alive;
    return alive.filter(s => [s.name, s.ar, s.al, s.company].join(' ').toLowerCase().includes(v));
  }
  function renderTracks() {
    const arr = trackRows(), pages = Math.max(1, Math.ceil(arr.length / PAGE));
    const hidden = cur.rows.length - cur.rows.filter(s => (s.cat || 'ok') === 'ok').length;
    const hn = $('#hiddenNote');
    if (hn) {
      if (hidden > 0) { hn.style.display = 'block'; hn.textContent = `已按「去失效」隐藏 ${hidden} 首失效曲目；这些曲子仍完整保留在导出文档与 CSV 中。`; }
      else hn.style.display = 'none';
    }
    if (page >= pages) page = pages - 1;
    const slice = arr.slice(page * PAGE, (page + 1) * PAGE);
    $('#tracks').innerHTML = slice.length ? slice.map((s, i) => {
      const flags = [s.masked ? '含遮盖' : '', s.cat === 'down' ? '已下架' : s.cat === 'otherVersion' ? '仅其他版本可播' : s.cat === 'other' ? '版权受限' : ''].filter(Boolean);
      const alb = s.alId ? `<a href="https://music.163.com/album?id=${s.alId}" target="_blank">${esc(disp(s.al || '专辑'))} ↗</a>` : esc(disp(s.al || '未知'));
      return `<div class="track"><div class="idx">${page * PAGE + i + 1}</div>
        <div class="body"><div class="title">${esc(disp(s.name || '[元数据缺失]'))}${flags.length ? '<span class="flag">〔' + flags.join(' / ') + '〕</span>' : ''}</div>
        <div class="meta">${esc(disp(s.ar || '未知'))} · ${alb} · ${esc(s.company || '未标注厂牌')} · ${fmtTrack(s.dur)}</div></div></div>`;
    }).join('') : '<div class="empty">没有匹配曲目</div>';
    $('#pager').innerHTML = `<button data-pg="-1" ${page === 0 ? 'disabled' : ''}>上一页</button>
      <span>${page + 1} / ${pages} · 共 ${arr.length} 首</span>
      <button data-pg="1" ${page >= pages - 1 ? 'disabled' : ''}>下一页</button>`;
    $$('#pager [data-pg]').forEach(b => b.onclick = () => { page += +b.dataset.pg; renderTracks(); $('#tracks').scrollTop = 0; });
  }
  $('#sq').oninput = () => { page = 0; renderTracks(); };
  bindModes(renderTracks);
  await load();
  setScope(SCOPE);
}

/* ---------- 我的专辑 ---------- */
async function bootAlbums() {
  await PL_ORDER_READY;
  const scope = 'collected';
  let ALL = [], cur = null;
  const grid = $('#grid'), detail = $('#detail');
  async function load() {
    const api = '/api/collected-albums';
    ALL = await fetch(api).then(r => r.json()).catch(() => []);
    renderGrid();
  }
  function renderGrid() {
    const v = ($('#q').value || '').trim().toLowerCase();
    const arr = ALL.filter(a => !v || [a.name, a.artists, a.company].join(' ').toLowerCase().includes(v));
    const label = '我收藏的';
    $('#cnt').textContent = `本地整理 · ${label}专辑 ${ALL.length} 张 · 匹配 ${arr.length} 张`;
    grid.innerHTML = arr.length ? arr.map(a =>
      `<button class="tile" data-id="${a.id}">
        <img loading="lazy" src="/img?kind=al&id=${a.id}&s=300" alt="">
        <div class="t-name">${esc(a.name || '未命名')}</div>
        <div class="t-meta">${esc(a.artists || '未知')} · ${a.size} 首</div>
      </button>`).join('') : `<div class="empty">${scope === 'created' ? '当前账号不是网易云音乐人，没有创建的专辑' : '没有匹配的专辑'}</div>`;
    $$('#grid [data-id]').forEach(b => b.onclick = () => openAlbum(b.dataset.id));
  }
  async function openAlbum(id) {
    const d = await fetch('/api/album/' + id).then(r => r.json());
    if (d.error) return alert(d.error);
    cur = d;
    detail.style.display = 'block';
    const t = d.publishTime ? new Date(d.publishTime).toISOString().slice(0, 10) : '—';
    $('#hero').innerHTML = `<img src="/img?kind=al&id=${d.id}&s=400" alt="">
      <div class="h-body"><h3>${esc(d.name)}</h3>
      <div class="h-meta">${esc(d.artists || '未知')}<br>${esc(d.company || '未标注厂牌')} · ${t} · ${(d.songs || []).length || d.size} 首</div>
      <div class="h-meta"><a href="https://music.163.com/album?id=${d.id}" target="_blank">在网易云打开 ↗</a></div></div>`;
    $('#dsongs').innerHTML = (d.songs || []).length
      ? d.songs.map((s, i) => `<div class="track"><div class="idx">${i + 1}</div><div class="body"><div class="title">${esc(s.name)}</div><div class="meta">${esc(s.ar || d.artists || '未知')}</div></div></div>`).join('')
      : '<div class="empty">网易专辑接口当前不返回曲目列表</div>';
    detail.scrollIntoView({ block: 'start' });
  }
  $('#q').oninput = renderGrid;
  await load();
}

/* ---------- 专项视图 ---------- */
async function bootDocs() {
  await PL_ORDER_READY;
  let DATA = null, tab = 'down', page = 0, PAGE = 100, BATCH_PROGRESS = { done: 0, total: 0 };
  const KEYS = [['down', '已下架'], ['otherVersion', '其他版本'], ['deleted', '已删除'], ['other', '其他异常'], ['special', '特殊字符'], ['nonLatin', '非拉丁文字']];
  const DESC = {
    down: '接口 privilege.st = -200，不可播放且无替代版本',
    otherVersion: '网易云标注「其它版本可播」',
    deleted: '上次快照存在、本次同步查不到',
    other: '有版权提示但未归入其他三类',
    special: '曲名含组合符、零宽控制符或图形符号',
    nonLatin: '曲名含非拉丁文字系统',
  };
  async function load() {
    DATA = await fetch('/api/special').then(r => r.json());
    renderTabs(); render();
  }
  function renderTabs() {
    $('#tabs').innerHTML = KEYS.map(([k, label]) =>
      `<button class="chip ${tab === k ? 'on' : ''}" data-t="${k}">${label} ${(DATA[k] || []).length}</button>`).join('');
    $$('#tabs [data-t]').forEach(b => b.onclick = () => { tab = b.dataset.t; page = 0; $('#q').value = ''; renderTabs(); render(); });
    const bar = document.getElementById('batchBar');
    if (bar) {
      const total = (DATA[tab] || []).length;
      bar.innerHTML = batchRunning
        ? `<span style="font-size:13px;color:var(--muted)">对比中… ${BATCH_PROGRESS.done}/${BATCH_PROGRESS.total}</span>`
        : `<button class="btn small" id="batchBtn" ${total ? '' : 'disabled'}>一键对比全部（${total} 首）</button><span class="hint" style="margin-left:8px">仅查 QQ · 其余标注连通性</span>`;
      const btn = document.getElementById('batchBtn');
      if (btn) btn.onclick = startBatch;
    }
  }
  function startBatch() {
    if (batchRunning) return;
    const rows = (DATA[tab] || []);
    if (!rows.length) return;
    batchRunning = true; BATCH_PROGRESS = { done: 0, total: 0 };
    renderTabs(); render();
    runBatchCompare(rows, (done, total) => {
      BATCH_PROGRESS = { done, total };
      const st = document.querySelector('#batchBar span');
      if (st) st.textContent = `对比中… ${done}/${total}`;
    }).then(() => {
      batchRunning = false;
      renderTabs(); render();
    }).catch(() => { batchRunning = false; renderTabs(); render(); });
  }
  function arr() {
    const v = ($('#q').value || '').trim().toLowerCase();
    const a = DATA[tab] || [];
    if (!v) return a;
    return a.filter(s => [s.name, s.ar, s.al, s.company, (s.playlists || []).join(' '), (s.kinds || []).join(' '), (s.langs || []).join(' ')].join(' ').toLowerCase().includes(v));
  }
  function render() {
    const list = arr(), pages = Math.max(1, Math.ceil(list.length / PAGE));
    if (page >= pages) page = pages - 1;
    $('#desc').textContent = DESC[tab] + ' · 共 ' + list.length + ' 首';
    const bb = document.getElementById('batchBtn');
    if (bb) bb.style.display = list.length ? 'inline-block' : 'none';
    $('#list').innerHTML = list.slice(page * PAGE, (page + 1) * PAGE).map((s, i) => {
      const tags = [...(s.kinds || []), ...(s.langs || [])].filter(Boolean).map(t => `<span class="tag">${esc(t)}</span>`).join('');
      return `<div class="track"><div class="idx">${page * PAGE + i + 1}</div>
        <div class="body"><div class="title">${esc(disp(s.name || '[元数据缺失]'))}${tags}<button class="find-btn" data-find="${esc(s.name || '')}" data-artist="${esc(s.ar || '')}">全网对比</button></div>
        <div class="meta">${esc(disp(s.ar || '未知'))} · ${esc(disp(s.al || '未知'))}${s.company ? ' · ' + esc(s.company) : ''} · ${fmtTrack(s.dur)}</div>
        <div class="meta">歌单：${esc(plText(s.playlists))}${s.lastSeen ? ' · 最后出现 ' + esc(s.lastSeen) : ''}${badgeOf(s)}</div></div></div>`;
    }).join('') || '<div class="empty">没有匹配条目</div>';
    $('#pager').innerHTML = `<button data-pg="-1" ${page === 0 ? 'disabled' : ''}>上一页</button>
      <span>${page + 1} / ${pages} · 共 ${list.length} 首</span>
      <button data-pg="1" ${page >= pages - 1 ? 'disabled' : ''}>下一页</button>`;
    $$('#pager [data-pg]').forEach(b => b.onclick = () => { page += +b.dataset.pg; render(); $('#list').scrollTop = 0; });
    $$('#list [data-find]').forEach(b => b.onclick = e => { e.stopPropagation(); openFind(b.dataset.find, b.dataset.artist); });
  }
  $('#q').oninput = () => { page = 0; render(); };
  bindModes(render);
  await load();
}

/* ---------- 卡片说明弹窗 ---------- */
const CARD_INFO = {
  playlists: {
    title: '歌单数目',
    body: '只统计你自己创建的歌单，不含收藏。私密以接口 privacy 字段判定：10 为私密，0 为公开；公开数 = 总数 − 私密数。',
    note: '数据来源：本地导出文件 out2/playlists_full.json',
  },
  songs: {
    title: '歌曲数目',
    body: '按歌曲 ID 去重，同一首歌出现在多个歌单里只计一次。总数 = 去重（可播放）+ 已下架。已下架指接口 privilege.st = −200 且没有替代版本的曲目，它们仍完整保留在歌单明细与 CSV 中。',
    note: '数据来源：本地导出文件 out2/playlists_full.json',
  },
};
function showInfo(key) {
  const d = CARD_INFO[key];
  if (!d) return;
  let mask = document.getElementById('infoMask');
  if (!mask) {
    mask = document.createElement('div');
    mask.id = 'infoMask'; mask.className = 'sheet-mask';
    mask.onclick = e => { if (e.target === mask) mask.remove(); };
    document.body.appendChild(mask);
  }
  mask.innerHTML = `<div class="sheet info-sheet"><h3>${esc(d.title)}</h3><p>${esc(d.body)}</p><div class="hint">${esc(d.note || '')}</div><button class="ok">确定</button></div>`;
  mask.querySelector('.ok').onclick = () => mask.remove();
}

/* ---------- 右下角设置面板 ---------- */
function ensureFab() {
  const tabs = document.querySelector('.tabs');
  if (!tabs || tabs.querySelector('.tab-set')) return;
  const b = document.createElement('button');
  b.className = 'tab-set';
  b.innerHTML = '<span class="i">⚙</span>设置';
  b.onclick = openSetSheet;
  tabs.appendChild(b);
}
async function openSetSheet() {
  let mask = document.getElementById('setMask');
  if (!mask) {
    mask = document.createElement('div');
    mask.id = 'setMask'; mask.className = 'sheet-mask';
    mask.onclick = e => { if (e.target === mask) mask.remove(); };
    document.body.appendChild(mask);
  }
  mask.innerHTML = '<div class="sheet"><h3>设置</h3><div class="empty">加载中…</div></div>';
  const [st, cfg] = await Promise.all([
    fetch('/api/status').then(r => r.json()).catch(() => ({})),
    fetch('/api/settings').then(r => r.json()).catch(() => ({ accounts: [], current: '' })),
  ]);
  const accs = cfg.accounts || [];
  const cur = cfg.accounts.find(a => a.id === cfg.current) || {};
  mask.querySelector('.sheet').innerHTML = `
    <h3>设置</h3>
    <div class="q">当前账号 ${esc(maskAccount(cur.nick || cur.id || '', accs.findIndex(a => a.id === cfg.current)))}（${accs.length} 个账号）</div>
    <div class="sec">账号（点击切换）</div>
    ${accs.map((a, i) => `<div class="acc-row ${a.id === cfg.current ? 'on' : ''}" data-acc="${a.id}">
        <span class="nm">${esc(maskAccount(a.nick || a.id, i))}</span>
        <span class="uid">${a.uid ? 'uid ' + esc(a.uid) : ''}${a.id === cfg.current ? ' · 当前' : ''}</span>
      </div>`).join('')}
    <a class="btn" href="/login?acc=new" style="margin-top:10px">＋ 添加账号（扫码）</a>
    <div class="sec">导出目录</div>
    <div class="dest-row">
      <input type="text" id="setDest" value="${esc(cur.dest || '')}" placeholder="/workspace/mounts/Download/网易云歌单导出">
      <button id="setSave">保存</button>
    </div>
    <div class="sec">快捷导出（当前账号）</div>
    <div class="quick">
      <button data-q="sync">同步并重建</button>
      <button data-q="tidy">整理</button>
      <button data-q="check">仅核查</button>
      <button data-q="full">全流程</button>
    </div>
    <a class="btn" href="/settings" style="margin-top:12px">更多设置（目录候选 / 账号详情）</a>
    <button class="btn close">关闭</button>`;
  mask.querySelector('.close').onclick = () => mask.remove();
  $$('#setMask [data-acc]').forEach(el => el.onclick = async () => {
    await fetch('/api/switch?acc=' + encodeURIComponent(el.dataset.acc), { method: 'POST' });
    location.reload();
  });
  $('#setSave').onclick = async () => {
    const dest = $('#setDest').value.trim();
    if (!dest) return alert('路径不能为空');
    const r = await fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: cfg.current, dest }) }).then(x => x.json()).catch(() => null);
    if (r && r.ok) { alert('已保存：' + dest); location.reload(); } else alert((r && r.error) || '保存失败');
  };
  $$('#setMask [data-q]').forEach(b => b.onclick = async () => {
    const r = await fetch('/run/' + b.dataset.q, { method: 'POST' }).then(x => x.json()).catch(() => null);
    if (r && r.ok) { mask.remove(); location.href = '/'; } else alert((r && r.error) || '无法启动');
  });
}

/* ---------- 设置页 ---------- */
async function bootSettings() {
  const listEl = $('#accList'), dirsEl = $('#dirs');
  let dirs = [];
  let lastFocus = null;

  async function load() {
    const [st, dd] = await Promise.all([
      fetch('/api/settings').then(r => r.json()).catch(() => ({ accounts: [] })),
      fetch('/api/dirs').then(r => r.json()).catch(() => ({ items: [] })),
    ]);
    dirs = dd.items || [];
    $('#accCount').textContent = `${st.accounts.length} 个`;
    listEl.innerHTML = st.accounts.map(a => `
      <div class="card" style="margin-bottom:10px">
        <div style="display:flex;justify-content:space-between;align-items:baseline;gap:8px">
          <strong style="font-size:15px">${esc(maskAccount(a.nick || a.id, st.accounts.indexOf(a)))}</strong>
          <span class="hint" style="margin:0">${a.uid ? 'uid ' + esc(a.uid) : ''}${a.id === st.current ? ' · 当前' : ''}</span>
        </div>
        <div class="hint">数据目录：${esc(a.root)}${a.hasCookie ? '' : '（未登录）'}</div>
        <input type="text" data-dest="${a.id}" value="${esc(a.dest)}" placeholder="导出目录，例如 /workspace/mounts/Download/网易云歌单导出" style="margin-top:8px">
        <div class="actions" style="margin-top:8px">
          <button class="btn small" data-save="${a.id}">保存路径</button>
          <button class="btn small" data-current="${a.id}" ${a.id === st.current ? 'disabled' : ''}>设为当前</button>
        </div>
      </div>`).join('');
    $$('[data-save]').forEach(b => b.onclick = () => saveDest(b.dataset.save));
    $$('[data-current]').forEach(b => b.onclick = () => makeCurrent(b.dataset.current));
    $$('[data-dest]').forEach(inp => inp.onfocus = () => { lastFocus = inp; });
    renderDirs();
    await loadProxy();
  }
  function renderDirs() {
    dirsEl.innerHTML = dirs.map(d => `<button class="chip" data-dir="${esc(d.path)}">${esc(d.name)}</button>`).join('') || '<span class="hint">没有可选目录</span>';
    $$('#dirs [data-dir]').forEach(b => b.onclick = () => {
      const target = lastFocus || $('[data-dest]');
      if (!target) return alert('先点一个账号的路径输入框');
      target.value = b.dataset.dir;
      target.focus();
    });
  }
  async function saveDest(id) {
    const inp = $(`[data-dest="${id}"]`);
    const dest = (inp.value || '').trim();
    if (!dest) return alert('路径不能为空');
    const r = await fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, dest }) }).then(x => x.json()).catch(() => null);
    if (r && r.ok) { inp.blur(); alert('已保存：' + dest); load(); } else alert((r && r.error) || '保存失败');
  }
  async function makeCurrent(id) {
    await fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, makeCurrent: true }) });
    location.reload();
  }
  async function loadProxy() {
    const p = await fetch('/api/proxy').then(r => r.json()).catch(() => null);
    if (!p) return;
    const url = $('#proxyUrl'), en = $('#proxyEnabled'), st = $('#proxyState');
    if (url) url.value = p.url || '';
    if (en) en.checked = !!p.enabled;
    if (st) st.textContent = p.applied ? '已生效' : (p.enabled ? '已保存未生效' : '未启用');
  }
  async function loadProxy() {
    const el = $('#exitInfo');
    if (!el) return;
    el.textContent = '检测中…';
    const p = await fetch('/api/proxy').then(r => r.json()).catch(() => null);
    if (!p) { el.textContent = '检测失败'; return; }
    el.textContent = p.port
      ? `检测到本地代理端口 ${p.port}，出口经 ${p.url}（${p.source}）`
      : (p.url ? `出口经 ${p.url}（${p.source}）` : '未检测到可用代理，使用直连');
  }
  const er = $('#exitRefresh');
  if (er) er.onclick = () => loadProxy();
  await load();
}

bindPrivacy();
ensureFab();
const PL_ORDER_READY = loadPlaylistOrder();
const page = document.body.dataset.page;
if (page !== 'home' && page !== 'login') {
  fetch('/api/status').then(r => r.json()).then(d => renderAccounts(d)).catch(() => {});
}
if (page === 'home') bootHome();
else if (page === 'browse') bootBrowse();
else if (page === 'albums') bootAlbums();
else if (page === 'docs') bootDocs();
else if (page === 'settings') bootSettings();
