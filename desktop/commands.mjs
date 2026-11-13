// 桌面版命令实现：与 APK 的 tauri 命令一一对应
import fs from 'node:fs';
import path from 'node:path';
import {
  tidy, check, stageOne, stageIds, stageStats, specialItems, saveArchive, subOf, toCsv, toMd, sanitize,
} from './exporter.mjs';

const PHASE = { sync: '同步', tidy: '补厂牌', 'tidy-doc': '整理', check: '核验', done: '完成' };
const KIND_NAME = { pl: '我创建的歌单', plfav: '收藏歌单', al: '收藏专辑' };
const nowStamp = () => {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};
const nowTime = () => new Date().toLocaleTimeString('zh-CN', { hour12: false });
const nowHuman = () => new Date().toLocaleString('zh-CN', { hour12: false });

export function createCommands(ctx) {
  const { api, app, dialog } = ctx;

  const job = {
    running: false, stop: false, kind: '', phase: 'idle',
    total: 0, done: 0, phaseTotal: 0, phaseDone: 0,
    ok: 0, fail: 0, songs: 0, started: 0, step: '',
    logs: [], logPath: '',
  };

  const log = (k, t) => {
    job.logs.push({ k, ts: nowTime(), t });
    if (job.logs.length > 600) job.logs.shift();
    try { if (job.logPath) fs.appendFileSync(job.logPath, `[${nowTime()}] ${t}\n`); } catch {}
  };

  const settingsFile = () => path.join(app.dataDir, 'settings.json');
  const readSettings = () => {
    try { return JSON.parse(fs.readFileSync(settingsFile(), 'utf8')); } catch { return {}; }
  };
  const writeSettings = s => {
    fs.mkdirSync(app.dataDir, { recursive: true });
    fs.writeFileSync(settingsFile(), JSON.stringify(s));
  };
  const writable = dir => {
    try {
      fs.mkdirSync(dir, { recursive: true });
      const probe = path.join(dir, '.eta_write_test');
      fs.writeFileSync(probe, 'ok');
      fs.unlinkSync(probe);
      return null;
    } catch (e) { return String(e.message || e); }
  };
  const writeBoth = (rel, content) => {
    const saved = [];
    const priv = path.join(app.dataDir, 'exports', rel);
    fs.mkdirSync(path.dirname(priv), { recursive: true });
    fs.writeFileSync(priv, content);
    saved.push(priv);
    const err = writable(app.exportDir);
    if (!err) {
      const pub = path.join(app.exportDir, rel);
      fs.mkdirSync(path.dirname(pub), { recursive: true });
      fs.writeFileSync(pub, content);
      saved.push(pub);
    }
    return saved;
  };

  const extrasFile = (kind, id) => path.join(app.dataDir, 'extras', kind, `${id}.json`);
  const loadExtras = (kind, id) => {
    try { return JSON.parse(fs.readFileSync(extrasFile(kind, id), 'utf8')).items || []; } catch { return []; }
  };
  const saveExtras = (kind, id, items) => {
    const p = extrasFile(kind, id);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ items }));
  };

  async function runJob(kind, ids, doTidy, doCheck, withFill) {
    const sub = subOf(kind);
    job.running = true; job.stop = false; job.kind = kind; job.phase = 'sync';
    job.total = ids.length; job.done = 0; job.ok = 0; job.fail = 0; job.songs = 0;
    job.phaseTotal = 0; job.phaseDone = 0; job.started = Date.now();
    job.logs = [];
    job.logPath = path.join(app.dataDir, 'logs', `job-${nowStamp()}.log`);
    try { fs.mkdirSync(path.dirname(job.logPath), { recursive: true }); } catch {}
    log('step', `开始：${KIND_NAME[kind] || kind} · ${ids.length} 项待同步`);

    for (let i = 0; i < ids.length; i++) {
      if (job.stop) { log('warn', '已按请求停止'); break; }
      job.done = i + 1;
      try {
        const r = await stageOne(app, api, kind, ids[i]);
        job.ok++; job.songs += r.count;
        job.step = r.name;
        log('ok', `${r.name} · ${r.count} 首`);
      } catch (e) {
        job.fail++;
        log('err', `#${ids[i]} · ${e.message || e}`);
      }
    }

    if (doTidy && !job.stop) {
      job.phase = 'tidy';
      if (withFill) {
        log('step', '补厂牌（联网，较慢）');
        try {
          const cache = new Map();
          for (const { id, data } of readStageSafe(kind)) {
            const rows = data.rows || [];
            const need = rows.filter(r => !r.company && r.alId);
            if (!need.length) continue;
            if (job.stop) break;
            const cmp = await api.fillCompanies(need);
            for (const r of rows) {
              if (r.alId && cmp.has(r.alId) && !r.company) {
                r.company = cmp.get(r.alId);
                cache.set(id, true);
              }
            }
            saveArchive(app, kind, id, rows);
            if (cache.get(id)) {
              const p = path.join(app.dataDir, 'stage', subOf(kind), `${id}.json`);
              fs.writeFileSync(p, JSON.stringify(data));
            }
          }
          log('ok', '补厂牌完成');
        } catch (e) {
          job.fail++;
          log('err', `补厂牌失败：${e.message || e}`);
        }
      } else {
        log('info', '厂牌取自本地缓存，要联网补请单独点「补厂牌」');
      }
      job.phase = 'tidy-doc';
      const t0 = Date.now();
      try {
        const r = tidy(app, kind);
        job.songs = r.songs;
        log('ok', `整理完成：${r.items} 项 · ${r.files} 个文件 · ${r.songs} 首（去重 ${r.unique}）· 用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      } catch (e) {
        job.fail++;
        log('err', `整理失败：${e.message || e}`);
      }
    }

    if (doCheck && !job.stop) {
      job.phase = 'check';
      log('step', '核验文档');
      try {
        const r = check(app, kind);
        const bad = r.badCount || 0;
        log(bad ? 'err' : 'ok', `核验：通过 ${r.okCount} 项 · 问题 ${bad} 项`);
        if (bad) job.fail++;
      } catch (e) {
        job.fail++;
        log('err', `核验失败：${e.message || e}`);
      }
    }

    job.phase = 'done';
    job.running = false;
    log('done', `完成：成功 ${job.ok} · 失败 ${job.fail} · ${job.songs} 首`);
  }

  function readStageSafe(kind) {
    const dir = path.join(app.dataDir, 'stage', subOf(kind));
    const out = [];
    let names = [];
    try { names = fs.readdirSync(dir); } catch { return out; }
    for (const f of names) {
      if (!f.endsWith('.json')) continue;
      try { out.push({ id: Number(f.replace('.json', '')), data: JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) }); } catch {}
    }
    return out;
  }

  const cmds = {
    app_version: async () => app.version,
    account: async () => api.account(),
    logout: async () => { api.clearCookie(); return { ok: true }; },
    login_cookie: async ({ cookie }) => {
      api.setCookie(cookie);
      const a = await api.account();
      if (!a.logged) throw new Error('Cookie 无效或已过期');
      return { ok: true, uid: a.uid, nickname: a.nickname };
    },
    qr_new: async () => { throw new Error('桌面版暂不支持扫码，请用 Cookie 登录'); },
    qr_poll: async () => ({ code: 0, message: '桌面版暂不支持扫码' }),
    sms_sent: async () => { throw new Error('桌面版暂不支持短信登录'); },
    login_phone_password: async () => { throw new Error('桌面版暂不支持手机登录'); },
    login_phone_captcha: async () => { throw new Error('桌面版暂不支持短信登录'); },
    login_email: async () => { throw new Error('桌面版暂不支持邮箱登录'); },

    playlists: async ({ uid }) => {
      let u = uid;
      if (!u) { const a = await api.account(); u = a.uid; }
      if (!u) throw new Error('未登录');
      const items = await api.playlists(u);
      return { total: items.length, items };
    },
    playlist_detail: async ({ id }) => api.playlistDetail(id, false),
    album_detail: async ({ id }) => api.albumDetail(id),
    collected_albums: async () => ({ items: await api.collectedAlbums() }),

    list_extras: async ({ kind, id }) => ({ items: loadExtras(kind, id) }),
    add_extra: async ({ kind, id, name, ar, al, company }) => {
      const n = String(name || '').trim();
      if (!n) throw new Error('歌名不能为空');
      const items = loadExtras(kind, id);
      items.push({ id: 0, name: n, ar: (ar || '').trim(), al: (al || '').trim(), company: (company || '').trim(), alId: 0, dur: 0, ncr: false, fee: 0, pop: 0, alia: '', mv: 0, manual: true });
      saveExtras(kind, id, items);
      return { ok: true, items };
    },
    remove_extra: async ({ kind, id, index }) => {
      const items = loadExtras(kind, id);
      if (index < 0 || index >= items.length) throw new Error('没有这一条');
      items.splice(index, 1);
      saveExtras(kind, id, items);
      return { ok: true, items };
    },

    get_export_dir: async () => ({
      dir: app.exportDir,
      writable: !writable(app.exportDir),
      default: app.defaultExportDir,
    }),
    set_export_dir: async ({ dir }) => {
      const d = String(dir || '').trim().replace(/\/+$/, '');
      if (!d) throw new Error('目录不能为空');
      const err = writable(d);
      if (err) return { ok: false, dir: d, writable: false, message: err };
      app.exportDir = d;
      const s = readSettings(); s.exportDir = d; writeSettings(s);
      return { ok: true, dir: d, writable: true };
    },
    check_export_dir: async ({ dir }) => {
      const err = writable(String(dir || '').trim());
      return err ? { ok: false, writable: false, message: err } : { ok: true, writable: true };
    },
    pick_export_dir: async () => {
      if (!dialog) throw new Error('当前环境不支持选择目录');
      const r = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] });
      if (r.canceled || !r.filePaths.length) return { ok: false };
      app.exportDir = r.filePaths[0];
      const s = readSettings(); s.exportDir = app.exportDir; writeSettings(s);
      return { ok: true, dir: app.exportDir, writable: !writable(app.exportDir) };
    },
    take_picked_dir: async () => ({ ok: false, message: '桌面版请用「从系统选文件夹」' }),
    open_storage_settings: async () => { throw new Error('桌面版不需要该权限'); },

    stage_ids: async ({ kind }) => ({ ids: stageIds(app, kind) }),
    stage_stats: async ({ kind }) => stageStats(app, kind),
    fill_companies: async ({ kind, limit }) => {
      const files = readStageSafe(kind);
      let updated = 0, found = 0;
      for (const { id, data } of files) {
        const need = (data.rows || []).filter(r => !r.company && r.alId);
        if (!need.length) continue;
        const cmp = await api.fillCompanies(need);
        found += cmp.size;
        for (const r of data.rows) if (r.alId && cmp.has(r.alId) && !r.company) r.company = cmp.get(r.alId);
        saveArchive(app, kind, id, data.rows);
        fs.writeFileSync(path.join(app.dataDir, 'stage', subOf(kind), `${id}.json`), JSON.stringify(data));
        updated++;
        if (limit && updated >= limit) break;
      }
      return { ok: true, found, updated, remaining: 0 };
    },
    tidy: async ({ kind }) => tidy(app, kind),
    check_exports: async ({ kind }) => check(app, kind),

    special_items: async () => specialItems(app),
    export_special: async () => {
      const { items } = specialItems(app);
      if (!items.length) throw new Error('还没有专项数据，先同步歌单');
      const q = v => '"' + String(v ?? '').replace(/"/g, '""') + '"';
      const head = '序号,歌名,制作人/团体,专辑,发行公司/厂牌,分类,歌曲ID\n';
      const rows = items.map((it, i) => [i + 1, q(it.name), q(it.ar), q(it.al), q(it.company), (it.kinds || []).join(' / '), it.id].join(','));
      const paths = writeBoth('专项清单.csv', '\uFEFF' + head + rows.join('\n') + '\n');
      return { ok: true, paths };
    },

    save_text: async ({ name, content }) => {
      const file = String(name || '未命名').split('/').map(sanitize).join('/');
      const paths = writeBoth(file, content);
      if (!paths.length) throw new Error('写入文件失败');
      return { ok: true, paths };
    },
    export_playlist: async ({ id, format }) => {
      const d = await api.playlistDetail(id, true);
      const name = sanitize(d.name);
      const content = format === 'md' ? toMd(d.rows, d.name) : toCsv(d.rows, d.name);
      const paths = writeBoth(`歌单/${name}.${format === 'md' ? 'md' : 'csv'}`, content);
      return { ok: true, paths, stats: d.stats };
    },
    export_album: async ({ id, format }) => {
      const d = await api.albumDetail(id);
      const name = sanitize(d.name);
      const content = format === 'md' ? toMd(d.rows, d.name) : toCsv(d.rows, d.name);
      const paths = writeBoth(`收藏专辑/${name}.${format === 'md' ? 'md' : 'csv'}`, content);
      return { ok: true, paths, stats: d.stats };
    },

    job_start: async ({ kind, ids, doTidy, doCheck, withFill }) => {
      if (job.running) throw new Error('已有任务在运行');
      runJob(kind, ids || [], !!doTidy, !!doCheck, !!withFill);
      return { ok: true, log: job.logPath };
    },
    job_status: async () => ({
      running: job.running,
      phase: job.phase,
      kind: job.kind,
      total: job.total,
      done: job.done,
      phaseTotal: job.phaseTotal,
      phaseDone: job.phaseDone,
      ok: job.ok,
      fail: job.fail,
      songs: job.songs,
      step: job.step,
      elapsed: job.started ? (Date.now() - job.started) / 1000 : 0,
      logs: job.logs.slice(-160),
    }),
    job_stop: async () => { job.stop = true; return { ok: true }; },

    copy_log: async () => {
      if (!job.logPath || !fs.existsSync(job.logPath)) throw new Error('还没有运行过任务');
      const stem = path.basename(job.logPath, '.log');
      const content = fs.readFileSync(job.logPath, 'utf8');
      const paths = writeBoth(`日志/${stem}.log`, content);
      return { ok: true, paths };
    },
    zip_exports: async () => {
      const src = path.join(app.dataDir, 'exports');
      if (!fs.existsSync(src)) throw new Error('还没有导出任何文件');
      const { execFileSync } = await import('node:child_process');
      const out = path.join(app.dataDir, 'exports', '网易云导出.zip');
      try { fs.unlinkSync(out); } catch {}
      // Windows 自带 tar，能直接打 zip
      execFileSync('tar', ['-a', '-c', '-f', out, '-C', src, '.'], { stdio: 'ignore' });
      let pub = '';
      if (!writable(app.exportDir)) {
        const p = path.join(app.exportDir, '网易云导出.zip');
        try { fs.copyFileSync(out, p); pub = p; } catch {}
      }
      return { ok: true, files: 0, size: fs.statSync(out).size, public: pub };
    },
  };

  return cmds;
}
