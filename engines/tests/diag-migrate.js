// 诊断：cache-store 迁移卡点定位（只测单文件、即时打印）
'use strict';
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const CacheStore = require('../base/cache-store');

const p0Dir = 'E:/3-批量成片/.trae/p0-baseline/cache-snapshot-20260914';
console.log('STEP0 start');

async function main() {
  const dbFile = path.join(os.tmpdir(), 'vl-diag-' + Date.now() + '.db');
  const store = new CacheStore(dbFile, { root: '' });
  console.log('STEP1 open db', dbFile);
  store.open();
  console.log('STEP2 schema ok');

  console.log('STEP3 video migrate...');
  const c1 = store.migrateFromJson({ videoCacheJson: path.join(p0Dir, 'video_cache.json') });
  console.log('STEP3 done', JSON.stringify(c1));

  console.log('STEP4 usage migrate...');
  const c2 = store.migrateFromJson({ usageCacheJson: path.join(p0Dir, 'usage_cache.json') });
  console.log('STEP4 done', JSON.stringify(c2));

  console.log('STEP5 scan migrate...');
  const c3 = store.migrateFromJson({ scanCacheJson: path.join(p0Dir, 'scan_cache.json') });
  console.log('STEP5 done', JSON.stringify(c3));

  console.log('STEP6 log migrate...');
  const c4 = store.migrateFromJson({ logCacheJson: path.join(p0Dir, 'log_cache.json') });
  console.log('STEP6 done', JSON.stringify(c4));

  const db = store._db;
  console.log('VERIFY video', db.prepare('SELECT COUNT(*) c FROM video_cache').get().c);
  console.log('VERIFY usage>0', db.prepare('SELECT COUNT(*) c FROM video_cache WHERE usage_count > 0').get().c);
  console.log('VERIFY scan', db.prepare('SELECT COUNT(*) c FROM scan_cache').get().c);
  console.log('VERIFY log', db.prepare('SELECT COUNT(*) c FROM log_cache').get().c);
  store.close();
  try { fs.unlinkSync(dbFile); } catch (e) {}
  console.log('ALL DONE');
}

main().catch((e) => { console.error('FAIL', e); process.exit(1); });