// -*- coding: utf-8 -*-
// Video Lab — 后端逻辑（Node.js 移植，与 main.py 行为一致）
// 负责扫描项目/TXT、解析配置、预检测、调用 PowerShell 脚本。
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const VIDEO_EXTS = new Set(['.mp4', '.mov', '.avi', '.mkv', '.m4v']);

// 顶层目录中需要排除的非项目目录
const EXCLUDED_TOP_DIRS = new Set([
  'Video Lab', '_design_draft', '.design', '.git', '__pycache__',
]);

// 日志文件名特征（用于区分配置与日志）
const LOG_NAME_RE = /(拼接日志|复刻日志)/;
// 复刻模式名称，按 视频复刻.ps1 的 mode 映射；两种模式在侧栏各作一个配置名，仅含日志无配置
const REPLICA_MODES = ['原片复刻', '去重复刻'];
const REPLICA_PROJECT = '复刻'; // 侧栏中的虚拟项目名（仅含日志，无配置）
const REPLICA_MARK = 'REPLICA:'; // 复刻项目虚拟版本的 path 前缀，用于路由 list_logs / logContent

// 默认配置
const DEFAULT_CONFIG = {
  scripts_dir: '',
  watermark_dir: '',
  skin: 'white_blue',
};

function readText(filePath, fallback = 'utf-8') {
  let buf;
  try { buf = fs.readFileSync(filePath); } catch (e) { return ''; }
  const encodings = [fallback, 'utf-8', 'gbk', 'utf-16le'];
  for (const enc of encodings) {
    try {
      const s = new TextDecoder(enc, { fatal: true }).decode(buf);
      return s.replace(/^\uFEFF/, '');
    } catch (e) { continue; }
  }
  return '';
}

function contentHash(filePath) {
  try { return crypto.createHash('md5').update(fs.readFileSync(filePath)).digest('hex'); }
  catch (e) { return null; }
}

function stripQuotes(s) {
  // 去除路径/水印/排除字符串首尾成对的双引号或单引号
  s = String(s == null ? '' : s).trim();
  if (s.length >= 2) {
    const f = s[0], l = s[s.length - 1];
    if ((f === '"' && l === '"') || (f === "'" && l === "'")) s = s.slice(1, -1).trim();
  }
  return s;
}

function dateSortKey(label) {
  let m = /^(\d{2})(\d{2})$/.exec(label);
  if (m) return [0, parseInt(m[1], 10), parseInt(m[2], 10)];
  m = /^(\d+)\s*月$/.exec(label);
  if (m) return [1, parseInt(m[1], 10), 0];
  if (label === '模版' || label === '模板' || label.endsWith('模板')) return [2, 0, 0];
  return [3, 0, 0];
}

function compareDateSortKey(a, b) {
  const ka = dateSortKey(a), kb = dateSortKey(b);
  for (let i = 0; i < 3; i++) { if (ka[i] !== kb[i]) return ka[i] - kb[i]; }
  return 0;
}

function relativeDateLabel(relParts) {
  let label = null;
  for (const p of relParts) { if (/^\d{4}$/.test(p)) label = p; }
  if (label) return label;
  for (const p of relParts) { if (/^\d+\s*月$/.test(p)) return p; }
  for (let i = relParts.length - 1; i >= 0; i--) {
    const p = relParts[i].trim();
    if (p && p !== '月份') return p;
  }
  return '(根目录)';
}

function isChengpianFile(relParts) { return relParts.some((p) => p.endsWith('成片')); }

function walkFiles(dir) {
  const out = [];
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch (e) { continue; }
    for (const ent of entries) {
      const full = path.join(cur, ent.name);
      if (ent.isDirectory()) stack.push(full);
      else if (ent.isFile()) out.push(full);
    }
  }
  return out;
}

// 按内容 hash 去重（保留排序后的第一个），用于同类别（成片内/成片外）配置 txt 合并
function dedupeByHash(list) {
  const seen = new Set();
  const out = [];
  for (const it of list.slice().sort((a, b) => a.full.localeCompare(b.full))) {
    if (seen.has(it.hash)) continue;
    seen.add(it.hash);
    out.push(it);
  }
  return out;
}

// 按「成片文件夹」目录去重：每个成片文件夹取一份配置。目录名含时间，升序即旧→新
function dedupeByDir(list) {
  const seen = new Set();
  const out = [];
  for (const it of list.slice().sort((a, b) => a.full.localeCompare(b.full))) {
    const d = path.dirname(it.full);
    if (seen.has(d)) continue;
    seen.add(d);
    out.push(it);
  }
  return out;
}

class Api {
  constructor(root, config, cachePath, videoCachePath, logCachePath) {
    this.root = root;
    this.config = Object.assign({}, DEFAULT_CONFIG, config || {});
    this.cachePath = cachePath || '';
    this.videoCachePath = videoCachePath || '';
    this.logCachePath = logCachePath || '';
    // ffprobe 探测并发上限：保持低值，避免占用过多 CPU/IO 拖慢整机
    this.probeConcurrency = 4;
    this._videoCache = null;
    this._videoInfoCache = new Map();
    this._txtTree = null;
    this._txtTreeRoot = null;
    this._projectsCache = null;
    this._versionsCache = new Map();
    this._scanCache = new Map();
    this._scanLoadedRoot = '';
    this._scanDirty = false;
    this._logsEntryCache = null;
    // 日志 txt 缓存：刷新配置时一次性收集全部日志，供日期分支/对应关系直接使用
    this._logCache = null;
    this._logCacheRoot = '';
    // 任务管理：实时捕获 ps1 输出并推送，支持多任务与停止排队任务
    this.tasks = new Map();
    this.taskSeq = 0;
    this.onTasksChanged = null; // 由 main 进程注入，用于向渲染进程推送任务快照
  }

  get scriptsDir() {
    let d = this.config.scripts_dir;
    if (!d || !fs.existsSync(d)) d = DEFAULT_CONFIG.scripts_dir;
    return d;
  }

  get watermarkDir() {
    let d = this.config.watermark_dir;
    if (!d || !fs.existsSync(d)) d = DEFAULT_CONFIG.watermark_dir;
    return d;
  }

  getRoot() { return this.root; }

  setRoot(newRoot) {
    this.root = newRoot;
    this._videoCache = null;
    this._videoInfoCache.clear();
    this._invalidateCaches();
  }

  // 清理项目/TXT 相关内存缓存（保存配置、重建列表时调用；不清持久化指纹缓存）
  _invalidateCaches() {
    this._txtTree = null;
    this._txtTreeRoot = null;
    this._projectsCache = null;
    this._versionsCache.clear();
    this._logsEntryCache = null;
    this._logCache = null;
    this._logCacheRoot = '';
  }

