import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const MODES = {
  check: { name: '核验', steps: [['核验并提交', 'if [ -d out2/staging ]; then node check.mjs && node stage.mjs commit && sh build.sh; else node check.mjs; fi']] },
  tidy: { name: '整理', steps: [['整理文档', 'if [ -d out2/staging ]; then node merge.mjs && echo "已生成到暂存区，等待核验提交"; else sh build.sh; fi']] },
  sync: { name: '同步到暂存区', steps: [
    ['① 初始化暂存区', 'node stage.mjs init'],
    ['② 同步云端数据', 'node sync.mjs', { NC_STAGE: '1' }],
    ['③ 刷新歌单封面', 'node covers.mjs', { NC_STAGE: '1' }],
    ['④ 刷新版权状态', 'node enrich.mjs', { NC_STAGE: '1' }],
    ['⑤ 更新听歌排行', 'node export3.mjs rank', { NC_STAGE: '1' }],
  ] },
  cplSync: { name: '收藏歌单同步', steps: [['① 抓取收藏歌单', 'node cpl.mjs sync'], ['② 整理索引', 'node cpl.mjs tidy']] },
  cplCheck: { name: '收藏歌单核验', steps: [['核验收藏歌单', 'node cpl.mjs check']] },
  calSync: { name: '创建专辑同步', steps: [['① 抓取创建专辑', 'node cal.mjs sync'], ['② 整理文档', 'node cal.mjs tidy']] },
  calTidy: { name: '创建专辑整理', steps: [['整理创建专辑', 'node cal.mjs tidy']] },
  cplTidy: { name: '收藏歌单整理', steps: [['整理收藏歌单', 'node cpl.mjs tidy']] },
  calCheck: { name: '创建专辑核验', steps: [['核验创建专辑', 'node cal.mjs check']] },
  favSync: { name: '收藏同步', steps: [['① 抓取收藏专辑', 'node fav.mjs sync'], ['② 整理文档', 'node fav.mjs tidy']] },
  favTidy: { name: '收藏整理', steps: [['整理收藏文档', 'node fav.mjs tidy']] },
  favCheck: { name: '收藏核验', steps: [['核验收藏数据', 'node fav.mjs check']] },
  full: { name: '同步 + 整理 + 核验', steps: [
    ['① 初始化暂存区', 'node stage.mjs init'],
    ['② 同步云端数据', 'node sync.mjs', { NC_STAGE: '1' }],
    ['③ 刷新歌单封面', 'node covers.mjs', { NC_STAGE: '1' }],
    ['④ 刷新版权状态', 'node enrich.mjs', { NC_STAGE: '1' }],
    ['⑤ 更新听歌排行', 'node export3.mjs rank', { NC_STAGE: '1' }],
    ['⑥ 整理（暂存区）', 'node merge.mjs'],
    ['⑦ 核验并提交', 'node check.mjs'],
    ['⑧ 提交暂存区', 'node stage.mjs commit'],
    ['⑨ 发布与最终核验', 'sh build.sh'],
  ] },
};

const mode = process.argv[2];
const accId = process.argv[3] || 'default';
let acc = { id: 'default', nick: '', root: process.cwd(), dest: path.join(process.cwd(), '导出') };
try {
  const reg = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'accounts.json'), 'utf8'));
  const found = (reg.accounts || []).find(a => a.id === accId) || (reg.accounts || [])[0];
  if (found) acc = found;
} catch {}
const conf = MODES[mode];
if (!conf) {
  console.error('用法: node runner.mjs check|tidy|sync|full');
  process.exit(64);
}

const stamp = () => new Date().toLocaleTimeString('zh-CN', { hour12: false });
const emit = s => process.stdout.write(s + '\n');

function runStep(label, cmd, extraEnv) {
  return new Promise(resolve => {
    const t0 = Date.now();
    emit(`::STEP::${label}｜命令：${cmd}`);
    const p = spawn('/bin/sh', ['-c', cmd], { cwd: acc.root, env: { ...process.env, NC_ROOT: acc.root, NC_DEST: acc.dest, NC_ACC: acc.id, ...(extraEnv || {}) } });
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
emit(`::INFO::开始时间 ${stamp()}｜共 ${conf.steps.length} 步`);
const done = [];
let failed = null;
for (const [label, cmd, extraEnv] of conf.steps) {
  if (failed) { emit(`::SKIP::${label}（前一步失败，已跳过）`); continue; }
  const r = await runStep(label, cmd, extraEnv);
  done.push({ label, ...r });
  if (!r.ok) failed = { label, ...r };
}
emit(`::INFO::结束时间 ${stamp()}`);
if (failed) {
  emit(`::SUMMARY::失败于「${failed.label}」，退出码 ${failed.code}`);
  process.exit(1);
} else {
  emit(`::SUMMARY::全部完成（${done.length} 步），总耗时 ${(done.reduce((n, x) => n + x.ms, 0) / 1000).toFixed(1)} 秒`);
  process.exit(0);
}
