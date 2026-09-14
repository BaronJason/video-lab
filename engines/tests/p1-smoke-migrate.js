// P1 冒烟：用快照副本数据实测 cache-store 的 JSON→sqlite 迁移（临时库，绝不触碰生产缓存）
'use strict';

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const CacheStore = require('../base/cache-store');

const p0Dir = path.resolve('E:\\3-批量成片\\.trae\\p0-baseline\\cache-snapshot-20260914');

async function main() {
  const dbFile = path.join(os.tmpdir(), 'vl-p1-migrate-' + Date.now() + '.db');
  const store = new CacheStore(dbFile, { root: '膝盖赤峰' });
  store.open();
  const counters = store.migrateFromJson({
    videoCacheJson: path.join(p0Dir, 'video_cache.json'),
    usageCacheJson: path.join(p0Dir, 'usage_cache.json'),
    scanCacheJson: path.join(p0Dir, 'scan_cache.json'),
    logCacheJson: path.join(p0Dir, 'log_cache.json'),
  });
  console.log('迁移计数:', JSON.stringify(counters));

  // 校验 video_cache 表数据确实落地
  const db = store._db;
  const vidCount = db.prepare('SELECT COUNT(*) c FROM video_cache').get().c;
  const usageSum = db.prepare('SELECT COUNT(*) c FROM video_cache WHERE usage_count > 0').get().c;
  const scanCount = db.prepare('SELECT COUNT(*) c FROM scan_cache').get().c;
  const logCount = db.prepare('SELECT COUNT(*) c FROM log_cache').get().c;
  console.log('落库校验 video=%d usage>0=%d scan=%d log=%d', vidCount, usageSum, scanCount, logCount);
  // 中文路径连通性
  const sample = db.prepare('SELECT path FROM video_cache LIMIT 3').all().map(r => r.path);
  console.log('中文路径样例:', JSON.stringify(sample));
  store.close();
  try { fs.unlinkSync(dbFile); } catch (e) {}
  console.log('P1 冒烟通过');
}

main().catch((e) => { console.error('P1 冒烟失败', e); process.exit(1); });