  // ── 扫描指纹缓存：文件 (mtime,size) 未变则复用已算的 hash，变了才重读 ──
  _loadScanCache() {
    if (this._scanLoadedRoot === this.root || !this.cachePath) return;
    this._scanLoadedRoot = this.root;
    this._scanCache = new Map();
    try {
      const data = JSON.parse(fs.readFileSync(this.cachePath, 'utf-8'));
      if (data && typeof data.entries === 'object' && data.entries) {
        for (const k in data.entries) {
          const v = data.entries[k];
          if (v && typeof v.hash === 'string') this._scanCache.set(k, v);
        }
      }
    } catch (e) {}
  }

  _saveScanCache() {
    if (!this.cachePath) return;
    const entries = {};
    for (const [k, v] of this._scanCache) entries[k] = v;
    try { fs.writeFileSync(this.cachePath, JSON.stringify({ entries }), 'utf-8'); } catch (e) {}
  }

  // ── 日志 txt 缓存：与配置缓存分开独立文件，刷新配置时一并收集 ──
  _loadLogCache() {
    if (this._logCacheRoot === this.root || !this.logCachePath) return;
    this._logCacheRoot = this.root;
    this._logCache = { files: [] };
    try {
      const data = JSON.parse(fs.readFileSync(this.logCachePath, 'utf-8'));
      if (data && Array.isArray(data.files) && data.root === this.root) this._logCache.files = data.files;
    } catch (e) {}
  }

  _saveLogCache() {
    if (!this.logCachePath) return;
    try { fs.writeFileSync(this.logCachePath, JSON.stringify({ root: this.root, files: this._logCache.files }), 'utf-8'); } catch (e) {}
  }

  // 一次性收集根目录下所有非复刻日志 txt（刷新时写入日志缓存）
  // 返回 { files:[{ project, name, path, date, config }] }
  // 归属规则：date 取文件路径中「最近的 4 位 MMdd 目录」（日志绝不会存在于别的日期文件夹），
  //           project 取路径第一级目录（即左侧项目名）。配置与日志都按此规则归一后匹配。
  _collectLogFiles(force = false) {
    if (!force && this._logCache && this._logCacheRoot === this.root) return this._logCache;
    this._loadLogCache();
    const files = [];
    if (this.root && fs.existsSync(this.root)) {
      const skip = new Set(EXCLUDED_TOP_DIRS);
      for (const full of walkFiles(this.root)) {
        const base = path.basename(full);
        if (!base.toLowerCase().endsWith('.txt')) continue;
        if (!LOG_NAME_RE.test(base)) continue;
        const config = this._configNameFromLog(full);
        if (!config) continue; // 复刻/无归属日志单独处理
        const rel = path.relative(this.root, full).split(path.sep);
        if (skip.has(rel[0])) continue;
        files.push({ project: rel[0], name: base, path: full, date: this._dateBranchOf(full), config });
      }
    }
    this._logCache = { files };
    this._logCacheRoot = this.root;
    this._saveLogCache();
    return this._logCache;
  }

  // 文件所属日期分支：取相对根目录各路径段中「最近的 4 位 MMdd 目录」，否则返回空串
  _dateBranchOf(full) {
    const rel = path.relative(this.root, full).split(path.sep);
    let d = '';
    for (const seg of rel) if (/^\d{4}$/.test(seg)) d = seg;
    return d;
  }

  // 文件所属项目：取相对根目录的第一段目录名
  _projectOf(p) {
    try { return path.relative(this.root, path.resolve(String(p))).split(path.sep)[0]; }
    catch (e) { return ''; }
  }

  _scanKey(full) { return this.root + '\u0000' + full; }

  _hashFor(full, mtimeMs, size) {
    this._loadScanCache();
    const key = this._scanKey(full);
    const cached = this._scanCache.get(key);
    if (cached && cached.mtimeMs === mtimeMs && cached.size === size) return cached.hash;
    const h = contentHash(full);
    this._scanCache.set(key, { mtimeMs, size, hash: h });
    this._scanDirty = true;
    return h;
  }

  // 一次性收集根目录下所有项目的配置 TXT（每项目仅递归扫描一次）
  _collectAllTxt() {
    if (this._txtTree && this._txtTreeRoot === this.root) return this._txtTree;
    this._loadScanCache();
    const out = [];
    const active = new Set();
    if (fs.existsSync(this.root) && fs.statSync(this.root).isDirectory()) {
      let entries;
      try { entries = fs.readdirSync(this.root); } catch (e) { entries = []; }
      for (const name of entries) {
        if (name.startsWith('.') || name.startsWith('_')) continue;
        if (EXCLUDED_TOP_DIRS.has(name)) continue;
        const pdir = path.join(this.root, name);
        if (!fs.existsSync(pdir) || !fs.statSync(pdir).isDirectory()) continue;
        const files = walkFiles(pdir);
        for (const full of files) {
          if (!path.basename(full).toLowerCase().endsWith('.txt')) continue;
          if (LOG_NAME_RE.test(path.basename(full))) continue;
          let st;
          try { st = fs.statSync(full); } catch (e) { continue; }
          const mtimeMs = st.mtimeMs, size = st.size;
          const hash = this._hashFor(full, mtimeMs, size);
          active.add(this._scanKey(full));
          const rel = path.relative(pdir, path.dirname(full));
          const parts = rel === '' ? [] : rel.split(path.sep);
          out.push({ pdir, name: path.basename(full, path.extname(full)), full, parts, mtimeMs, size, hash });
        }
      }
    }
    this._txtTree = out;
    this._txtTreeRoot = this.root;
    if (this._scanDirty) {
      const prefix = this.root + '\u0000';
      for (const k of [...this._scanCache.keys()]) {
        if (k.startsWith(prefix) && !active.has(k)) { this._scanCache.delete(k); }
      }
      this._scanDirty = false;
      this._saveScanCache();
    }
    return out;
  }

  listProjects(force = false) {
    if (force) this._invalidateCaches();
    if (!force && this._projectsCache) return this._projectsCache;
    this._collectLogFiles(); // 刷新配置时一并收集日志 txt 缓存
    const data = this._buildProjectsData();
    this._projectsCache = data;
    return data;
  }

  _buildProjectsData() {
    const all = this._collectAllTxt();
    const byProject = new Map();
    for (const t of all) {
      if (!byProject.has(t.pdir)) byProject.set(t.pdir, []);
      byProject.get(t.pdir).push(t);
    }
    const dupNames = this._dupNames();
    const projects = [];
    for (const [pdir, txs] of byProject) {
      const names = [...new Set(txs.map((t) => t.name))].sort((a, b) => a.localeCompare(b, 'zh-CN'));
      const txts = [];
      for (const name of names) {
        const versions = this._buildVersionsFromList(name, txs);
        const latest = versions.length ? versions[0].label : '';
        txts.push({ name, latest, count: versions.length, dup: dupNames.has(name) });
      }
      let mtime = 0;
      try { mtime = fs.statSync(pdir).mtimeMs; } catch (e) {}
      projects.push({ name: path.basename(pdir), mtime, txts });
    }
    projects.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
    // 追加“复刻”虚拟项目：其下两个配置名对应两种复刻模式，仅含日志无配置
    projects.push(this._buildReplicaProject());
    return projects;
  }

