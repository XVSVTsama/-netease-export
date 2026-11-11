/**
 * 发布：本地数据 → 重建文档 → 写临时目录 → 打包 → 核验 → 原子发布
 * 纯 Node 实现，不依赖 sh / python / zip 命令，Windows、macOS、Linux、Termux 通用。
 * 失败时保留上一版，不会清空目标目录。
 *
 * 环境变量：NC_ROOT（数据根，默认当前目录）、NC_DEST（发布目录，默认 NC_ROOT/导出）
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const CODE = path.dirname(fileURLToPath(import.meta.url));
const NC_ROOT = path.resolve(process.env.NC_ROOT || process.cwd());
const NC_DEST = path.resolve(process.env.NC_DEST || path.join(NC_ROOT, '导出'));
const NODE = process.execPath;
const ENV = { ...process.env, ELECTRON_RUN_AS_NODE: '1', NC_ROOT, NC_DEST };
const PUBLISH = [
  '00_自建歌单索引.md', '01_数据处理说明.md', '02_歌单可见性清单.md', '03_整理报告.md',
  '歌单', '专项', '收藏', '排行与收藏', '表格',
];
const MIN_FILES = 200;

const log = (...a) => console.log(...a);
const step = s => log(`== ${s}`);

function run(script, args = [], extra = {}) {
  const r = spawnSync(NODE, [path.join(CODE, script), ...args], { cwd: NC_ROOT, env: { ...ENV, ...extra }, stdio: 'inherit' });
  if (r.error) {
    log(`!! 无法启动 ${script}：${r.error.message}`);
    process.exit(1);
  }
  if (r.status !== 0) {
    log(`!! ${script} 退出码 ${r.status}`);
    process.exit(r.status || 1);
  }
}

/* ---------- 最小 ZIP 写入器（deflate + CRC32，UTF-8 文件名） ---------- */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
const crc32 = buf => {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};
const dosStamp = (d = new Date()) => ({
  time: ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xffff,
  date: (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xffff,
});

function zipDir(srcRoot, outFile, rootName) {
  const files = [];
  const walk = dir => {
    for (const name of fs.readdirSync(dir).sort()) {
      const p = path.join(dir, name);
      if (fs.statSync(p).isDirectory()) walk(p);
      else files.push(p);
    }
  };
  walk(srcRoot);

  const { time, date } = dosStamp();
  const parts = [];
  const central = [];
  let offset = 0;
  for (const p of files) {
    const data = fs.readFileSync(p);
    const comp = zlib.deflateRawSync(data, { level: 9 });
    const name = Buffer.from(path.posix.join(rootName, path.relative(srcRoot, p).split(path.sep).join('/')), 'utf8');
    const crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0x0800, 6);
    lh.writeUInt16LE(8, 8);
    lh.writeUInt16LE(time, 10);
    lh.writeUInt16LE(date, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(comp.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    lh.writeUInt16LE(0, 28);
    parts.push(lh, name, comp);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(8, 10);
    ch.writeUInt16LE(time, 12);
    ch.writeUInt16LE(date, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(comp.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(offset, 42);
    central.push(ch, name);
    offset += lh.length + name.length + comp.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  const buf = Buffer.concat([...parts, cd, eocd]);
  fs.writeFileSync(outFile, buf);
  return { count: files.length, size: buf.length };
}

const countFiles = dir =>
  fs.readdirSync(dir, { withFileTypes: true })
    .reduce((n, e) => n + (e.isDirectory() ? countFiles(path.join(dir, e.name)) : 1), 0);

/* ---------- 主流程 ---------- */
log(`NC_ROOT=${NC_ROOT}`);
log(`NC_DEST=${NC_DEST}`);

step('1/4 生成文档（仅本地数据，不联网）');
run('merge.mjs');

step('2/4 写入临时目录');
const TMP = `${NC_DEST}.new`;
const ZIP = `${NC_DEST}.zip`;
const ZIP_TMP = `${TMP}.zip`;
fs.rmSync(TMP, { recursive: true, force: true });
fs.rmSync(ZIP_TMP, { force: true });
fs.mkdirSync(TMP, { recursive: true });
for (const name of PUBLISH) {
  const src = path.join(NC_ROOT, 'out2', name);
  if (!fs.existsSync(src)) { log(`   缺少 out2/${name}`); continue; }
  fs.cpSync(src, path.join(TMP, name), { recursive: true });
}

step('3/4 打包');
const z = zipDir(TMP, ZIP_TMP, path.basename(NC_DEST));
log(`   zip 条目 ${z.count}｜${(z.size / 1048576).toFixed(2)} MB`);

step('4/4 核验并发布');
run('check.mjs', [], { NC_ZIP: ZIP_TMP });

const expect = countFiles(TMP);
if (expect < MIN_FILES) {
  log(`!! 文件数异常（${expect}，至少 ${MIN_FILES}），放弃发布，临时目录留在 ${TMP}`);
  process.exit(1);
}

const BAK = `${NC_DEST}.bak`;
fs.rmSync(BAK, { recursive: true, force: true });
if (fs.existsSync(NC_DEST)) fs.renameSync(NC_DEST, BAK);
fs.renameSync(TMP, NC_DEST);
fs.rmSync(ZIP, { force: true });
fs.renameSync(ZIP_TMP, ZIP);
fs.rmSync(BAK, { recursive: true, force: true });

log(`BUILD_OK｜${expect} 个文件已发布到 ${NC_DEST}`);
log(`BUILD_ZIP｜${ZIP}｜${(fs.statSync(ZIP).size / 1048576).toFixed(2)} MB`);
