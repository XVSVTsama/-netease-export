/**
 * 任务执行器：node runner.mjs <mode> [账号 id]
 * 直接用当前 Node / Electron 运行时执行脚本，不经 sh，因此 Windows、macOS、Linux、Termux 行为一致。
 * 输出沿用 ::MODE:: / ::STEP:: / ::STEP_END:: / ::ERROR:: 标记，面板据此解析进度。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const CODE = path.dirname(fileURLToPath(import.meta.url));
const NODE = process.execPath;
const STAGE_DATA = 'out2/staging/playlists_full.json';

let acc = { id: 'default', nick: '', root: process.cwd(), dest: path.join(process.cwd(), '导出') };
const accId = process.argv[3] || 'default';
try {
  const reg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'accounts.json'), 'utf8'));
  const found = (reg.accounts || []).find(a => a.id === accId) || (reg.accounts || [])[0];
  if (found) acc = found;
} catch {}

const hasStage = () => fs.existsSync(path.join(acc.root, STAGE_DATA));

// [显示名, 脚本, 参数, 额外环境变量]
const SYNC_STEPS = [
  ['① 初始化暂存区', 'stage.mjs', ['init']],
  ['② 同步云端数据', 'sync.mjs', [], { NC_STAGE: '1' }],
  ['③ 刷新歌单封面', 'covers.mjs', [], { NC_STAGE: '1' }],
  ['④ 刷新版权状态', 'enrich.mjs', [], { NC_STAGE: '1' }],
  ['⑤ 更新听歌排行', 'export3.mjs', ['rank'], { NC_STAGE: '1' }],
];

const MODES = {
  check: {
    name: '核验',
    steps: () => hasStage()
      ? [['核验文档', 'check.mjs'], ['提交暂存区', 'stage.mjs', ['commit']], ['发布与打包', 'build.mjs']]
      : [['核验文档', 'check.mjs']],
  },
  tidy: {
    name: '整理',
    steps: () => hasStage()
      ? [['整理文档（暂存区）', 'merge.mjs']]
      : [['整理并发布', 'build.mjs']],
  },
  sync: { name: '同步到暂存区', steps: () => SYNC_STEPS },
  full: {
    name: '同步 + 整理 + 核验',
    steps: () => [
      ...SYNC_STEPS,
      ['⑥ 整理（暂存区）', 'merge.mjs'],
      ['⑦ 核验', 'check.mjs'],
      ['⑧ 提交暂存区', 'stage.mjs', ['commit']],
      ['⑨ 发布与打包', 'build.mjs'],
    ],
  },
  cplSync: { name: '收藏歌单同步', steps: () => [['① 抓取收藏歌单', 'cpl.mjs', ['sync']], ['② 整理索引', 'cpl.mjs', ['tidy']]] },
  cplTidy: { name: '收藏歌单整理', steps: () => [['整理索引', 'cpl.mjs', ['tidy']]] },
  cplCheck: { name: '收藏歌单核验', steps: () => [['核验收藏歌单', 'cpl.mjs', ['check']]] },
  calSync: { name: '创建专辑同步', steps: () => [['① 抓取创建专辑', 'cal.mjs', ['sync']], ['② 整理文档', 'cal.mjs', ['tidy']]] },
  calTidy: { name: '创建专辑整理', steps: () => [['整理文档', 'cal.mjs', ['tidy']]] },
  calCheck: { name: '创建专辑核验', steps: () => [['核验创建专辑', 'cal.mjs', ['check']]] },
  favSync: { name: '收藏同步', steps: () => [['① 抓取收藏专辑', 'fav.mjs', ['sync']], ['② 整理文档', 'fav.mjs', ['tidy']]] },
  favTidy: { name: '收藏整理', steps: () => [['整理文档', 'fav.mjs', ['tidy']]] },
  favCheck: { name: '收藏核验', steps: () => [['核验收藏数据', 'fav.mjs', ['check']]] },
};

const mode = process.argv[2];
const conf = MODES[mode];
if (!conf) {
  console.error(`用法: node runner.mjs ${Object.keys(MODES).join('|')} [账号 id]`);
  process.exit(64);
}

const stamp = () => new Date().toLocaleTimeString('zh-CN', { hour12: false });
const emit = s => process.stdout.write(s + '\n');

function runStep([label, script, args = [], extraEnv]) {
  return new Promise(resolve => {
    const t0 = Date.now();
    emit(`::STEP::${label}｜命令：node ${script}${args.length ? ' ' + args.join(' ') : ''}`);
    const p = spawn(NODE, [path.join(CODE, script), ...args], {
      cwd: acc.root,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        NC_ROOT: acc.root,
        NC_DEST: acc.dest,
        NC_ACC: acc.id,
        ...(extraEnv || {}),
      },
    });
    let errBuf = 0;
    p.stdout.on('data', d => process.stdout.write(d));
    p.stderr.on('data', d => { errBuf += d.length; process.stderr.write(d); });
    p.on('error', e => {
      emit(`::ERROR::${label}｜进程启动失败：${e.message}`);
      resolve({ ok: false, code: -1, ms: Date.now() - t0 });
    });
    p.on('close', code => {
      const ms = Date.now() - t0;
      const ok = code === 0;
      emit(`::STEP_END::${label}｜退出码 ${code}｜耗时 ${(ms / 1000).toFixed(1)} 秒${errBuf ? `｜stderr ${errBuf} 字节` : ''}`);
      if (!ok) { emit(`::ERROR_STEP::${label}`); emit(`::ERROR::${label} 失败，退出码 ${code}${errBuf ? '，详见上方 stderr' : ''}`); }
      resolve({ ok, code, ms });
    });
  });
}

emit(`::MODE::${conf.name}`);
emit(`::ACC::${acc.nick || acc.id}（${acc.id}）`);
const steps = conf.steps();
emit(`::INFO::开始时间 ${stamp()}｜共 ${steps.length} 步｜工作目录 ${acc.root}`);
const done = [];
let failed = null;
for (const s of steps) {
  if (failed) { emit(`::SKIP::${s[0]}（前一步失败，已跳过）`); continue; }
  const r = await runStep(s);
  done.push({ label: s[0], ...r });
  if (!r.ok) failed = { label: s[0], code: r.code };
}
emit(`::INFO::结束时间 ${stamp()}`);
const total = (done.reduce((n, d) => n + d.ms, 0) / 1000).toFixed(1);
if (failed) {
  emit(`::SUMMARY::失败于「${failed.label}」，退出码 ${failed.code}｜总耗时 ${total} 秒`);
  process.exit(1);
}
emit(`::SUMMARY::全部完成（${done.length} 步），总耗时 ${total} 秒`);
process.exit(0);