  _buildReplicaProject() {
    const txts = REPLICA_MODES.map((mode) => {
      const files = this._replicaLogFiles(mode);
      const latest = files.length ? path.basename(files[files.length - 1]).slice(0, 4) : '';
      return { name: mode, latest, count: files.length, dup: false, replica: true };
    });
    return { name: REPLICA_PROJECT, mtime: 0, txts, replica: true };
  }

  _dupNames() {
    const counter = new Map();
    const seenByProject = new Map();
    for (const t of this._collectAllTxt()) {
      if (!seenByProject.has(t.pdir)) seenByProject.set(t.pdir, new Set());
      seenByProject.get(t.pdir).add(t.name);
    }
    for (const names of seenByProject.values()) {
      for (const n of names) counter.set(n, (counter.get(n) || 0) + 1);
    }
    return new Set([...counter.entries()].filter(([, c]) => c > 1).map(([n]) => n));
  }

  listVersions(project, name) {
    const pdir = path.join(this.root, project);
    if (!fs.existsSync(pdir) || !fs.statSync(pdir).isDirectory()) return [];
    const key = this.root + '\u0000' + project + '\u0000' + name;
    if (this._versionsCache.has(key)) return this._versionsCache.get(key);
    const versions = this._buildVersions(pdir, name);
    // 每版本是否有可跳日志：配对锚点是「成片文件夹」
    //   - 成片内配置：仅当同一成片文件夹内存在对应日志才可跳
    //   - 外部(label含*)配置：当日有任何日志即可跳（多成片跳 -1、单成片跳唯一）
    const logs = this._collectLogFiles().files;
    versions.forEach((v) => { v.hasLog = this._versionHasLog(v, project, name, logs); });
    this._versionsCache.set(key, versions);
    return versions;
  }

  _versionHasLog(v, project, name, logs) {
    const d = String(v.label || '').slice(0, 4);
    if (!/^\d{4}$/.test(d)) return false;
    const match = (f) => f.project === project && f.config === name && f.date === d;
    if (v.isExternal) return logs.some(match);
    // 成片内：必须与配置位于同一成片文件夹的日志才能跳
    const cfgDir = path.dirname(v.path);
    return logs.some((f) => match(f) && path.dirname(f.path) === cfgDir);
  }

  _buildVersions(projectDir, name) {
    const txs = this._collectAllTxt().filter((t) => t.pdir === projectDir);
    return this._buildVersionsFromList(name, txs);
  }

  _buildVersionsFromList(name, txs) {
    const target = name.toLowerCase();
    const sources = [];
    const copies = [];
    for (const t of txs) {
      if (t.name.toLowerCase() !== target) continue;
      if (isChengpianFile(t.parts)) copies.push({ full: t.full, parts: t.parts, hash: t.hash });
      else sources.push({ full: t.full, parts: t.parts, hash: t.hash });
    }
    const groups = new Map();
    for (const s of sources) {
      const label = relativeDateLabel(s.parts);
      if (!groups.has(label)) groups.set(label, { source: null, copies: [] });
      groups.get(label).source = s;
    }
    for (const c of copies) {
      const label = relativeDateLabel(c.parts);
      if (!groups.has(label)) groups.set(label, { source: null, copies: [] });
      groups.get(label).copies.push(c);
    }
    const versions = [];
    const labels = [...groups.keys()].sort((a, b) => compareDateSortKey(b, a));
    for (const label of labels) {
      const g = groups.get(label);
      // 同一日期分支下，按「成片文件夹」去重（每夹一份配置，目录含时间，升序即旧→新）：
      //   - 多个成片文件夹 → 全部序号化，最旧 = <MMdd>-1，依次 -2…（无无后缀正本）
      //   - 单个成片文件夹 → 无后缀正本 <MMdd>
      //   - 成片文件夹外的单独配置 → <MMdd>*（isExternal）
      const chengpian = dedupeByDir(g.copies);
      const outside = g.source ? [g.source] : [];
      if (chengpian.length > 1) {
        chengpian.forEach((c, i) => versions.push({ label: `${label}-${i + 1}`, path: c.full, isExternal: false }));
      } else if (chengpian.length === 1) {
        versions.push({ label, path: chengpian[0].full, isExternal: false });
      }
      outside.forEach((s) => versions.push({ label: `${label}*`, path: s.full, isExternal: true }));
    }
    versions.forEach((v, i) => { v.is_latest = i === 0; });
    return versions;
  }

  readConfig(filePath) {
    filePath = path.resolve(filePath);
    const text = readText(filePath);
    const lines = text.split(/\r?\n/);
    const folders = [];
    const excludes = [];
    let watermark = '';
    for (const ln of lines) {
      const s = ln.trim();
      if (!s) continue;
      if (s.startsWith('=')) folders.push({ path: stripQuotes(s.slice(1)), nonround: true });
      else if (s.startsWith('-')) excludes.push(stripQuotes(s.slice(1)));
      else folders.push({ path: stripQuotes(s), nonround: false });
    }
    if (folders.length) {
      const last = folders[folders.length - 1];
      if (last.path.toLowerCase().endsWith('.png') && !last.nonround) watermark = stripQuotes(folders.pop().path);
    }
    return { path: filePath, raw: text, lines, folders, excludes, watermark, name: path.basename(filePath, path.extname(filePath)) };
  }

  _rewriteText(folders, excludes, watermark) {
    const out = [];
    for (const f of folders) {
      const isDict = f && typeof f === 'object';
      const p = (isDict ? f.path : f).trim();
      if (!p) continue;
      const nonround = isDict ? !!f.nonround : false;
      out.push(nonround ? '=' + p : p);
    }
    for (const e of excludes) { const s = e.trim(); if (s) out.push('-' + s); }
    if (watermark && watermark.trim()) { out.push(''); out.push(watermark.trim()); }
    return out.join('\r\n') + '\r\n';
  }

  saveConfig(filePath, folders, excludes, watermark) {
    filePath = path.resolve(filePath);
    const text = this._rewriteText(folders, excludes, watermark);
    fs.writeFileSync(filePath, text, 'utf-8');
    this._invalidateCaches();
    return { ok: true, path: filePath };
  }

