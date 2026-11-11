import fs from 'node:fs';
import path from 'node:path';
import { post } from './export.mjs';

const IDS = path.join(process.cwd(), 'out2/album_ids.txt');
const CACHE = path.join(process.cwd(), 'out2/albums_cache.json');
const FAIL = path.join(process.cwd(), 'out2/albums_fail.txt');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const cache = fs.existsSync(CACHE) ? JSON.parse(fs.readFileSync(CACHE, 'utf8')) : {};
const all = fs.readFileSync(IDS, 'utf8').split('\n').map(s => s.trim()).filter(Boolean);
const todo = all.filter(id => !(id in cache));
log(`专辑总数 ${all.length}，已缓存 ${all.length - todo.length}，待抓 ${todo.length}`);

let ok = 0, bad = 0, done = 0;
const fails = [];

async function fetchOne(id) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const r = await post('/weapi/v1/album/' + id, {});
      if (r?.code === 200) {
        const a = r.album || {};
        cache[id] = { company: a.company || '', name: a.name || '', publishTime: a.publishTime || 0, artists: (a.artists || []).map(x => x.name).join(' / '), size: a.size || (a.songs || []).length };
        return true;
      }
      // 404/405/429 一般是被限流，长退避
      await sleep(1500 * (attempt + 1));
    } catch (e) {
      await sleep(1500 * (attempt + 1));
    }
  }
  fails.push(id);
  return false;
}

// 并发 3 + 全局节奏
const CONC = 3;
let idx = 0;
await Promise.all(Array.from({ length: CONC }, async () => {
  while (idx < todo.length) {
    const id = todo[idx++];
    const good = await fetchOne(id);
    good ? ok++ : bad++;
    done++;
    if (done % 200 === 0) {
      fs.writeFileSync(CACHE, JSON.stringify(cache));
      log(`进度 ${done}/${todo.length}（成功 ${ok} 失败 ${bad}）`);
    }
    await sleep(280);
  }
}));

fs.writeFileSync(CACHE, JSON.stringify(cache));
fs.writeFileSync(FAIL, fails.join('\n'));
log(`完成：成功 ${ok}，失败 ${bad}，缓存 ${Object.keys(cache).length} 张`);
if (fails.length) log('失败列表见 albums_fail.txt');
