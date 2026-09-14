// sqlite 缓存单库：video_cache（含 usage_count）/ clip_index / scan_cache / log_cache
// 目标 2 核心：Electron 内置 node:sqlite，零原生依赖；支持旧 JSON 一次性迁移（临时文件+rename 风格不适用，走 node:sqlite 事务）。
// 本模块为独立实现，不接入生产；由 tests/ 或在 P1 冒烟中与快照副本数据验证，不动真实缓存。
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS video_cache (
  path         TEXT PRIMARY KEY,
  last_write   INTEGER NOT NULL,
  duration     REAL NOT NULL DEFAULT 0,
  width        INTEGER NOT NULL DEFAULT 0,
  height       INTEGER NOT NULL DEFAULT 0,
  valid        INTEGER NOT NULL DEFAULT 0,
  usage_count  INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS clip_index (
  dir     TEXT PRIMARY KEY,
  mtime   INTEGER NOT NULL,
  entries TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS scan_cache (
  key         TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL,
  payload     TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS log_cache (
  log_path TEXT PRIMARY KEY,
  mtime    INTEGER NOT NULL,
  entries  TEXT NOT NULL
);
`;

class CacheStore {
  // dbPath: Cache 目录下的库文件（如 video.db）；root: 当前工作根（root 前缀隔离）
  constructor(dbPath, { root = '' } = {}) {
    this.dbPath = dbPath;
    this.root = String(root || '').replace(/[\\/]+$/, '');
    this._db = null;
    this._inTx = false;
  }

  open() {
    if (this._db && !this._db.closed) return this._db;
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    this._db = new DatabaseSync(this.dbPath);
    // WAL：读写并发友好；批量写务必显式事务（node:sqlite 默认每语句自动提交 → fsync 放大，实测 1000 条无事务 ~160s，事务内 ~27ms）
    try { this._db.exec('PRAGMA journal_mode=WAL'); } catch (e) {}
    this._db.exec(SCHEMA);
    return this._db;
  }

  // 显式事务助手：fn 内所有写操作包在同一事务，成功 COMMIT / 异常 ROLLBACK
  transaction(fn) {
    const db = this.open();
    if (this._inTx) return fn();
    db.exec('BEGIN');
    this._inTx = true;
    try {
      const r = fn();
      db.exec('COMMIT');
      return r;
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch (e2) {}
      throw e;
    } finally {
      this._inTx = false;
    }
  }

  close() {
    if (this._db && !this._db.closed) { try { this._db.close(); } catch (e) {} }
    this._db = null;
  }

  // ── video_cache（含 usage_count）──
  getVideo(vPath) {
    const db = this.open();
    const row = db.prepare('SELECT * FROM video_cache WHERE path = ?').get(String(vPath));
    return row || null;
  }

  upsertVideo(vPath, { lastWrite, duration, width, height, valid, usageCount } = {}) {
    const db = this.open();
    db.prepare(`INSERT INTO video_cache (path, last_write, duration, width, height, valid, usage_count)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(path) DO UPDATE SET
                  last_write = excluded.last_write,
                  duration = excluded.duration,
                  width = excluded.width,
                  height = excluded.height,
                  valid = excluded.valid,
                  usage_count = excluded.usage_count`).run(
      String(vPath),
      lastWrite || 0, duration || 0, width || 0, height || 0, valid ? 1 : 0, usageCount || 0
    );
  }

  bumpVideoUsage(vPath, inc = 1) {
    const db = this.open();
    db.prepare('UPDATE video_cache SET usage_count = usage_count + ? WHERE path = ?').run(inc, String(vPath));
  }

  // 失效清理：删除「文件已不存在 + 非当前 root 残留」；返回删除数。仅确有删除才写（DELETE 天然满足）
  gcVideos() {
    const db = this.open();
    const rows = db.prepare('SELECT path FROM video_cache').all();
    let removed = 0;
    const tx = db.prepare('DELETE FROM video_cache WHERE path = ?');
    for (const r of rows) {
      const p = String(r.path);
      let drop = false;
      if (this.root && !p.startsWith(this.root)) drop = true; // 旧工作目录残留
      else { try { if (!fs.existsSync(p)) drop = true; } catch (e) { drop = true; } }
      if (drop) { tx.run(p); removed++; }
    }
    return removed;
  }

  // ── scan_cache ──
  getScan(key) { return this.open().prepare('SELECT * FROM scan_cache WHERE key = ?').get(String(key)) || null; }
  setScan(key, fingerprint, payload = '') {
    const db = this.open();
    db.prepare(`INSERT INTO scan_cache (key, fingerprint, payload) VALUES (?, ?, ?)
                ON CONFLICT(key) DO UPDATE SET fingerprint = excluded.fingerprint, payload = excluded.payload`)
      .run(String(key), String(fingerprint), String(payload));
  }

  // ── log_cache ──
  getLog(lp) { return this.open().prepare('SELECT * FROM log_cache WHERE log_path = ?').get(String(lp)) || null; }
  setLog(lp, mtime, entries) {
    const db = this.open();
    db.prepare(`INSERT INTO log_cache (log_path, mtime, entries) VALUES (?, ?, ?)
                ON CONFLICT(log_path) DO UPDATE SET mtime = excluded.mtime, entries = excluded.entries`)
      .run(String(lp), mtime || 0, JSON.stringify(entries));
  }

  // ── clip_index ──
  getClip(dir) { return this.open().prepare('SELECT * FROM clip_index WHERE dir = ?').get(String(dir)) || null; }
  setClip(dir, mtime, entries) {
    const db = this.open();
    db.prepare(`INSERT INTO clip_index (dir, mtime, entries) VALUES (?, ?, ?)
                ON CONFLICT(dir) DO UPDATE SET mtime = excluded.mtime, entries = excluded.entries`)
      .run(String(dir), mtime || 0, JSON.stringify(entries));
  }

  // ── 旧 JSON 一次性迁移（native）：copy 数据到测试库；旧文件处理遵循删除红线（回收站），由调用方决定
  async migrateFromJson({ videoCacheJson, usageCacheJson, scanCacheJson, logCacheJson } = {}) {
    const db = this.open();
    const counters = { video: 0, usage: 0, scan: 0, log: 0 };
    this.transaction(() => {
      const videoStep = db.prepare('INSERT OR REPLACE INTO video_cache (path, last_write, duration, width, height, valid, usage_count) VALUES (?, ?, ?, ?, ?, ?, ?)');
      const scanStep = db.prepare('INSERT OR REPLACE INTO scan_cache (key, fingerprint, payload) VALUES (?, ?, ?)');
      const logStep = db.prepare('INSERT OR REPLACE INTO log_cache (log_path, mtime, entries) VALUES (?, ?, ?)');
      const upd = db.prepare('UPDATE video_cache SET usage_count = ? WHERE path = ?');
      const addRow = db.prepare('INSERT OR IGNORE INTO video_cache (path, last_write, duration, width, height, valid, usage_count) VALUES (?, ?, 0, 0, 0, 0, ?)');

    // video_cache.json → video_cache 表
    if (videoCacheJson && fs.existsSync(videoCacheJson)) {
      const data = JSON.parse(fs.readFileSync(videoCacheJson, 'utf8'));
      if (data && typeof data === 'object') {
        for (const [p, info] of Object.entries(data)) {
          if (!info || !p) continue;
          videoStep.run(p,
            Number(info.LastWriteTime || info.last_write || 0),
            Number(info.Duration || info.duration || 0),
            Number(info.Width || info.width || 0),
            Number(info.Height || info.height || 0),
            (info.Valid || info.valid) ? 1 : 0,
            0);
          counters.video++;
        }
      }
    }
    // usage_cache.json → usage_count 并入（按路径合并）
    if (usageCacheJson && fs.existsSync(usageCacheJson)) {
      const usage = JSON.parse(fs.readFileSync(usageCacheJson, 'utf8'));
      if (usage && typeof usage === 'object') {
        for (const [p, u] of Object.entries(usage)) {
          if (!u || !p) continue;
          const cnt = Number(u.UsageCount || u.usage_count || 0);
          if (cnt > 0) {
            const r = upd.run(cnt, p);
            if (r.changes === 0) addRow.run(p, 0, cnt);
          }
          counters.usage++;
        }
      }
    }
    // scan_cache.json → scan_cache 表（实际结构：{ entries: { "<root>\u0000<file>": {mtimeMs,size,hash} } }）
    if (scanCacheJson && fs.existsSync(scanCacheJson)) {
      const sc = JSON.parse(fs.readFileSync(scanCacheJson, 'utf8'));
      const entries = (sc && sc.entries) || {};
      if (entries && typeof entries === 'object' && !Array.isArray(entries)) {
        for (const [key, info] of Object.entries(entries)) {
          if (!key || !info) continue;
          scanStep.run(String(key), JSON.stringify(info && (info.hash || info.mtimeMs || info)), '');
          counters.scan++;
        }
      } else if (Array.isArray(entries)) {
        for (const e of entries) {
          if (!e) continue;
          const key = e.key || e.path || e.dir || '';
          if (!key) continue;
          scanStep.run(String(key), JSON.stringify(e.hash || e.mtimeMs || e.mtime || e), JSON.stringify(e.payload || e.entries || ''));
          counters.scan++;
        }
      }
    }
    // log_cache.json → log_cache 表（实际结构：{ root, files: [{project,name,path,date,config}] }）
    if (logCacheJson && fs.existsSync(logCacheJson)) {
      const lc = JSON.parse(fs.readFileSync(logCacheJson, 'utf8'));
      const files = (lc && lc.files) || [];
      if (Array.isArray(files)) {
        for (const e of files) {
          if (!e) continue;
          const lp = e.path || e.log_path || e.file || '';
          if (!lp) continue;
          logStep.run(String(lp), Number(e.mtime || 0), JSON.stringify(e));
          counters.log++;
        }
      }
    }
    });
    return counters;
  }
}

module.exports = CacheStore;