  saveConfigToday(project, name, configName, folders, excludes, watermark) {
    const pdir = path.join(this.root, project);
    const now = new Date();
    const monthDir = String(now.getMonth() + 1) + '月';
    const dayDir = String(now.getMonth() + 1).padStart(2, '0') + String(now.getDate()).padStart(2, '0');
    const targetDir = path.join(pdir, monthDir, dayDir);
    fs.mkdirSync(targetDir, { recursive: true });
    let finalName = (configName || name || 'config').trim();
    if (!finalName.toLowerCase().endsWith('.txt')) finalName += '.txt';
    const filePath = path.join(targetDir, finalName);
    fs.writeFileSync(filePath, this._rewriteText(folders, excludes, watermark), 'utf-8');
    this._invalidateCaches();
    return { ok: true, path: filePath };
  }

  _loadVideoCache() {
    if (this._videoCache !== null) return this._videoCache;
    let cache = {};
    const p = this.videoCachePath || '';
    try {
      if (p && fs.existsSync(p)) {
        const data = JSON.parse(fs.readFileSync(p, 'utf-8'));
        if (data && typeof data === 'object' && !Array.isArray(data)) cache = data;
      }
    } catch (e) { cache = {}; }
    this._videoCache = cache;
    return cache;
  }

  _mtimeToTicks(videoPath) {
    try { return Math.round(fs.statSync(videoPath).mtimeMs * 10000) + 621355968000000000; } catch (e) { return 0; }
  }

  // ffprobe 异步探测（并发限流使用，不阻塞主线程）
  _probeVideoAsync(videoPath) {
    return new Promise((resolve) => {
      const { execFile } = require('child_process');
      execFile(
        'ffprobe',
        ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', videoPath],
        { encoding: 'utf8', timeout: 60000, windowsHide: true },
        (err, stdout) => {
          if (err) return resolve({ valid: false, duration: 0, width: 0, height: 0 });
          const lines = String(stdout).split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
          if (lines.length >= 3) {
            const width = parseInt(lines[0], 10);
            const height = parseInt(lines[1], 10);
            const duration = parseFloat(lines[2]);
            const valid = width === 1080 && height === 1920 && isFinite(duration) && duration > 0;
            return resolve({ valid, duration: isFinite(duration) ? duration : 0, width, height });
          }
          resolve({ valid: false, duration: 0, width: 0, height: 0 });
        }
      );
    });
  }

  // 并发限流执行器：同一时刻最多并发 limit 个，全部完成后按输入顺序返回结果数组
  _runWithLimit(items, worker, limit) {
    return new Promise((resolve) => {
      const n = items.length;
      if (n === 0) return resolve([]);
      const limitN = Math.max(1, limit | 0);
      const results = new Array(n);
      let i = 0, running = 0, done = 0;
      const pump = () => {
        while (running < limitN && i < n) {
          const idx = i++;
          running++;
          Promise.resolve()
            .then(() => worker(items[idx], idx))
            .catch(() => undefined)
            .then((v) => { results[idx] = v; })
            .then(() => { running--; done++; if (done === n) resolve(results); else pump(); });
        }
      };
      pump();
    });
  }

  // 读取缓存视频信息：命中且 mtime 未变则直接复用，否则返回 null（交由并发探测）
  _fetchCachedVideoInfo(videoPath) {
    if (this._videoInfoCache.has(videoPath)) return this._videoInfoCache.get(videoPath);
    try { fs.statSync(videoPath); } catch (e) { return null; }
    const cache = this._loadVideoCache();
    const cached = cache[videoPath];
    if (cached && cached.LastWriteTime === this._mtimeToTicks(videoPath)) {
      const info = { valid: !!cached.Valid, duration: Number(cached.Duration) || 0, width: cached.Width || 0, height: cached.Height || 0 };
      this._videoInfoCache.set(videoPath, info);
      return info;
    }
    if (cached) delete cache[videoPath]; // 指纹变化，丢弃旧缓存交由重新探测
    return null;
  }

  // 并发探测缺失缓存的视频并写回缓存；返回 path -> info 映射
  async _resolveVideoInfos(videoPaths) {
    const result = new Map();
    const needProbe = [];
    for (const p of videoPaths) {
      const c = this._fetchCachedVideoInfo(p);
      if (c) result.set(p, c);
      else needProbe.push(p);
    }
    const infos = await this._runWithLimit(needProbe, (p) => this._probeVideoAsync(p), this.probeConcurrency);
    const cache = this._loadVideoCache();
    for (let i = 0; i < needProbe.length; i++) {
      const p = needProbe[i];
      const info = infos[i] || { valid: false, duration: 0, width: 0, height: 0 };
      cache[p] = { LastWriteTime: this._mtimeToTicks(p), Duration: info.duration, Valid: info.valid, Width: info.width, Height: info.height };
      this._videoInfoCache.set(p, info);
      result.set(p, info);
    }
    return result;
  }

  _saveVideoCache() {
    try {
      const p = this.videoCachePath || '';
      if (!p) return;
      fs.writeFileSync(p, JSON.stringify(this._videoCache), 'utf-8');
    } catch (e) {}
  }

  _isExcludedPath(target, excludes) {
    if (!excludes || excludes.length === 0) return false;
    for (const ex of excludes) {
      const clean = stripQuotes(String(ex)).replace(/[\\/]+$/, '');
      if (!clean) continue;
      if (target.toLowerCase().indexOf(clean.toLowerCase()) >= 0) return true;
    }
    return false;
  }

  async _precheckFolder(dir, excludes, nonround) {
    // 第一遍：仅同步收集候选视频，按"根目录 + 各子目录"分组，暂不探测
    const groups = [];
    try {
      const items = fs.readdirSync(dir, { withFileTypes: true });
      const rootVideos = [];
      const subDirs = [];
      for (const ent of items) {
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) subDirs.push(full);
        else if (ent.isFile() && VIDEO_EXTS.has(path.extname(ent.name).toLowerCase())) rootVideos.push(full);
      }
      const rootCands = [];
      for (const v of rootVideos) if (!this._isExcludedPath(v, excludes)) rootCands.push(v);
      groups.push(rootCands);
      for (const sub of subDirs) {
        const cands = [];
        for (const f of walkFiles(sub)) {
          if (!VIDEO_EXTS.has(path.extname(f).toLowerCase())) continue;
          if (this._isExcludedPath(f, excludes)) continue;
          cands.push(f);
        }
        groups.push(cands);
      }
    } catch (e) { return { total: 0, groupCount: 0 }; }

    // 去重后并发探测（未命中缓存的才跑 ffprobe，限流）
    const seen = new Set();
    const all = [];
    for (const g of groups) for (const f of g) if (!seen.has(f)) { seen.add(f); all.push(f); }
    const infos = await this._resolveVideoInfos(all);

