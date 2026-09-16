// sqlite 数据单库（<storageDir>\cache.db）：唯一持久层，承载
// video_cache / clip_index / scan_cache / log_cache / cache_kv / tasks / task_logs / task_marks / meta。
// 关键设计：`last_write` 用 TEXT 而非 INTEGER —— .NET Ticks（0001 基准）是 18~19 位整数，
// 超过 JS Number 安全整数范围（2^53）；node:sqlite 读 INTEGER 列会直接抛
// RangeError: Value is too large to be represented as a JavaScript number。
// TEXT 承载可无损往返（实测 639170274959892404 精确一致），且与 backend/脚本侧的字符串比较语义一致。
// 任务与标记的主键（task_id）同样用 TEXT：19 位 ID 经 Number 转换会变成科学计数法。
// 由 Electron 内置 node:sqlite 提供，零原生依赖；支持旧 JSON 一次性迁移。
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS video_cache (
  path         TEXT PRIMARY KEY,
  last_write   TEXT NOT NULL DEFAULT '',
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
CREATE TABLE IF NOT EXISTS cache_kv (
  k          TEXT PRIMARY KEY,
  v          TEXT NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS tasks (
  id         TEXT PRIMARY KEY,
  seq        INTEGER NOT NULL DEFAULT 0,
  type       TEXT NOT NULL DEFAULT '',
  status     TEXT NOT NULL DEFAULT '',
  title      TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0,
  payload    TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS task_logs (
  task_id TEXT NOT NULL,
  line_no INTEGER NOT NULL,
  line    TEXT NOT NULL,
  PRIMARY KEY (task_id, line_no)
);
CREATE TABLE IF NOT EXISTS task_marks (
  task_id    TEXT PRIMARY KEY,
  payload    TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS meta (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);
`;

const SCHEMA_VERSION = '3';

class CacheStore {
  // dbPath: Cache 目录下的库文件（如 cache.db）；root: 当前工作根（root 前缀隔离）
  constructor(dbPath, { root = '' } = {}) {
    this.dbPath = dbPath;
    this.root = String(root || '').replace(/[\\/]+$/, '');
    this._db = null;
    this._inTx = false;
  }

  // readOnly：只读用途（如 replica 仅消费缓存）不得建表 / 写 meta / 改 journal_mode ——
  // 否则一次「读缓存」就会改动调用方并不拥有的库（曾因此把运行中的 clip_cache.db 写脏）。
  open(opts) {
    const readOnly = !!(opts && opts.readOnly);
    if (this._db && !this._db.closed) return this._db;
    if (readOnly) {
      this._db = new DatabaseSync(this.dbPath, { readOnly: true });
      return this._db;
    }
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    this._db = new DatabaseSync(this.dbPath);
    // WAL：backend（主进程）与引擎（子进程）会同时读写同一个库，WAL + busy_timeout 是并发安全的前提；
    // 批量写务必显式事务（node:sqlite 默认每语句自动提交，fsync 放大会让写入慢几个数量级）
    try { this._db.exec('PRAGMA journal_mode=WAL'); } catch (e) {}
    try { this._db.exec('PRAGMA busy_timeout=5000'); } catch (e) {}
    try { this._db.exec('PRAGMA synchronous=NORMAL'); } catch (e) {}
    this._db.exec(SCHEMA);
    try {
      this._assertSchemaVersion();
    } catch (e) {
      this.close(); // 拒绝打开时不留连接，避免调用方拿到已开但不可用的库
      throw e;
    }
    return this._db;
  }

  // 版本守卫：库由更新版本创建时拒绝打开（绝不静默重置、绝不覆盖）。
  // E 盘与 D 盘实例共用同一份数据，只升级一侧时必须在此拦住——否则新表被旧版忽略、新数据被旧版覆盖。
  _assertSchemaVersion() {
    const row = this._db.prepare('SELECT v FROM meta WHERE k = ?').get('schema_version');
    const existing = row ? String(row.v) : '';
    // 仅在「库内已是更高版本」时拒绝；空库（首次创建）与同版本正常放行。
    // existing 非数字时 Number() 得 NaN，比较为 false → 放行，不因脏数据卡死启动。
    if (existing && Number(existing) > Number(SCHEMA_VERSION)) {
      const err = new Error('数据文件由更新版本的 Video Lab 创建（schema_version=' + existing +
        '，当前支持 ' + SCHEMA_VERSION + '），请升级到最新版本后重试');
      err.code = 'SCHEMA_TOO_NEW';
      err.schemaVersion = existing;
      throw err;
    }
    this.setMeta('schema_version', SCHEMA_VERSION);
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

  // ── meta ──
  getMeta(k) {
    const row = this.open().prepare('SELECT v FROM meta WHERE k = ?').get(String(k));
    return row ? String(row.v) : '';
  }
  setMeta(k, v) {
    this.open().prepare('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v')
      .run(String(k), String(v));
  }

  // ── video_cache ──
  getVideo(vPath) {
    const db = this.open();
    const row = db.prepare('SELECT * FROM video_cache WHERE path = ?').get(String(vPath));
    return row || null;
  }

  countVideos() {
    const row = this.open().prepare('SELECT COUNT(*) AS n FROM video_cache').get();
    return row ? Number(row.n) : 0;
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
      String(lastWrite == null ? '' : lastWrite),
      Number(duration) || 0, Number(width) || 0, Number(height) || 0, valid ? 1 : 0, Number(usageCount) || 0
    );
  }

  bumpVideoUsage(vPath, inc = 1) {
    const db = this.open();
    db.prepare('UPDATE video_cache SET usage_count = usage_count + ? WHERE path = ?').run(inc, String(vPath));
  }

  // 累加使用计数，行不存在时也能建立计数行。与 bumpVideoUsage 的差别是不要求素材已在缓存表中——
  // 引擎现场探测到的新素材可能尚未入库，用这条能保证计数不丢。
  // 用途：与 usage_cache.json 同步演进，为 legacy 退役后的「usage_cache 并库」提前铺路（届时只需丢掉 JSON）。
  addVideoUsage(vPath, inc = 1) {
    const db = this.open();
    db.prepare(`INSERT INTO video_cache (path, last_write, duration, width, height, valid, usage_count)
                VALUES (?, '', 0, 0, 0, 0, ?)
                ON CONFLICT(path) DO UPDATE SET usage_count = usage_count + excluded.usage_count`)
      .run(String(vPath), Number(inc) || 0);
  }

  // 全量读出为 backend 的缓存结构（与 video_cache.json 同形，键为视频路径）
  loadVideoMap() {
    const rows = this.open().prepare('SELECT path, last_write, duration, width, height, valid FROM video_cache').all();
    const map = {};
    for (const r of rows) {
      map[String(r.path)] = {
        LastWriteTime: String(r.last_write == null ? '' : r.last_write),
        Duration: Number(r.duration) || 0,
        Valid: !!r.valid,
        Width: Number(r.width) || 0,
        Height: Number(r.height) || 0,
      };
    }
    return map;
  }

  // 增量写回：upserts 为 { path: info } 或 Map；deletes 为路径数组。单事务提交。
  applyVideoDelta(upserts, deletes) {
    const up = [];
    if (upserts instanceof Map) { for (const [k, v] of upserts) up.push([k, v]); }
    else if (upserts && typeof upserts === 'object') { for (const k of Object.keys(upserts)) up.push([k, upserts[k]]); }
    const del = Array.isArray(deletes) ? deletes : (deletes ? Array.from(deletes) : []);
    if (!up.length && !del.length) return { upserted: 0, deleted: 0 };
    const db = this.open();
    let upserted = 0, deleted = 0;
    this.transaction(() => {
      const step = db.prepare(`INSERT INTO video_cache (path, last_write, duration, width, height, valid, usage_count)
                               VALUES (?, ?, ?, ?, ?, ?, 0)
                               ON CONFLICT(path) DO UPDATE SET
                                 last_write = excluded.last_write,
                                 duration = excluded.duration,
                                 width = excluded.width,
                                 height = excluded.height,
                                 valid = excluded.valid`);
      for (const [k, v] of up) {
        const info = v || {};
        step.run(String(k), String(info.LastWriteTime == null ? '' : info.LastWriteTime),
          Number(info.Duration) || 0, Number(info.Width) || 0, Number(info.Height) || 0, info.Valid ? 1 : 0);
        upserted++;
      }
      for (const chunk of chunked(del, 400)) {
        const ph = chunk.map(() => '?').join(',');
        const r = db.prepare(`DELETE FROM video_cache WHERE path IN (${ph})`).run(...chunk.map(String));
        deleted += Number(r.changes) || 0;
      }
    });
    return { upserted, deleted };
  }

  // 全量替换（重置预检测后一次性写入）：清空 + 批量插入，单事务
  replaceVideoMap(map) {
    const db = this.open();
    let n = 0;
    this.transaction(() => {
      db.exec('DELETE FROM video_cache');
      const step = db.prepare(`INSERT INTO video_cache (path, last_write, duration, width, height, valid, usage_count)
                               VALUES (?, ?, ?, ?, ?, ?, 0)`);
      for (const k of Object.keys(map || {})) {
        const info = map[k] || {};
        step.run(String(k), String(info.LastWriteTime == null ? '' : info.LastWriteTime),
          Number(info.Duration) || 0, Number(info.Width) || 0, Number(info.Height) || 0, info.Valid ? 1 : 0);
        n++;
      }
    });
    return n;
  }

  // 失效清理「判定分区」（纯内存，无磁盘调用）：
  //   verify —— 本轮未枚举到（knownPaths 未覆盖）的条目，由调用方核验文件是否仍存在；
  //   drop   —— 恒为空（保留该字段以兼容调用方）。
  // 把「数千次磁盘调用」压缩到「通常为零次」的关键就在 knownPaths。
  // ⚠ 刻意【不按工作目录(root)前缀删除】：素材位于工作目录之外是常态，
  //   曾因此把正常素材条目判为「旧 root 残留」整批清掉，导致重启后首次预检测全量重探（实测 7.7s）。
  gcPlan(knownPaths) {
    const rows = this.open().prepare('SELECT path FROM video_cache').all();
    const verify = [];
    for (const r of rows) {
      const p = String(r.path);
      if (knownPaths && knownPaths.has(p)) continue;
      verify.push(p);
    }
    return { drop: [], verify };
  }

  deleteVideos(paths) {
    const list = Array.isArray(paths) ? paths : (paths ? Array.from(paths) : []);
    if (!list.length) return 0;
    const db = this.open();
    let n = 0;
    this.transaction(() => {
      for (const chunk of chunked(list, 400)) {
        const ph = chunk.map(() => '?').join(',');
        const r = db.prepare(`DELETE FROM video_cache WHERE path IN (${ph})`).run(...chunk.map(String));
        n += Number(r.changes) || 0;
      }
    });
    return n;
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
      .run(String(lp), Number(mtime) || 0, JSON.stringify(entries));
  }

  // ── clip_index ──
  getClip(dir) { return this.open().prepare('SELECT * FROM clip_index WHERE dir = ?').get(String(dir)) || null; }
  setClip(dir, mtime, entries) {
    const db = this.open();
    db.prepare(`INSERT INTO clip_index (dir, mtime, entries) VALUES (?, ?, ?)
                ON CONFLICT(dir) DO UPDATE SET mtime = excluded.mtime, entries = excluded.entries`)
      .run(String(dir), Number(mtime) || 0, JSON.stringify(entries));
  }

  // ── 旧 JSON 一次性迁移（video_cache.json / usage_cache.json）──
  // 返回 { video, usage } 计数；由调用方负责读回校验与旧文件回收站处理。
  migrateFromJson({ videoCacheJson, usageCacheJson } = {}) {
    const db = this.open();
    const counters = { video: 0, usage: 0 };
    this.transaction(() => {
      const step = db.prepare(`INSERT INTO video_cache (path, last_write, duration, width, height, valid, usage_count)
                               VALUES (?, ?, ?, ?, ?, ?, ?)
                               ON CONFLICT(path) DO UPDATE SET
                                 last_write = excluded.last_write,
                                 duration = excluded.duration,
                                 width = excluded.width,
                                 height = excluded.height,
                                 valid = excluded.valid`);
      const usageStep = db.prepare('UPDATE video_cache SET usage_count = ? WHERE path = ?');
      const addRow = db.prepare(`INSERT OR IGNORE INTO video_cache (path, last_write, duration, width, height, valid, usage_count)
                                 VALUES (?, '', 0, 0, 0, 0, ?)`);
      if (videoCacheJson && fs.existsSync(videoCacheJson)) {
        const data = JSON.parse(fs.readFileSync(videoCacheJson, 'utf8'));
        if (data && typeof data === 'object' && !Array.isArray(data)) {
          for (const [p, info] of Object.entries(data)) {
            if (!info || !p) continue;
            // 原样以字符串承载 Ticks：这里刻意不 Number() 转换，避免 18~19 位整数丢精度
            step.run(String(p), String(info.LastWriteTime == null ? '' : info.LastWriteTime),
              Number(info.Duration) || 0, Number(info.Width) || 0, Number(info.Height) || 0, info.Valid ? 1 : 0, 0);
            counters.video++;
          }
        }
      }
      if (usageCacheJson && fs.existsSync(usageCacheJson)) {
        let usage = null;
        try { usage = JSON.parse(fs.readFileSync(usageCacheJson, 'utf8')); } catch (e) { usage = null; }
        if (usage && typeof usage === 'object' && !Array.isArray(usage)) {
          for (const [p, u] of Object.entries(usage)) {
            if (!u || !p) continue;
            const cnt = Number(u.UsageCount || u.usage_count || 0);
            if (cnt > 0) {
              const r = usageStep.run(cnt, String(p));
              if (Number(r.changes) === 0) addRow.run(String(p), cnt);
            }
            counters.usage++;
          }
        }
      }
    });
    return counters;
  }

  // 从库导出为 backend 的 JSON 结构（回退到 legacy 引擎时使用：legacy PS1 只认 JSON）
  exportVideoJson(targetPath, map) {
    const data = map || this.loadVideoMap();
    const out = {};
    for (const k of Object.keys(data)) {
      const v = data[k] || {};
      out[k] = {
        LastWriteTime: String(v.LastWriteTime == null ? '' : v.LastWriteTime),
        Duration: Number(v.Duration) || 0,
        Valid: !!v.Valid,
        Width: Number(v.Width) || 0,
        Height: Number(v.Height) || 0,
      };
    }
    const tmp = targetPath + '.' + process.pid + '.tmp';
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(out), 'utf-8');
    fs.renameSync(tmp, targetPath);
    return Object.keys(out).length;
  }
}

function chunked(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

module.exports = CacheStore;
module.exports.chunked = chunked;