    let total = 0, groupCount = 0;
    for (const g of groups) if (g.some((f) => { const i = infos.get(f); return i && i.valid; })) groupCount++;
    for (const f of all) { const i = infos.get(f); if (i && i.valid) total++; }
    if (nonround && total > 0) groupCount = 1;
    return { total, groupCount };
  }

  async precheck(paths, excludes) {
    excludes = (Array.isArray(excludes) ? excludes : []).map((s) => stripQuotes(s)).filter(Boolean);
    const results = [];
    const dedup = new Map();
    for (const item of paths) {
      const isObj = item && typeof item === 'object';
      const key = stripQuotes(isObj ? item.path : item);
      const nonround = isObj ? !!item.nonround : false;
      if (!key) { results.push({ status: 'pending', text: '未检测', total: 0, groupCount: 0, exists: false }); continue; }
      if (dedup.has(key)) { results.push(dedup.get(key)); continue; }
      let r;
      try {
        const st = fs.statSync(key);
        if (st.isDirectory()) {
          const s = await this._precheckFolder(key, excludes, nonround);
          if (s.total === 0) r = { status: 'warn', text: '无合规视频', total: 0, groupCount: 0, exists: true };
          else {
            const grouped = s.groupCount > 1;
            const text = grouped ? `${s.total} 个视频，分为 ${s.groupCount} 个子组` : `${s.total} 个视频`;
            r = { status: grouped ? 'group' : 'ok', text, total: s.total, groupCount: s.groupCount, exists: true };
          }
        } else if (st.isFile()) {
          if (VIDEO_EXTS.has(path.extname(key).toLowerCase())) {
            const info = this._fetchCachedVideoInfo(key) || await this._probeVideoAsync(key);
            const valid = !this._isExcludedPath(key, excludes) && info.valid;
            r = valid ? { status: 'ok', text: '1 个视频', total: 1, groupCount: 1, exists: true } : { status: 'warn', text: '非合规视频', total: 0, groupCount: 0, exists: true };
          } else r = { status: 'warn', text: '非视频文件', total: 0, groupCount: 0, exists: true };
        } else r = { status: 'warn', text: '路径无效', total: 0, groupCount: 0, exists: false };
      } catch (e) { r = { status: 'warn', text: '路径不存在', total: 0, groupCount: 0, exists: false }; }
      results.push(r);
      dedup.set(key, r);
    }
    this._saveVideoCache();
    return results;
  }

  // 重置预检测：清除物理缓存，收集所有配置指向的路径并全量探测（跨路径去重），可实时回报进度
  async resetPrecheck(onProgress) {
    try {
      const cf = this.videoCachePath || '';
      if (cf && fs.existsSync(cf)) fs.unlinkSync(cf);
    } catch (e) {}
    this._videoCache = {};
    this._videoInfoCache = new Map();

    // 收集所有配置指向的素材路径（跨配置去重）
    const all = this._collectAllTxt();
    const pathSet = new Set();
    for (const t of all) {
      let cfg;
      try { cfg = this.readConfig(t.full); } catch (e) { continue; }
      for (const f of (cfg.folders || [])) {
        const p = stripQuotes(String((f && typeof f === 'object' ? f.path : f) || '').trim());
        if (p) pathSet.add(p);
      }
    }

    // 收集所有视频候选（跨路径去重）
    const seen = new Set();
    const allVideos = [];
    for (const p of pathSet) {
      let st;
      try { st = fs.statSync(p); } catch (e) { continue; }
      const cands = [];
      if (st.isDirectory()) {
        for (const f of walkFiles(p)) if (VIDEO_EXTS.has(path.extname(f).toLowerCase())) cands.push(f);
      } else if (st.isFile() && VIDEO_EXTS.has(path.extname(p).toLowerCase())) cands.push(p);
      for (const f of cands) if (!seen.has(f)) { seen.add(f); allVideos.push(f); }
    }

    const report = (s) => { if (onProgress) { try { onProgress(s); } catch (e) {} } };
    const total = allVideos.length;
    let probed = 0, valid = 0;
    const cache = this._loadVideoCache();
    await this._runWithLimit(allVideos, (f) => this._probeVideoAsync(f).then((info) => {
      cache[f] = { LastWriteTime: this._mtimeToTicks(f), Duration: info.duration, Valid: info.valid, Width: info.width, Height: info.height };
      this._videoInfoCache.set(f, info);
      probed++;
      if (info.valid) valid++;
      report({ done: probed, total });
    }), this.probeConcurrency);

    this._saveVideoCache();
    report({ done: probed, total, finished: true });
    return { ok: true, total, valid, invalid: total - valid };
  }

  // 收集某配置目录下的日志候选并解析为成片条目（按目录 mtime 缓存）
  _collectLogEntries(baseDir) {
    const candidates = new Set();
    try {
      for (const f of fs.readdirSync(baseDir)) {
        if (!f.toLowerCase().endsWith('.txt')) continue;
        if (LOG_NAME_RE.test(f)) candidates.add(path.join(baseDir, f));
      }
      for (const sub of fs.readdirSync(baseDir)) {
        const d = path.join(baseDir, sub);
        if (!fs.existsSync(d) || !fs.statSync(d).isDirectory()) continue;
        if (!sub.endsWith('成片')) continue;
        for (const f of fs.readdirSync(d)) if (f.toLowerCase().endsWith('.txt') && LOG_NAME_RE.test(f)) candidates.add(path.join(d, f));
      }
    } catch (e) {}
    let entries = [];
    for (const lp of [...candidates].sort()) entries = entries.concat(this._parseLog(lp));
    return entries;
  }

  // 从日志文件名提取其所归属的配置名（批量拼接日志形如 MMdd-HH时MM分-配置名-拼接日志.txt）
  _configNameFromLog(logPath) {
    const m = /^\d{4}-\d+时\d+分-(.+)-(?:拼接|复刻)日志\.txt$/i.exec(path.basename(logPath || ''));
    return m ? m[1].trim() : '';
  }

  // 收集根目录下所有属于某复刻模式的日志文件（命名形如 MMdd-模式名日志.txt）
  _replicaLogFiles(modeName) {
    const esc = String(modeName || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pat = new RegExp('^\\d{4}-' + esc + '日志\\.txt$');
    const out = [];
    if (!this.root || !fs.existsSync(this.root)) return out;
    for (const full of walkFiles(this.root)) {
      if (!path.basename(full).toLowerCase().endsWith('.txt')) continue;
      if (pat.test(path.basename(full))) out.push(full);
    }
    return out.sort();
  }

  _replicaLogs(modeName) {
    let entries = [];
    for (const lp of this._replicaLogFiles(modeName)) entries = entries.concat(this._parseLog(lp));
    return entries;
  }

  // 复刻模式对应的完整日志行内容（与 logContent 同结构，便于右侧继续跳转高亮）
  _replicaLogContent(modeName) {
    const files = []; const entries = []; let running = 1;
    for (const lp of this._replicaLogFiles(modeName)) {
      let text;
      try { text = readText(lp); } catch (e) { continue; }
      const lines = text.split(/\r?\n/);
      files.push({ path: lp, name: path.basename(lp), lines });
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].trim() !== '使用片段列表：') continue;
        if (i < 1) continue;
        let name = lines[i - 1].trim();
        const m = /第\s*\d+\s*个成片\s*[：:]\s*(.+?)\s*$/.exec(name);
        if (m) name = m[1].trim().replace(/=+$/, '').trim();
        entries.push({ video: name, logPath: lp, lineStart: running + i });
      }
      running += lines.length;
    }
    return { files, entries };
  }

  listLogs(project, name, versionPath) {
    if (versionPath && String(versionPath).startsWith(REPLICA_MARK)) {
      return this._replicaLogs(String(versionPath).slice(REPLICA_MARK.length));
    }
    const all = this._collectLogEntries(path.dirname(path.resolve(versionPath)));
    const target = String(name == null ? '' : name).trim();
    if (!target) return all;
    return all.filter((e) => this._configNameFromLog(e.log_path) === target);
  }

  _logsForTxt(txtFull) {
    const baseDir = path.dirname(txtFull);
    let mtime = 0;
    try { mtime = fs.statSync(baseDir).mtimeMs; } catch (e) {}
    const cached = this._logsEntryCache && this._logsEntryCache.get(baseDir);
    if (cached && cached.mtime === mtime) return cached.entries;
    const entries = this._collectLogEntries(baseDir);
    if (!this._logsEntryCache) this._logsEntryCache = new Map();
    this._logsEntryCache.set(baseDir, { mtime, entries });
    return entries;
  }

  // 全局成片名搜索：跨越所有项目/TXT/日期分支，返回包含该成片的日志定位信息
  searchLogs(query) {
    const q = String(query == null ? '' : query).trim().toLowerCase();
    if (!q) return [];
    const out = [];
    const seen = new Set();
    for (const t of this._collectAllTxt()) {
      const entries = this._logsForTxt(t.full);
      for (const e of entries) {
        const v = String(e.video || '');
        if (!v.toLowerCase().includes(q)) continue;
        const key = e.log_path + '\u0000' + v;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          project: path.basename(t.pdir),
          txtName: t.name,
          label: relativeDateLabel(t.parts),
          logPath: e.log_path,
          txtPath: t.full,
          video: v,
          clips: e.clips,
          watermark: e.watermark,
        });
      }
    }
    return out;
  }

  // 返回某配置对应的日志文件列表（日志模式下日期分支使用）
  // 与配置同一判定规则：取 fromPath(配置) 路径中最近的 4 位 MMdd 目录作为日期分支，日志按同项目+同日期+同名匹配
  listLogFiles(fromPath, configName) {
    if (fromPath && String(fromPath).startsWith(REPLICA_MARK)) {
      const mode = String(fromPath).slice(REPLICA_MARK.length);
      return this._replicaLogFiles(mode).map((f) => ({ path: f, name: path.basename(f), date: path.basename(f).slice(0, 4) }));
    }
    // 使用刷新时写入的日志缓存，按项目 + 日期分支 + 配置名过滤
    const project = this._projectOf(fromPath);
    const date = this._dateBranchOf(fromPath);
    const target = String(configName == null ? '' : configName).trim();
    const files = this._collectLogFiles().files
      .filter((f) => f.project === project && f.date === date && (!target || f.config === target))
      .map((f) => ({ path: f.path, name: f.name, date: f.date }));
    files.sort((a, b) => (b.date.localeCompare(a.date) || a.name.localeCompare(b.name)));
    return files;
  }

  logContent(fromPath, configName) {
    if (fromPath && String(fromPath).startsWith(REPLICA_MARK)) {
      return this._replicaLogContent(String(fromPath).slice(REPLICA_MARK.length));
    }
    const baseDir = path.dirname(path.resolve(fromPath));
    const target = String(configName == null ? '' : configName).trim();
    const candidates = new Set();
    try {
      for (const f of fs.readdirSync(baseDir)) {
        if (!f.toLowerCase().endsWith('.txt')) continue;
        if (LOG_NAME_RE.test(f)) candidates.add(path.join(baseDir, f));
      }
      for (const sub of fs.readdirSync(baseDir)) {
        const d = path.join(baseDir, sub);
        if (!fs.existsSync(d) || !fs.statSync(d).isDirectory()) continue;
        if (!sub.endsWith('成片')) continue;
        for (const f of fs.readdirSync(d)) if (f.toLowerCase().endsWith('.txt') && LOG_NAME_RE.test(f)) candidates.add(path.join(d, f));
      }
    } catch (e) {}
    const files = [];
    const entries = [];
    let running = 1;
    for (const lp of [...candidates].sort()) {
      if (target && this._configNameFromLog(lp) !== target) continue;
      let text;
      try { text = readText(lp); } catch (e) { continue; }
      const lines = text.split(/\r?\n/);
      files.push({ path: lp, name: path.basename(lp), lines });
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].trim() !== '使用片段列表：') continue;
        if (i < 1) continue;
        let name = lines[i - 1].trim();
        const m = /第\s*\d+\s*个成片\s*[：:]\s*(.+?)\s*$/.exec(name);
        if (m) name = m[1].trim().replace(/=+$/, '').trim();
        entries.push({ video: name, logPath: lp, lineStart: running + i });
      }
      running += lines.length;
    }
    return { files, entries };
  }

  // 批量检查片段路径是否存在，返回 { 原路径: true/false }
  checkExists(paths) {
    const out = {};
    const arr = Array.isArray(paths) ? paths : [];
    for (const p of arr) {
      const s = String(p == null ? '' : p).trim().replace(/^"|"$/g, '');
      if (!s) continue;
      try { out[s] = fs.existsSync(s); } catch (e) { out[s] = false; }
    }
    return out;
  }

  _parseLog(logPath) {
    const text = readText(logPath);
    const lines = text.split(/\r?\n/).map((l) => l.trim());
    const entries = [];
    let current = { video: '', clips: [], watermark: '', log_path: logPath };
    for (let idx = 0; idx < lines.length; idx++) {
      const line = lines[idx];
      if (line === '使用片段列表：') {
        if (current.video || current.clips.length) entries.push(current);
        let name = '';
        if (idx > 0) name = lines[idx - 1];
        const m = /第\s*\d+\s*个成片\s*[：:]\s*(.+?)\s*$/.exec(name);
        if (m) name = m[1].trim().replace(/=+$/, '').trim();
        current = { video: name, clips: [], watermark: '', log_path: logPath };
        continue;
      }
      if (/^[A-Za-z]:[\\/]/.test(line) || /^\\\\/.test(line)) {
        const p = line.trim().replace(/^['"]|['"]$/g, '');
        if (p.toLowerCase().endsWith('.png')) current.watermark = p;
        else if (VIDEO_EXTS.has(path.extname(p).toLowerCase())) current.clips.push(p);
        else current.clips.push(p);
      }
    }
    if (current.video || current.clips.length) entries.push(current);
    return entries;
  }

  // 任务管理 -------------------------------------------------
  _createTask(type, title, scriptPath, env) {
    const id = 'task_' + (++this.taskSeq) + '_' + Date.now().toString(36);
    const task = {
      id, type, title, script: scriptPath, env: Object.assign({}, env),
      pid: null, status: 'running', lockState: 'unknown', progress: { current: 0, total: 0 },
      failReason: '', log: [],
      createdAt: Date.now(), endedAt: null, _stopRequested: false,
    };
    this.tasks.set(id, task);
    this._emitTasks();
    return task;
  }

  // 从任务日志中提取人类可读的失败原因（不展示代码/堆栈）
  _deriveFailReason(task) {
    const lines = task.log || [];
    const rules = [
      [/连续\s*\d+\s*次重试无法找到满足时长的组合/, '多次尝试仍无法找到符合时长要求的视频组合'],
      [/部分输入文件不存在/, '部分输入视频文件不存在'],
      [/无有效视频片段/, '没有可用于拼接的有效视频片段'],
      [/一次性编码失败/, '视频编码失败（请检查源视频与 ffmpeg）'],
      [/无法自动修复/, '存在缺失的视频片段且无法自动修复'],
      [/检测到\s*\d+\s*个片段不存在/, '存在缺失的视频片段'],
      [/路径\s*.+?\s*过滤后无任何合规视频/, '路径下没有符合分辨率/时长要求的视频'],
      [/以下路径无法通过索引自动修复/, '存在无法解析的视频路径，请检查 TXT 配置'],
      [/水印必须是有效PNG文件/, '水印文件无效（必须为 PNG 图片）'],
      [/无有效视频文件夹/, '没有可用的视频文件夹'],
      [/不是TXT格式/, '指定的文件不是 TXT 格式'],
      [/检测到重复成片名/, '存在重复的成片名'],
      [/全局异常/, '脚本运行过程中出现异常'],
      [/脚本执行完成（有错误）/, '脚本执行出错'],
      [/ffmpeg|ffprobe/, '视频处理工具不可用'],
    ];
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      for (const [re, msg] of rules) {
        if (re.test(line)) return msg;
      }
    }
    return '脚本执行失败';
  }

  snapshotTasks() {
    const list = [];
    this.tasks.forEach((t) => list.push({
      id: t.id, type: t.type, title: t.title, script: t.script, pid: t.pid,
      status: t.status, lockState: t.lockState, paused: !!t.paused,
      progress: t.progress || { current: 0, total: 0 }, failReason: t.failReason || '',
      createdAt: t.createdAt, endedAt: t.endedAt,
      log: t.log.slice(-500),
    }));
    list.sort((a, b) => a.createdAt - b.createdAt);
    return list;
  }

  _emitTasks() { if (this.onTasksChanged) this.onTasksChanged(this.snapshotTasks()); }

  // 停止任务：对尚未获取互斥锁（排队中）的任务安全，直接终止进程树
  stopTask(id) {
    const { spawnSync } = require('child_process');
    const t = this.tasks.get(id);
    if (!t) return { ok: false, error: '任务不存在' };
    if (t.status !== 'running') return { ok: false, error: '任务已结束' };
    if (!t.pid) return { ok: false, error: '任务进程尚未就绪' };
    t._stopRequested = true;
    t.log.push('[已请求停止任务，正在终止进程…]');
    this._emitTasks();
    try {
      const r = spawnSync('taskkill', ['/PID', String(t.pid), '/T', '/F'], { windowsHide: true, encoding: 'utf8' });
      return r.status === 0 ? { ok: true } : { ok: false, error: (r.stderr || '').trim() || '停止失败' };
    } catch (e) { return { ok: false, error: String(e) }; }
  }

  clearFinishedTasks() {
    for (const [id, t] of this.tasks) { if (t.status !== 'running') this.tasks.delete(id); }
    this._emitTasks();
    return { ok: true };
  }

  // 挂起/恢复进程树根进程（通过 ntdll 的 NtSuspendProcess / NtResumeProcess 实现）
  _suspendProcess(pid, suspend) {
    const { spawnSync } = require('child_process');
    const fn = suspend ? 'NtSuspendProcess' : 'NtResumeProcess';
    const ps = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class NativeProc {
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern IntPtr OpenProcess(uint dwDesiredAccess, bool bInheritHandle, int dwProcessId);
  [DllImport("ntdll.dll", SetLastError=true)]
  public static extern int ${fn}(IntPtr ProcessHandle);
  [DllImport("kernel32.dll")]
  public static extern bool CloseHandle(IntPtr hObject);
}
"@;
$h = [NativeProc]::OpenProcess(0x0001, $false, ${pid});
if ($h -eq [IntPtr]::Zero) { Write-Error "OpenProcess failed: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())"; exit 1 }
$r = [NativeProc]::${fn}($h);
[NativeProc]::CloseHandle($h) | Out-Null;
if ($r -ne 0) { Write-Error "op failed: $r"; exit 1 }
`;
    try {
      const r = spawnSync('pwsh', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps], { windowsHide: true, encoding: 'utf8' });
      return r.status === 0;
    } catch (e) { return false; }
  }

  // 暂停：仅对尚未获取互斥锁（排队中）的任务有效，挂起其进程使其不去抢锁
  pauseTask(id) {
    const t = this.tasks.get(id);
    if (!t) return { ok: false, error: '任务不存在' };
    if (t.status !== 'running') return { ok: false, error: '任务已结束' };
    if (t.paused) return { ok: false, error: '任务已处于暂停状态' };
    if (t.lockState === 'locked') return { ok: false, error: '任务已获取互斥锁，无法暂停' };
    if (!t.pid) return { ok: false, error: '任务进程尚未就绪' };
    if (!this._suspendProcess(t.pid, true)) return { ok: false, error: '暂停失败（无法挂起进程）' };
    t.paused = true;
    t.log.push('[已暂停任务，等待互斥锁的进程已挂起]');
    this._emitTasks();
    return { ok: true };
  }

  // 继续：恢复被暂停的任务进程
  resumeTask(id) {
    const t = this.tasks.get(id);
    if (!t) return { ok: false, error: '任务不存在' };
    if (t.status !== 'running') return { ok: false, error: '任务已结束' };
    if (!t.paused) return { ok: false, error: '任务未处于暂停状态' };
    if (!t.pid) return { ok: false, error: '任务进程已退出' };
    if (!this._suspendProcess(t.pid, false)) return { ok: false, error: '恢复失败（无法恢复进程）' };
    t.paused = false;
    t.log.push('[已恢复任务]');
    this._emitTasks();
    return { ok: true };
  }

  _spawnPowerShell(script, env, task) {
    // 以 pwsh 启动脚本（绕过 cmd /c start 中转，避免中文路径被代码页转码导致脚本无法加载）。
    // 实时捕获 stdout/stderr 并通过任务管理器推送，供任务窗口显示。
    const { spawn } = require('child_process');
    return new Promise((resolve) => {
      const child = spawn('pwsh', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script], {
        env: Object.assign({}, process.env, env),
        cwd: this.scriptsDir,
        windowsHide: true,   // 不弹黑窗，输出由任务窗口实时展示
        detached: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      if (task) {
        task.pid = child.pid;
        const decodeLine = (buf) => {
          try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); }
          catch (e) { try { return new TextDecoder('gbk').decode(buf); } catch (e2) { return buf.toString('latin1'); } }
        };
        const pushLine = (buf) => {
          const s = decodeLine(buf).replace(/\r$/, '').trim();
          if (!s || task.status !== 'running') return;
          task.log.push(s);
          // 进度解析：匹配 "共 N 个" 与 "生成第 X / Y 个成片" / "复刻第 X / Y 个成片"
          const totalMatch = s.match(/共\s*(\d+)\s*个/);
          if (totalMatch) {
            const n = parseInt(totalMatch[1], 10);
            if (n > 0) task.progress.total = n;
          }
          const curMatch = s.match(/(?:生成|复刻)第\s*(\d+)\s*\/\s*(\d+)\s*个成片/);
          if (curMatch) {
            const c = parseInt(curMatch[1], 10), t = parseInt(curMatch[2], 10);
            if (t > 0) task.progress.total = t;
            task.progress.current = c;
            // 新成片开始：重置单成片进度
            task._clipDur = 0;
            task.progress.clip = 0;
            task.progress.clipTarget = 0;
          }
          // 单成片实时进度：目标时长（分母）+ ffmpeg out_time（分子）
          const durM = s.match(/成片预计时长:\s*([\d.]+)\s*秒/);
          if (durM) {
            const d = parseFloat(durM[1]);
            if (d > 0) { task._clipDur = d; task.progress.clipTarget = d; task.progress.clip = 0; }
          }
          const outM = s.match(/out_time=(\d+):(\d+):(\d+(?:\.\d+)?)/)
            || s.match(/\btime=(\d+):(\d+):(\d+(?:\.\d+)?)/);
          if (outM) {
            task.progress.clip = parseInt(outM[1], 10) * 3600 + parseInt(outM[2], 10) * 60 + parseFloat(outM[3]);
          }
          const usM = s.match(/out_time_us=(\d+)/);
          if (usM) task.progress.clip = parseInt(usM[1], 10) / 1e6;
          if (/成片完成/.test(s) && task._clipDur > 0) task.progress.clip = task._clipDur;
          if (/等待获取互斥锁/.test(s)) task.lockState = 'waiting';
          else if (/已获取互斥锁/.test(s)) task.lockState = 'locked';
          else if (/互斥锁已释放|任务全部完成|脚本完成/.test(s)) task.lockState = 'released';
          this._emitTasks();
        };
        const attach = (stream, ref) => stream.on('data', (chunk) => {
          ref.data = Buffer.concat([ref.data, chunk]);
          let idx;
          while ((idx = ref.data.indexOf(0x0a)) >= 0) { pushLine(ref.data.slice(0, idx)); ref.data = ref.data.slice(idx + 1); }
        });
        const out = { data: Buffer.alloc(0) }, err = { data: Buffer.alloc(0) };
        attach(child.stdout, out);
        attach(child.stderr, err);
        child.on('close', (code) => {
          if (out.data.length) pushLine(out.data);
          if (err.data.length) pushLine(err.data);
          task.endedAt = Date.now();
          task.status = task._stopRequested ? 'stopped' : (code === 0 ? 'done' : 'error');
          task.paused = false;
          if (task.status === 'error') task.failReason = this._deriveFailReason(task);
          this._emitTasks();
        });
        child.on('error', (err2) => {
          task.log.push('[启动失败] ' + String(err2));
          task.status = 'error';
          task.failReason = '脚本启动失败，请检查脚本目录配置';
          task.endedAt = Date.now();
          this._emitTasks();
        });
      }
      child.on('error', (err2) => resolve({ ok: false, error: String(err2) }));
      child.unref();
      resolve({ ok: true });
    });
  }

  // 任务显示标题：优先"项目名 / txt 文件名"（txt 去掉 .txt 后缀），取不到项目名则回退文件名
  _taskTitle(filePath) {
    const abs = path.resolve(filePath);
    const rel = path.relative(this.root, abs);
    const parts = rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel.split(path.sep).filter(Boolean) : [];
    const base = path.basename(abs);
    const txtName = base.replace(/\.txt$/i, '') || base;
    if (parts.length > 0) return parts[0] + ' / ' + txtName;
    return txtName;
  }

  runBatch(filePath, count, group) {
    const script = path.join(this.scriptsDir, '批量拼接.ps1');
    if (!fs.existsSync(script)) return { ok: false, error: '未找到脚本：' + script };
    const env = { REPLICA_TXT: path.resolve(filePath) };
    const countStr = String(count).trim();
    if (/^\d+$/.test(countStr) && parseInt(countStr, 10) > 0) env.BATCH_COUNT = countStr;
    const groupStr = String(group).trim();
    env.BATCH_GROUP = /^\d+$/.test(groupStr) && parseInt(groupStr, 10) > 0 ? groupStr : '0';
    env.REPLICA_NO_WAIT = '1';
    const task = this._createTask('batch', this._taskTitle(filePath), script, env);
    this._spawnPowerShell(script, env, task);
    return { ok: true, taskId: task.id };
  }

  runReplica(logPath, mode = 1) {
    const script = path.join(this.scriptsDir, '视频复刻.ps1');
    if (!fs.existsSync(script)) return { ok: false, error: '未找到脚本：' + script };
    const env = { REPLICA_TXT: path.resolve(logPath), REPLICA_MODE: String(mode) === '2' ? '2' : '1', REPLICA_NO_WAIT: '1' };
    const task = this._createTask('replica', this._taskTitle(logPath) + (String(mode) === '2' ? '（去重）' : ''), script, env);
    this._spawnPowerShell(script, env, task);
    return { ok: true, taskId: task.id };
  }

  resolvePath(filePath) { return path.resolve(filePath); }

  // 检测应用运行所需的外部环境是否可用（pwsh / ffmpeg / ffprobe）
  checkEnv() {
    const { spawnSync } = require('child_process');
    const have = (name) => {
      try { const r = spawnSync('where', [name], { windowsHide: true, encoding: 'utf8' }); return r.status === 0; }
      catch (e) { return false; }
    };
    return { pwsh: have('pwsh'), ffmpeg: have('ffmpeg'), ffprobe: have('ffprobe') };
  }
}

module.exports = { Api, DEFAULT_CONFIG };
