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
// 复刻模式名称，按 video_replica.ps1 的 mode 映射；两种模式在侧栏各作一个配置名，仅含日志无配置
const REPLICA_MODES = ['原片复刻', '去重复刻'];
const REPLICA_PROJECT = '复刻'; // 侧栏中的虚拟项目名（仅含日志，无配置）
const REPLICA_MARK = 'REPLICA:'; // 复刻项目虚拟版本的 path 前缀，用于路由 list_logs / logContent

// 默认配置
const DEFAULT_CONFIG = {
  scripts_dir: '',
  skin: 'white_blue',
  auto_check_update: true,    // 启动时自动检查更新
  check_update_daily: false,  // 每日定时检查更新（整点触发，需 app 保持运行）
  check_update_hour: 9,       // 每日定时检查更新时间（24 小时制整点 0-23，默认 9）
  update_source: 'gitee',     // 更新源：gitee=码云 release / github=GitHub release，默认码云
  config_storage: 'program',  // 配置文件保存位置：program=程序所在目录 / appdata=%APPDATA%\Video Lab
  // video_batch.ps1 顶部全局参数（文件内同名常量被顶部读环境变量 BATCH_* 覆盖）
  batch: {
    max_duration: 179,   // MaxTotalDurationSec 最大成片时长(秒)
    max_retry: 45,       // MaxRetry 重试次数
    speed_limit: 1.2,    // SpeedThreshold 倍速阈值
    txt_prefix: '',      // TxtNamePrefix 提取前缀，可留空
    producer: '李佳燊',  // 成片名固定品牌名
    suffix_mark: 'YX',   // 序号后缀（成片名中的序号标识），可改
  },
  // video_replica.ps1 顶部全局参数（文件内同名常量被顶部读环境变量 REPLICA_* 覆盖）
  replica: {
    max_duration: 179,   // MaxTotalDurationSec
    speed_limit: 1.2,    // SpeedThreshold
    dedup_ratio: 0.4,    // DedupRatio 去重阈值
  },
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

// 原子写：先写 <p>.tmp 再 rename 覆盖；写入/替换失败时清理临时文件，原文件保持有效可复用。
// 用于任务状态/配置/索引等"坏一次就丢功能"的关键落盘，避免崩溃写坏半截文件。
function atomicWrite(p, content) {
  try {
    fs.writeFileSync(p + '.tmp', content, 'utf-8');
    fs.renameSync(p + '.tmp', p);
    return true;
  } catch (e) {
    try { if (p && fs.existsSync(p + '.tmp')) fs.unlinkSync(p + '.tmp'); } catch (e2) {}
    return false;
  }
}

// 清理残留的未完成临时缓存（上次中断遗留），原文件不受影响；加载关键缓存前调用
function cleanupTmp(p) {
  try { const tmp = p + '.tmp'; if (tmp && fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (e) {}
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

// 任务总用时（秒）：未开始为 0；已结束取 endedAt；运行中取当前时间
function taskElapsed(t) {
  if (!t || !t.startedAt) return 0;
  const ended = t.status === 'done' || t.status === 'stopped' || t.status === 'error' || t.status === 'interrupted';
  const end = ended ? (t.endedAt || Date.now()) : Date.now();
  return Math.max(0, Math.round((end - t.startedAt) / 1000));
}
// 时间格式跟随实际用时：几十秒只显秒；1m1s / 10m10s / 1h0m10s（分秒含 0 亦保留）
function zhDuration(sec) {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  if (h > 0) return h + 'h' + m + 'm' + x + 's';
  if (m > 0) return m + 'm' + x + 's';
  return x + 's';
}
// ffmpeg 状态行的 elapsed 字段：6.x 后为 HH:MM:SS.mmm，部分版本为纯秒数 float，统一解析成秒
function parseElapsedSec(v) {
  const s = String(v).trim();
  const p = s.split(':');
  if (p.length === 3) {
    const sec = parseFloat(p[2]);
    return (parseInt(p[0], 10) || 0) * 3600 + (parseInt(p[1], 10) || 0) * 60 + (Number.isNaN(sec) ? 0 : sec);
  }
  const f = parseFloat(s);
  return Number.isNaN(f) ? NaN : f;
}
// ffmpeg 帧进度中文直译（与前端 frontend/task.js 的 liveLineText 保持一致）：
// 顺序：帧(总帧数)/q/大小/时间/码率/丢帧(为 0 不显示)/已用时/速度；体积换算 MB（KiB/1024，1 位小数）；
// elapsed（秒）格式化为时分秒。成片完成时将最后一行帧进度以此形式固化进任务日志
function zhLiveLine(kv) {
  const order = [['frame', '总帧数'], ['q', 'q'], ['size', '大小'], ['time', '时间'], ['bitrate', '码率'], ['drop', '丢帧'], ['elapsed', '已用时'], ['speed', '速度']];
  const parts = [];
  for (const [k, label] of order) {
    let v = kv[k];
    if (k === 'drop') { if (!(parseFloat(v) > 0)) continue; } // 丢帧为 0（或缺省）不显示
    if (v === undefined || v === null || v === '') continue;
    if (k === 'size') {
      const m = String(v).match(/^([\d.]+)\s*kib$/i);
      v = m ? (parseFloat(m[1]) / 1024).toFixed(1) + 'MB' : v;
    }
    if (k === 'elapsed') {
      const sec = parseElapsedSec(v);
      v = Number.isNaN(sec) ? String(v) : zhDuration(sec);
    }
    parts.push(label + '=' + v);
  }
  return parts.join(' ');
}

class Api {
  constructor(root, config, cachePath, videoCachePath, logCachePath, scriptsDir, clipIndexCachePath, taskStatePath, watermarkCachePath) {
    this.root = root;
    this.config = Object.assign({}, DEFAULT_CONFIG, config || {});
    this.cachePath = cachePath || '';
    this.videoCachePath = videoCachePath || '';
    this.logCachePath = logCachePath || '';
    this.scriptsDirFixed = scriptsDir || ''; // 脚本固定位置（main 进程传入 resources\Scripts），无需用户配置
    this.clipIndexCachePath = clipIndexCachePath || ''; // 成片名搜索索引缓存文件（Cache 子文件夹）
    this.taskStatePath = taskStatePath || '';           // 任务列表持久化文件（Cache 子文件夹）
    this.watermarkCachePath = watermarkCachePath || ''; // 水印主流水印固化缓存（Cache 子文件夹，随工作目录重置）
    this._persistTimer = null;                          // 任务持久化节流定时器
    this._clipIndex = null;        // Map<baseDir, {mtime, entries}>
    this._clipIndexRoot = '';
    this._clipIndexDirty = false;
    this._rebuildingClip = false; // 成片索引后台分批重建进行中标志（防并发重复触发）
    this.onScanProgress = null;   // 各扫描/重建环节进度回调（main 注入，推送主窗口渲染实时状态）
    this._precheckToken = 0;      // 预检测取消令牌：token 变化即中断旧探测（重置/换路径/手动取消）
    this._inlineProbing = 0;      // 行内预检测进行中计数：后台大探测遇其让路，保证用户操作优先
    // ffprobe 探测并发上限：保持低值，避免占用过多 CPU/IO 拖慢整机
    this.probeConcurrency = 4;
    this._videoCache = null;
    this._videoInfoCache = new Map();
    this._txtTree = null;
    this._txtTreeRoot = null;
    this._projectsCache = null;
    this._versionsCache = new Map();
    this._versionsFp = new Map(); // 各配置版本列表的「目录级指纹」，list_versions 入口核对自动失效
    this._scanCache = new Map();
    this._scanLoadedRoot = '';
    this._scanDirty = false;
    // 日志 txt 缓存：刷新配置时一次性收集全部日志，供日期分支/对应关系直接使用
    this._logCache = null;
    this._logCacheRoot = '';
    // 水印主流水印固化缓存：按 root 隔离加载，换工作目录时重置（_wmCacheLoadedRoot !== root 视为未加载）
    this._wmCache = null;
    this._wmEnabled = null; // 项目是否启用主流水印判定（root+'\u0000'+项目 -> true/false）
    this._wmCacheLoadedRoot = null;
    // 任务管理：实时捕获 ps1 输出并推送，支持多任务与停止排队任务
    this.tasks = new Map();
    this.taskSeq = 0;
    this.onTasksChanged = null; // 由 main 进程注入，用于向渲染进程推送任务快照
    this.onVersionsChanged = null; // 由 main 进程注入：配置文件写操作后广播，供前端即时自愈
    // 排队调度：同一时刻仅运行一个任务，其余按创建顺序排队（软件安排制作顺序，替代脚本抢互斥锁）
    this._taskQueue = [];
    this._runningTaskId = null;
    // 计划序号：新建任务入队时递增分配，暂停任务保留、启动任务移除、拖拽/置顶重排后重算。
    // UI 显示与「继续」插队位置都以此为准（暂停任务随队列推进自然前移，成为下一个后停住，新任务可越过）
    this._planSeq = 0;
  }

  get scriptsDir() {
    // 脚本固定于项目 resources\Scripts 子文件夹（打包/开发由 main 统一计算传入），不再读取 config.scripts_dir
    if (this.scriptsDirFixed) return this.scriptsDirFixed;
    let d = this.config.scripts_dir;
    if (!d || !fs.existsSync(d)) d = DEFAULT_CONFIG.scripts_dir;
    return d;
  }

  getRoot() { return this.root; }

  setRoot(newRoot) {
    // 相同路径（如启动时 ensureConfig 每次都调用 setRoot(同 root)）：仅同步内存，不清缓存——
    // 否则会清掉已保存的主流水印设置（watermark_cache 被误删，用户需重新设置）
    if (String(newRoot || '') === String(this.root || '')) {
      this.root = newRoot || '';
      return;
    }
    // 更换工作目录（即使重选相同目录）：水印主流缓存物理重置+清内存，
    // 与全缓存重置同语义——下次判定/刷新按新目录现场重新计算归属
    if (this.watermarkCachePath) { try { fs.unlinkSync(this.watermarkCachePath); } catch (e) {} }
    this._wmCache = null;
    this._wmCacheLoadedRoot = null;
    this.root = newRoot;
    this._videoCache = null;
    this._videoInfoCache.clear();
    this._invalidateCaches();
    // 成片索引随工作目录重置：清内存并取消进行中的后台重建，避免旧目录写入新缓存
    this._clipIndex = new Map();
    this._clipIndexRoot = '';
    this._clipIndexDirty = false;
    this._rebuildingClip = false;
    // 预检测随工作目录取消：旧路径的探测结果不写入新目录缓存
    this._precheckToken++;
  }

  // 手动取消进行中的预检测（前端"缩到后台"后点击 ✕、或再次重置/换路径时自动取消防重复）
  cancelPrecheck() {
    this._precheckToken++;
    return { ok: true };
  }

  // 清理项目/TXT 相关内存缓存（保存配置、重建列表时调用；不清持久化指纹缓存）
  _invalidateCaches() {
    this._txtTree = null;
    this._txtTreeRoot = null;
    this._projectsCache = null;
    this._versionsCache.clear();
    this._versionsFp.clear();
    this._logCache = null;
    this._logCacheRoot = '';
  }

  // 配置文件写操作统一收口：清缓存 + 广播，前端据此即时自愈版本/日期分支/侧栏徽章
  _markConfigModified() {
    this._invalidateCaches();
    if (typeof this.onVersionsChanged === 'function') { try { this.onVersionsChanged(); } catch (e) {} }
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

  // 扫描/重建环节状态上报：phase ∈ clear/walk/log/clip/mark/list/done，前端按阶段映射中文提示
  _emitScan(phase, done, total) {
    if (typeof this.onScanProgress !== 'function') return;
    try { this.onScanProgress({ phase: String(phase || ''), done: done || 0, total: total || 0 }); } catch (e) {}
  }

  listProjects(force = false) {
    if (force) {
      this._emitScan('clear');
      this._invalidateCaches();
      // 重建成片索引：后台分批重建（解析日志+写大缓存），不阻塞本次列表返回；搜索仍走按目录惰性命中
      this._rebuildClipIndexAsync();
      // 刷新配置时预填充水印缓存：缺失项目归属补算，已有条目不动（后台，不阻塞本次列表返回）
      try { setImmediate(() => { this._emitScan('mark'); this._warmWatermarkCache(); }); } catch (e) {}
    }
    if (!force && this._projectsCache) return this._projectsCache;
    this._emitScan('walk');
    this._collectLogFiles(); // 刷新配置时一并收集日志 txt 缓存
    this._emitScan('log');
    const data = this._buildProjectsData();
    this._emitScan('list');
    this._projectsCache = data;
    return data;
  }

  _buildProjectsData() {
    // 未配置工作路径：项目列表为空（连"复刻"虚拟项目也不显示），交给前端引导态
    if (!this.root) return [];
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
        // 最新版本无素材路径 → 空白配置（侧栏置顶排序依据）；带水印/排除仍视为空白
        let empty = false;
        if (versions.length) {
          try {
            const cfg = this.readConfig(versions[0].path);
            empty = !(cfg.folders || []).some((f) => String(f && typeof f === 'object' ? f.path : f).trim() !== '');
          } catch (e) {}
        }
        txts.push({ name, latest, count: versions.length, dup: dupNames.has(name), empty });
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
    if (this._versionsCache.has(key)) {
      // 自动失效：目录级指纹核对——成片夹/日期目录 mtime 变化（新增成片、外部 * 被挪走等）
      // 说明缓存树过期，失效重扫一次让版本列表自愈（排队任务渐进 -1/-2 无需手动刷新）
      if (this._versionsFp.get(key) === this._versionFingerprint(pdir, name)) {
        // 防御：命中缓存仍校验磁盘存在性（指纹秒级竞态等极端情况兜底），已删除/迁移的版本决不返回
        const cached = this._versionsCache.get(key);
        const alive = cached.filter((v) => { try { return fs.existsSync(v.path); } catch (e) { return false; } });
        if (alive.length === cached.length) return alive;
        this._versionsCache.set(key, alive);
        return alive;
      }
      this._invalidateCaches();
    }
    const versions = this._buildVersions(pdir, name);
    // 安全网：磁盘已不存在的版本（删除/迁移）一律过滤，缓存不再返回残留分支
    const alive = versions.filter((v) => { try { return fs.existsSync(v.path); } catch (e) { return false; } });
    // 每版本是否有可跳日志：配对锚点是「成片文件夹」
    //   - 成片内配置：仅当同一成片文件夹内存在对应日志才可跳
    //   - 外部(label含*)配置：当日有任何日志即可跳（多成片跳 -1、单成片跳唯一）
    const logs = this._collectLogFiles().files;
    alive.forEach((v) => { v.hasLog = this._versionHasLog(v, project, name, logs); });
    this._versionsCache.set(key, alive);
    this._versionsFp.set(key, this._versionFingerprint(pdir, name));
    return alive;
  }

  // 该配置所有相关目录（成片夹→日期→月份→项目，逐级上溯）的 mtime 摘要，作为版本列表自愈指纹。
  // mtime 对子目录/文件增减敏感：新增成片夹、外部 * 被挪走都会体现在父目录 mtime 上
  _versionFingerprint(pdir, name) {
    const pdirAbs = path.resolve(pdir);
    const target = name.toLowerCase();
    const dirs = new Set();
    for (const t of this._collectAllTxt()) {
      if (path.resolve(t.pdir) !== pdirAbs || t.name.toLowerCase() !== target) continue;
      let d = path.resolve(path.dirname(t.full));
      dirs.add(d);
      while (true) {
        const up = path.dirname(d);
        dirs.add(up);
        if (up === d || path.resolve(up) === pdirAbs) break;
        d = up;
      }
    }
    const arr = [...dirs].sort();
    const sig = arr.map((d) => { try { return fs.statSync(d).mtimeMs; } catch (e) { return null; } });
    return arr.join('|') + '\u0000' + sig.join(',');
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
      // 外部 * 配置若与任一成片文件夹正本内容完全一致，则被正体覆盖，不再显示（不一致时才同时显示）
      const outsideSrc = g.source;
      const outside = outsideSrc && !chengpian.some((c) => c.hash === outsideSrc.hash) ? [outsideSrc] : [];
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

  // 清理历史遗留的重复外部 * 配置：仅当「同项目+同配置名+同日期分支」有成片文件夹正本，
  // 且正本与外部 * 内容 hash 完全一致时才删除该外部 *。按 label 分组隔离，不影响其他日期分支。
  // commit=false 仅扫描报告；commit=true 物理删除（菜单「刷新配置列表」清理历史残留）
  cleanDuplicateStar(commit) {
    const groups = new Map(); // key = 项目\0配置名\0日期label -> { copies: [], sources: [] }
    for (const t of this._collectAllTxt()) {
      const label = relativeDateLabel(t.parts);
      if (!label) continue;
      const key = t.pdir + '\u0000' + t.name + '\u0000' + label;
      if (!groups.has(key)) groups.set(key, { copies: [], sources: [] });
      const g = groups.get(key);
      (isChengpianFile(t.parts) ? g.copies : g.sources).push(t);
    }
    const pending = [];
    const deleted = [];
    for (const g of groups.values()) {
      if (!g.copies.length) continue;
      for (const s of g.sources) {
        const dup = g.copies.some((c) => c.hash === s.hash);
        if (!dup) continue;
        pending.push(s.full);
        if (commit) {
          try { fs.unlinkSync(s.full); deleted.push(s.full); } catch (e) {}
        }
      }
    }
    if (commit && deleted.length) this._markConfigModified();
    return { ok: true, pending, deleted };
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
    this._markConfigModified();
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
    this._markConfigModified();
    return { ok: true, path: filePath };
  }

  // 新增空白配置：今日目录下创建无素材路径的 TXT（与保存为当日配置同目录规则）；
  // 项目启用主流水印时自动一并写上新配置的水印行
  newEmptyConfig(project) {
    try {
      if (!this.root || !project) return { ok: false, error: '未指定项目' };
      const pdir = path.resolve(path.join(this.root, project));
      if (!fs.existsSync(pdir) || !fs.statSync(pdir).isDirectory()) return { ok: false, error: '项目目录不存在：' + pdir };
      const now = new Date();
      const monthDir = String(now.getMonth() + 1) + '月';
      const dayDir = String(now.getMonth() + 1).padStart(2, '0') + String(now.getDate()).padStart(2, '0');
      const targetDir = path.join(pdir, monthDir, dayDir);
      fs.mkdirSync(targetDir, { recursive: true });
      // 默认文件名唯一：新建配置.txt → 新建配置 (1).txt → …
      let name = '新建配置';
      for (let i = 1; fs.existsSync(path.join(targetDir, name + '.txt')); i++) { name = '新建配置 (' + i + ')'; }
      const filePath = path.join(targetDir, name + '.txt');
      const wm = this.getProjectWatermark(project);
      const watermark = (wm && wm.ok && wm.enabled && wm.main) ? wm.main : '';
      fs.writeFileSync(filePath, this._rewriteText([], [], watermark), 'utf-8');
      this._markConfigModified();
      return { ok: true, path: filePath, name, watermark };
    } catch (e) { return { ok: false, error: String(e) }; }
  }

  // 移除日期分支（配置/日志 TXT）：
  // scope=txt 仅删当前文件；both 删除所在目录下全部 TXT（双模式配置+日志，成片保留）；folder 删除整个日期文件夹（含成片）
  // 删除后若目录为空则逐级向上清理空目录（以工作根为边界）
  removeBranch(filePath, scope) {
    try {
      if (!this.root) return { ok: false, error: '未配置工作路径' };
      filePath = path.resolve(filePath);
      const root = path.resolve(this.root);
      if (filePath !== root && !filePath.startsWith(root + path.sep)) return { ok: false, error: '目标不在工作路径内' };
      if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return { ok: false, error: '文件不存在：' + filePath };
      const dir = path.dirname(filePath);
      const mode = scope === 'folder' ? 'folder' : (scope === 'both' ? 'both' : 'txt');
      if (mode === 'folder') {
        if (dir.length <= root.length) return { ok: false, error: '不允许删除工作根目录' };
        this._rmtree(dir);
      } else {
        if (mode === 'both') {
          let entries = [];
          try { entries = fs.readdirSync(dir); } catch (e) {}
          for (const ent of entries) {
            const full = path.join(dir, String(ent));
            let st;
            try { st = fs.statSync(full); } catch (e) { continue; }
            if (st.isFile() && String(ent).toLowerCase().endsWith('.txt')) { try { fs.unlinkSync(full); } catch (e) {} }
          }
        } else {
          if (!filePath.toLowerCase().endsWith('.txt')) return { ok: false, error: '仅支持移除 TXT 分支' };
          fs.unlinkSync(filePath);
        }
      }
      // 逐级向上删除空目录：任一目录非空即停止；到工作根为止，不会越界
      let cur = mode === 'folder' ? path.dirname(dir) : dir;
      while (cur.length > root.length && cur !== root) {
        let entries = [];
        try { entries = fs.readdirSync(cur); } catch (e) { break; }
        if (entries.length) break;
        try { fs.rmdirSync(cur); } catch (e) { break; }
        cur = path.dirname(cur);
      }
      this._markConfigModified();
      return { ok: true };
    } catch (e) { return { ok: false, error: String(e) }; }
  }

  // 递归删除目录树（含内部全部文件与子目录）
  _rmtree(p) {
    let entries = [];
    try { entries = fs.readdirSync(p, { withFileTypes: true }); } catch (e) { return; }
    for (const ent of entries) {
      const full = path.join(p, ent.name);
      if (ent.isDirectory()) this._rmtree(full);
      else { try { fs.unlinkSync(full); } catch (e) {} }
    }
    try { fs.rmdirSync(p); } catch (e) {}
  }

  // 判断给定分支的所在目录是否存在「另一模式」的 TXT（配置↔日志；如 * 外部配置无对应日志）
  branchOtherTxt(filePath) {
    try {
      const dir = path.dirname(path.resolve(String(filePath || '')));
      if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return { ok: true, hasOther: false };
      const currentIsLog = LOG_NAME_RE.test(path.basename(filePath));
      let txts = [];
      try {
        txts = fs.readdirSync(dir).filter((n) => String(n).toLowerCase().endsWith('.txt'))
          .filter((n) => { let st; try { st = fs.statSync(path.join(dir, n)); } catch (e) { return false; } return st.isFile(); });
      } catch (e) {}
      const logs = txts.filter((n) => LOG_NAME_RE.test(n));
      const confs = txts.filter((n) => !LOG_NAME_RE.test(n));
      const hasOther = currentIsLog ? confs.length > 0 : logs.length > 0;
      return { ok: true, hasOther };
    } catch (e) { return { ok: false, error: String(e), hasOther: false }; }
  }

  _loadVideoCache() {
    if (this._videoCache !== null) return this._videoCache;
    let cache = {};
    const p = this.videoCachePath || '';
    try {
      // 清理上次中断遗留的未完成临时缓存（原子替换失败/取消时残留），原缓存文件不受影响
      if (p) { const tmp = p + '.tmp'; if (fs.existsSync(tmp)) { try { fs.unlinkSync(tmp); } catch (e) {} } }
      if (p && fs.existsSync(p)) {
        const data = JSON.parse(fs.readFileSync(p, 'utf-8'));
        if (data && typeof data === 'object' && !Array.isArray(data)) cache = data;
      }
    } catch (e) { cache = {}; }
    this._videoCache = cache;
    return cache;
  }

  // 文件写入时间 → 与 PowerShell 一致的 100ns ticks（自 0001-01-01）。
  // 必须用 bigint(mtimeNs) 精确换算：浮点 mtimeMs*10000 会超过 double 精确整数范围(2^53)丢低位精度，
  // 导致与脚本 Get-Item LastWriteTimeUtc.Ticks 比对永远不等，缓存全部失效重测
  _mtimeToTicks(videoPath) {
    try {
      const st = fs.statSync(videoPath, { bigint: true });
      return (st.mtimeNs / 100n) + 621355968000000000n;
    } catch (e) { return 0n; }
  }
  // 缓存命中/写入统一用字符串承载 ticks：JSON number 无法表达 19 位整数，会再次丢精度；
  // 脚本侧 PowerShell 的 string -eq long 会自动转换比较，仍能正确命中
  _ticksToStr(v) { return String(v == null ? '' : v); }

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

  // 并发限流执行器：同一时刻最多并发 limit 个，全部完成后按输入顺序返回结果数组。
// shouldStop 可选：每轮分发前调用，返回 true 即停止分发新任务（已分发者自然完成），并尽快 resolve 已完成部分
  _runWithLimit(items, worker, limit, shouldStop) {
    return new Promise((resolve) => {
      const n = items.length;
      if (n === 0) return resolve([]);
      const limitN = Math.max(1, limit | 0);
      const results = new Array(n);
      let i = 0, running = 0, done = 0, stopped = false;
      const pump = () => {
        if (!stopped && shouldStop && shouldStop()) stopped = true; // 中断
        while (running < limitN && i < n && !stopped) {
          const idx = i++;
          running++;
          Promise.resolve()
            .then(() => worker(items[idx], idx))
            .catch(() => undefined)
            .then((v) => { results[idx] = v; })
            .then(() => {
              running--; done++;
              if (done === n) resolve(results);
              else if (stopped && running === 0) resolve(results);
              else pump();
            });
        }
        if (stopped && running === 0) resolve(results);
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
    if (cached && this._ticksToStr(cached.LastWriteTime) === this._ticksToStr(this._mtimeToTicks(videoPath))) {
      const info = { valid: !!cached.Valid, duration: Number(cached.Duration) || 0, width: cached.Width || 0, height: cached.Height || 0 };
      this._videoInfoCache.set(videoPath, info);
      return info;
    }
    if (cached) delete cache[videoPath]; // 指纹变化，丢弃旧缓存交由重新探测
    return null;
  }

  // 并发探测缺失缓存的视频并写回缓存；返回 path -> info 映射
  // onProbe(done) 可选：每完成一个视频（含缓存命中）回报累计计数
  async _resolveVideoInfos(videoPaths, onProbe) {
    const result = new Map();
    const needProbe = [];
    let doneCount = 0;
    const tick = () => { doneCount++; if (onProbe) { try { onProbe(doneCount); } catch (e) {} } };
    for (const p of videoPaths) {
      const c = this._fetchCachedVideoInfo(p);
      if (c) { result.set(p, c); tick(); }
      else needProbe.push(p);
    }
    const infos = await this._runWithLimit(needProbe, (p) => this._probeVideoAsync(p).then((info) => { tick(); return info; }), this.probeConcurrency);
    const cache = this._loadVideoCache();
    for (let i = 0; i < needProbe.length; i++) {
      const p = needProbe[i];
      const info = infos[i] || { valid: false, duration: 0, width: 0, height: 0 };
      cache[p] = { LastWriteTime: this._ticksToStr(this._mtimeToTicks(p)), Duration: info.duration, Valid: info.valid, Width: info.width, Height: info.height };
      this._videoInfoCache.set(p, info);
      result.set(p, info);
    }
    return result;
  }

  // 预检测缓存落盘：先写临时文件再原子替换（rename），完成才覆盖原缓存；
  // 写入/替换失败时清理临时文件，原缓存文件保持有效可复用
  _saveVideoCache() {
    try {
      const p = this.videoCachePath || '';
      if (!p) return;
      const tmp = p + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this._videoCache), 'utf-8');
      fs.renameSync(tmp, p); // 同盘原子替换；目标被占用等异常时原文件仍在
    } catch (e) {
      try { const p = (this.videoCachePath || '') + '.tmp'; if (p && fs.existsSync(p)) fs.unlinkSync(p); } catch (e2) {}
    }
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

  // 批量解析 .lnk 快捷方式目标（与视频批量脚本语义一致）：返回 { lnkPath: targetPath }；
  // 解析失败/失效返回空对象降级，不影响预检测其余流程。
  // 实现：临时 .ps1 + pwsh -File；JSON 经 base64 进出（argv/控制台代码页会破坏中文，base64 全 ASCII 免疫）
  _resolveShortcutTargets(paths) {
    if (!paths || !paths.length) return {};
    const { spawnSync } = require('child_process');
    const scriptLines = [
      '$ErrorActionPreference = "SilentlyContinue"',
      '$json = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($args[0]))',
      '$l = ConvertFrom-Json -InputObject $json',
      '$o = @{}',
      'foreach ($p in $l) {',
      '  try {',
      '    if (Test-Path -LiteralPath $p -PathType Leaf) {',
      '      $sh = New-Object -ComObject WScript.Shell',
      '      $sc = $sh.CreateShortcut($p)',
      '      if ($sc.TargetPath) { $o[$p] = $sc.TargetPath.Trim() }',
      '    }',
      '  } catch {}',
      '}',
      '$out = $o | ConvertTo-Json -Compress',
      '[Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($out))',
    ].join('\n');
    const inputB64 = Buffer.from(JSON.stringify(paths), 'utf8').toString('base64');
    const tmp = require('path').join(process.env.TEMP || '.', 'lnk_resolve_' + process.pid + '_' + Date.now() + '.ps1');
    try {
      fs.writeFileSync(tmp, scriptLines, 'utf8');
      try {
        const r = spawnSync('pwsh.exe', ['-NoProfile', '-NonInteractive', '-File', tmp, inputB64],
          { encoding: 'utf8', windowsHide: true, timeout: 10000 });
        if (r.error || r.status !== 0 || !r.stdout) return {};
        const json = Buffer.from(String(r.stdout).trim(), 'base64').toString('utf8');
        const map = JSON.parse(json);
        return map && typeof map === 'object' ? map : {};
      } finally {
        try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (e2) {}
      }
    } catch (e) {
      try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (e2) {}
      return {};
    }
  }

  async _precheckFolder(dir, excludes, nonround) {
    // 第一遍：仅同步收集候选视频，按"根目录 + 各子目录(+快捷方式目标)"分组，暂不探测
    const groups = [];
    try {
      const items = fs.readdirSync(dir, { withFileTypes: true });
      const rootVideos = [];
      const subDirs = [];
      const lnks = [];
      for (const ent of items) {
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) subDirs.push(full);
        else if (ent.isFile() && path.extname(ent.name).toLowerCase() === '.lnk') lnks.push(full);
        else if (ent.isFile() && VIDEO_EXTS.has(path.extname(ent.name).toLowerCase())) rootVideos.push(full);
      }
      const rootCands = [];
      for (const v of rootVideos) if (!this._isExcludedPath(v, excludes)) rootCands.push(v);

      // 快捷方式（与批量脚本一致）：解析目标，目录→独立组递归收集；视频文件→并入根组；失效/非视频→跳过
      let rootCandsExtra = null;
      const lnkGroups = [];
      if (lnks.length) {
        const map = this._resolveShortcutTargets(lnks);
        if (map) {
          const extra = [];
          for (const l of lnks) {
            const t = map[l];
            if (!t) continue;
            let st;
            try { st = fs.statSync(t); } catch (e) { continue; }
            if (st.isDirectory()) {
              const cands = [];
              for (const f of walkFiles(t)) {
                if (!VIDEO_EXTS.has(path.extname(f).toLowerCase())) continue;
                if (this._isExcludedPath(f, excludes)) continue;
                cands.push(f);
              }
              lnkGroups.push(cands);
            } else if (st.isFile() && VIDEO_EXTS.has(path.extname(t).toLowerCase())) {
              if (!this._isExcludedPath(t, excludes)) extra.push(t);
            }
          }
          if (extra.length) rootCandsExtra = extra;
        }
      }
      if (rootCandsExtra) rootCands.push.apply(rootCands, rootCandsExtra);
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
      for (const g of lnkGroups) groups.push(g);
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
          if (s.total === 0) r = { status: 'warn', text: '无合格视频', total: 0, groupCount: 0, exists: true };
          else {
            const grouped = s.groupCount > 1;
            const text = grouped ? `${s.total}个视频，共${s.groupCount}组` : `${s.total} 个视频`;
            r = { status: grouped ? 'group' : 'ok', text, total: s.total, groupCount: s.groupCount, exists: true };
          }
        } else if (st.isFile()) {
          if (VIDEO_EXTS.has(path.extname(key).toLowerCase())) {
            let info = this._fetchCachedVideoInfo(key);
            if (!info) {
              // 行内预检测优先：探测期间后台大探测遇 _inlineProbing>0 会主动让路
              this._inlineProbing++;
              try {
                info = await this._probeVideoAsync(key);
                // 新探测结果写入内存缓存（不落盘，后台下次保存时一并合并；避免两种探测互相覆盖）
                const cc = this._loadVideoCache();
                cc[key] = { LastWriteTime: this._ticksToStr(this._mtimeToTicks(key)), Duration: info.duration, Valid: info.valid, Width: info.width, Height: info.height };
                this._videoInfoCache.set(key, info);
              } finally { this._inlineProbing--; }
            }
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
  // 收集所有配置指向的视频候选：跨配置路径去重、目录递归收集、跳过非视频扩展名
  _gatherAllVideos() {
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
    const seen = new Set();
    const allVideos = [];
    for (const p of pathSet) {
      let st;
      try { st = fs.statSync(p); } catch (e) { continue; }
      const cands = [];
      if (st.isDirectory()) {
        for (const f of walkFiles(p)) if (VIDEO_EXTS.has(path.extname(f).toLowerCase())) cands.push(f);
        // 与单路径预检测一致：跟随根目录下 .lnk 快捷方式（目录→收集目标下视频；视频文件→直接计入）
        let items;
        try { items = fs.readdirSync(p, { withFileTypes: true }); } catch (e) { items = []; }
        const lnks = [];
        for (const ent of items) if (ent.isFile() && path.extname(ent.name).toLowerCase() === '.lnk') lnks.push(path.join(p, ent.name));
        if (lnks.length) {
          const map = this._resolveShortcutTargets(lnks);
          if (map) for (const l of lnks) {
            const t = map[l];
            if (!t) continue;
            let ts;
            try { ts = fs.statSync(t); } catch (e) { continue; }
            if (ts.isDirectory()) {
              for (const f of walkFiles(t)) if (VIDEO_EXTS.has(path.extname(f).toLowerCase())) cands.push(f);
            } else if (ts.isFile() && VIDEO_EXTS.has(path.extname(t).toLowerCase())) cands.push(t);
          }
        }
      } else if (st.isFile() && VIDEO_EXTS.has(path.extname(p).toLowerCase())) cands.push(p);
      for (const f of cands) if (!seen.has(f)) { seen.add(f); allVideos.push(f); }
    }
    return allVideos;
  }

  async resetPrecheck(onProgress) {
    this._videoCache = {};
    this._videoInfoCache = new Map();
    // 不在开始时删除物理缓存：探测全部完成后才经 _saveVideoCache 原子替换覆盖原缓存；
    // 若中途取消/异常，原缓存文件保持有效可复用，未完成的探测结果不落盘。

    // 收集所有配置指向的素材路径（跨路径去重）
    const allVideos = this._gatherAllVideos();

    const report = (s) => { if (onProgress) { try { onProgress(s); } catch (e) {} } };
    const total = allVideos.length;
    let probed = 0, valid = 0;
    const cache = this._loadVideoCache();
    const token = ++this._precheckToken; // 本次探测的令牌：作废任何更早的后台探测
    await this._runWithLimit(allVideos, async (f) => {
      // 行内预检测优先：后台探测遇用户操作让路（每批轮询，短暂让出 IO）
      if (this._inlineProbing > 0) await new Promise((r) => setTimeout(r, 80));
      const info = await this._probeVideoAsync(f);
      cache[f] = { LastWriteTime: this._ticksToStr(this._mtimeToTicks(f)), Duration: info.duration, Valid: info.valid, Width: info.width, Height: info.height };
      this._videoInfoCache.set(f, info);
      probed++;
      if (info.valid) valid++;
      report({ done: probed, total });
    }, this.probeConcurrency, () => token !== this._precheckToken);

    const cancelled = token !== this._precheckToken;
    if (cancelled) { // 取消/中断：丢弃本次内存探测结果，下次从原缓存文件重新加载（不覆盖原文件）
      this._videoCache = null;
      this._videoInfoCache = new Map();
    } else this._saveVideoCache(); // 全部完成才原子覆盖原缓存；取消/中断时保留原文件
    report({ done: probed, total, finished: true, cancelled });
    return { ok: true, total, valid, invalid: total - probed, cancelled };
  }

  // 仅刷新预缓存：不删缓存、不重置，只对「缺失或 mtime 已变」的视频重新探测更新；
  // 命中（缓存有效）的路径直接跳过，进度按全量候选回报（起始即跳过数）
  async refreshPrecache(onProgress) {
    const report = (s) => { if (onProgress) { try { onProgress(s); } catch (e) {} } };
    const allVideos = this._gatherAllVideos();
    const total = allVideos.length;
    const cache = this._loadVideoCache();
    const toProbe = [];
    for (const f of allVideos) {
      const c = cache[f];
      const ticks = this._ticksToStr(this._mtimeToTicks(f));
      if (c && String(c.LastWriteTime) === ticks) continue; // 已缓存且文件未变：跳过
      toProbe.push(f);
    }
    const base = total - toProbe.length; // 进度起点 = 已跳过数
    const token = ++this._precheckToken; // 作废旧探测，保证只跑本次
    let probed = 0, valid = 0;
    await this._runWithLimit(toProbe, async (f) => {
      // 行内预检测优先：与全量重置同一让路策略
      if (this._inlineProbing > 0) await new Promise((r) => setTimeout(r, 80));
      const info = await this._probeVideoAsync(f);
      cache[f] = { LastWriteTime: this._ticksToStr(this._mtimeToTicks(f)), Duration: info.duration, Valid: info.valid, Width: info.width, Height: info.height };
      this._videoInfoCache.set(f, info);
      probed++;
      if (info.valid) valid++;
      report({ done: base + probed, total });
    }, this.probeConcurrency, () => token !== this._precheckToken);

    const cancelled = token !== this._precheckToken;
    if (cancelled) { // 取消/中断：丢弃本次内存增量，下次从原缓存文件重新加载（不覆盖原文件）
      this._videoCache = null;
      this._videoInfoCache = new Map();
    } else this._saveVideoCache(); // 已完成的增量结果才原子覆盖原缓存；取消/中断保留原文件
    report({ done: base + probed, total, finished: true, cancelled });
    return { ok: true, total, updated: probed, valid, cancelled };
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
    const all = this._clipEntriesFor(path.dirname(path.resolve(versionPath)));
    const target = String(name == null ? '' : name).trim();
    if (!target) return all;
    return all.filter((e) => this._configNameFromLog(e.log_path) === target);
  }

  // ── 成片名搜索索引：仅索引日志解析出的成片条目（video/clips/watermark/log_path）。
  //    以「配置目录」为单位按目录 mtime 失效，命中直接读内存，未命中重扫该目录；
  //    有变更时落盘到 Cache\clip_cache.json，冷启动直接复用，避免每次搜索全量读盘解析。
  _loadClipIndex() {
    if (this._clipIndex && this._clipIndexRoot === this.root) return;
    this._clipIndexRoot = this.root;
    this._clipIndex = new Map();
    if (!this.clipIndexCachePath) return;
    cleanupTmp(this.clipIndexCachePath); // 清理上次中断遗留的未完成临时索引
    try {
      const data = JSON.parse(fs.readFileSync(this.clipIndexCachePath, 'utf-8'));
      if (data && data.root === this.root && data.dirs && typeof data.dirs === 'object') {
        for (const k in data.dirs) {
          const v = data.dirs[k];
          if (v && typeof v.mtime === 'number' && Array.isArray(v.entries)) this._clipIndex.set(k, { mtime: v.mtime, entries: v.entries });
        }
      }
    } catch (e) {}
  }

  _saveClipIndex() {
    if (!this.clipIndexCachePath || !this._clipIndexDirty) return;
    const dirs = {};
    this._clipIndex.forEach((v, k) => { if (Array.isArray(v.entries)) dirs[k] = { mtime: v.mtime, entries: v.entries }; });
    // 原子写：重建/渐进落盘只认完整结果，中断不写坏原索引
    if (atomicWrite(this.clipIndexCachePath, JSON.stringify({ root: this.root, dirs }))) this._clipIndexDirty = false;
  }

  // 某配置目录的成片条目：目录 mtime 未变直接命中索引，否则重扫该目录并重建索引条目
  _clipEntriesFor(baseDir) {
    this._loadClipIndex();
    let mtime = 0;
    try { mtime = fs.statSync(baseDir).mtimeMs; } catch (e) {}
    const hit = this._clipIndex.get(baseDir);
    if (hit && hit.mtime === mtime) return hit.entries;
    const entries = this._collectLogEntries(baseDir);
    this._clipIndex.set(baseDir, { mtime, entries });
    this._clipIndexDirty = true;
    this._saveClipIndex();
    return entries;
  }

  // 重新检测配置时全量重建索引并落盘（后续搜索/日志列表直接命中，无需再逐目录解析）
  // onStep(done,total)：每批目录解析完回调一次（供实时进度），末批后落盘
  _rebuildClipIndex(onStep) {
    this._loadClipIndex();
    this._clipIndex.clear();
    const dirs = new Set();
    for (const t of this._collectAllTxt()) dirs.add(path.dirname(t.full));
    const list = [...dirs];
    const total = list.length;
    const tick = (done) => { if (typeof onStep === 'function') { try { onStep(done, total); } catch (e) {} } };
    const step = () => {
      if (!this._rebuildingClip) { this._saveClipIndex(); return; } // 换工作目录等取消信号：停止并落盘当前进度
      const batch = list.splice(0, 20);
      for (const d of batch) {
        let entries;
        try { entries = this._collectLogEntries(d); } catch (e) { entries = []; }
        let mtime = 0;
        try { mtime = fs.statSync(d).mtimeMs; } catch (e) {}
        this._clipIndex.set(d, { mtime, entries });
        this._clipIndexDirty = true;
      }
      tick(total - list.length);
      if (list.length > 0) setImmediate(step);
      else {
        this._saveClipIndex();
        this._rebuildingClip = false;
        this._emitScan('done');
      }
    };
    setImmediate(step);
  }

  // 成片索引后台重建入口：防并发重复触发；每 20 目录让出一次事件循环，避免长时间阻塞主线程
  _rebuildClipIndexAsync() {
    if (this._rebuildingClip) return;
    this._rebuildingClip = true;
    this._rebuildClipIndex((done, total) => this._emitScan('clip', done, total));
  }

  _logsForTxt(txtFull) {
    return this._clipEntriesFor(path.dirname(txtFull));
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
        // 日志条目仅归属其同名配置（同日期目录下多配置并存时互不串扰）
        const cfgName = this._configNameFromLog(e.log_path);
        if (!cfgName) continue;
        let tName = t.name;
        if (tName.charAt(0) === '*') tName = tName.slice(1).trim(); // 当日外部 * 配置：按去前缀名匹配
        if (cfgName !== tName) continue;
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
    // 使用刷新时写入的日志缓存，按项目 + 配置名过滤（不限定单一日期，展示该配置的全部日志日期分支）
    // 每条日志附加所属配置版本 label（同成片文件夹的序号化 -N/正本优先，否则当日外部 *），
    // 使日志分支序号与配置版本序号一一对应
    const project = this._projectOf(fromPath);
    const target = String(configName == null ? '' : configName).trim();
    const versions = this.listVersions(project, target);
    const files = this._collectLogFiles().files
      .filter((f) => f.project === project && (!target || f.config === target))
      .map((f) => {
        const d = f.date;
        let label = null;
        for (const v of versions) {
          if (v.isExternal) continue;
          if (String(v.label || '').slice(0, 4) === d && path.dirname(v.path) === path.dirname(f.path)) { label = v.label; break; }
        }
        if (!label) {
          for (const v of versions) {
            if (v.isExternal && String(v.label || '').slice(0, 4) === d) { label = v.label; break; }
          }
        }
        return { path: f.path, name: f.name, date: f.date, label: label || f.date };
      });
    files.sort((a, b) => (b.date.localeCompare(a.date) || a.name.localeCompare(b.name)));
    return files;
  }

  // 日志对应的复刻输出目录：取日志路径中首个日期段（月份/MMdd）之前为基址，
  // 拼接 <月份>/<MMdd>/<模式目录>；返回复刻目录及命中的复刻产物（无匹配文件时仍给目录，供"打开文件夹"使用）
  findReplicaOutput(logPath, videoName) {
    const out = { originalDir: '', replicaDir: '', replicaFile: '' };
    if (!logPath) return out;
    const abs = path.resolve(String(logPath));
    out.originalDir = path.dirname(abs);
    const parts = abs.split(path.sep);
    let idx = parts.findIndex((p) => /^\d+月$/.test(p));
    if (idx < 0) idx = parts.findIndex((p) => /^\d{4}$/.test(p));
    if (idx < 0) return out;
    const base = parts.slice(0, idx).join(path.sep);
    const month = parts[idx];
    const day = parts[idx + 1] && /^\d{4}$/.test(parts[idx + 1]) ? parts[idx + 1] : '';
    const root = day ? path.join(base, month, day) : path.join(base, month);
    for (const mode of ['去重复刻', '原片复刻']) {
      const dir = path.join(root, mode);
      if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) continue;
      out.replicaDir = dir;
      try {
        const baseName = String(videoName || '').replace(/\.mp4$/i, '').toLowerCase();
        if (baseName) {
          const hit = fs.readdirSync(dir).find((n) => /\.mp4$/i.test(n) && (n.toLowerCase().replace(/\.mp4$/i, '') === baseName || n.toLowerCase().replace(/\.mp4$/i, '').replace(/^\d{6}改-/, '') === baseName));
          if (hit) out.replicaFile = path.join(dir, hit);
        }
      } catch (e) {}
      break;
    }
    return out;
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
  _createTask(type, title, scriptPath, env, srcPath) {
    const id = 'task_' + (++this.taskSeq) + '_' + Date.now().toString(36);
    const task = {
      id, type, title, script: scriptPath, env: Object.assign({}, env),
      pid: null, status: 'queued', lockState: 'unknown', progress: { current: 0, total: 0 },
      failReason: '', log: [],
      createdAt: Date.now(), startedAt: null, endedAt: null, _stopRequested: false,
      planPos: 0,
      outDir: this._taskOutDir(type, srcPath, env),
      groupDate: this._taskGroupDate(type, env, Date.now()), // 业务归属日 MMDD：凌晨0-4点完成/提交归前一天（仅前端排序使用，不展示）
    };
    this.tasks.set(id, task);
    this._emitTasks();
    return task;
  }

  // 任务成片文件夹：批量任务按提交时刻+配置名精确推算（与脚本实际输出目录一致）；
  // 其余类型取源 TXT 所在目录下以「成片」结尾的子目录，找不到则回退源目录
  _taskOutDir(type, srcPath, env) {
    if (type === 'batch') {
      const detail = this._batchTaskOutDetail({ env: env || {}, createdAt: Date.now() });
      if (detail && detail.outDir) return detail.outDir;
      return '';
    }
    const d = path.dirname(path.resolve(srcPath));
    try {
      for (const e of fs.readdirSync(d)) {
        if (String(e).endsWith('成片')) {
          const f = path.join(d, e);
          if (fs.statSync(f).isDirectory()) return f;
        }
      }
    } catch (e2) {}
    return d;
  }

  // 业务归属日（MMDD）：按任务提交/创建时刻，凌晨 0-4 点归入前一天（跨日任务视同昨天产出）。
  // 批量任务优先取提交时刻（BATCH_SUBMIT_TS），缺失（旧版本创建的任务）则用创建时刻兜底；
  // 仅用于前端排序，不展示。
  _taskGroupDate(type, env, createdAt) {
    if (type !== 'batch') return '';
    const ts = Number(env && env.BATCH_SUBMIT_TS) || Number(env && env.REPLICA_SUBMIT_TS) || Number(createdAt) || Date.now();
    const d = new Date(ts);
    if (d.getHours() < 4) d.setDate(d.getDate() - 1);
    const p = (n) => (n < 10 ? '0' : '') + n;
    return p(d.getMonth() + 1) + p(d.getDate());
  }

  // 排队执行：无运行任务则立即启动，否则进入队列（软件安排制作顺序）
  _enqueueTask(task) {
    // 分配计划序号（新建任务/恢复任务都经由此处或 resumeTask 分配）
    if (!task.planPos) task.planPos = ++this._planSeq;
    if (!this._runningTaskId) {
      this._runningTaskId = task.id;
      task.status = 'running';
      task.log.push('[开始运行]');
      this._emitTasks();
      this._spawnPowerShell(task.script, task.env, task);
    } else {
      task.status = 'queued';
      task.log.push('[已加入执行队列，等待前序任务完成]');
      this._taskQueue.push(task.id);
      this._emitTasks();
    }
    return task;
  }

  // 当前任务结束（正常/失败/停止）后启动队列中的下一个任务
  _startNextQueued() {
    while (this._taskQueue.length) {
      const id = this._taskQueue.shift();
      const t = this.tasks.get(id);
      if (!t || t.status === 'stopped' || t._cancelled) continue;
      this._runningTaskId = id;
      t.status = 'running';
      t.log.push('[前序任务完成，开始运行本任务]');
      this._emitTasks();
      this._spawnPowerShell(t.script, t.env, t);
      return;
    }
  }

  // 置顶排队任务：让它成为下一个执行的任务（软件安排顺序）
  pinTask(id) {
    const t = this.tasks.get(id);
    if (!t) return { ok: false, error: '任务不存在' };
    if (t.status !== 'queued') return { ok: false, error: '仅排队中的任务可置顶' };
    const i = this._taskQueue.indexOf(id);
    if (i > 0) { this._taskQueue.splice(i, 1); this._taskQueue.unshift(id); }
    // 重算队列计划序号，使显示顺序与执行顺序一致
    this._taskQueue.forEach((qid, k) => { this.tasks.get(qid).planPos = k + 1; });
    t.log.push('[已置顶，成为下一个执行的任务]');
    this._emitTasks();
    return { ok: true };
  }

  // 手动重排待运行顺序（拖拽排序）：ids 为「排队+暂停」任务的完整混合序列（不含运行中/已结束）
  //   按 ids 顺序重建执行队列并重算所有待运行任务的计划序号；暂停任务的冻结顺位（resumeIdx）同步刷新
  reorderTasks(ids) {
    if (!Array.isArray(ids)) return { ok: false, error: '参数无效' };
    const waiting = [];
    this.tasks.forEach((t, id) => {
      if (t.status === 'queued' || t.status === 'paused') waiting.push(id);
    });
    const cur = new Set(waiting);
    const given = new Set(ids.filter((id) => cur.has(id)));
    if (cur.size !== given.size || ids.length !== waiting.length) return { ok: false, error: '排序参数与待运行任务不一致' };
    for (const id of ids) if (!cur.has(id)) return { ok: false, error: '排序参数包含不可排序的任务' };
    const queue = [];
    let ord = 0;
    for (const id of ids) {
      const t = this.tasks.get(id);
      t.planPos = ++ord;
      // 暂停任务：前方待运行任务数 = 它在 ids 序列中的位置，作为新的冻结顺位
      if (t.status === 'paused') t.resumeIdx = ord - 1;
      else if (t.status === 'queued') queue.push(id);
    }
    this._taskQueue = queue;
    this._emitTasks();
    return { ok: true };
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
    this.tasks.forEach((t) => {
      // 首次进入运行态时打点（惰性：覆盖直接启动/队列轮到/恢复启动所有路径）
      if (t.status === 'running' && !t.startedAt) t.startedAt = Date.now();
      list.push({
        id: t.id, type: t.type, title: t.title, script: t.script, pid: t.pid,
        status: t.status, lockState: t.lockState, paused: !!t.paused,
        progress: t.progress || { current: 0, total: 0 }, failReason: t.failReason || '',
        createdAt: t.createdAt, endedAt: t.endedAt, outDir: t.outDir || '',
        groupDate: typeof t.groupDate === 'string' ? t.groupDate : '', // 业务归属日（前端排序用，不展示）
        // 任务总用时（秒）：首次开始至今的墙钟时间；已结束任务取结束时间
        elapsedSec: taskElapsed(t),
        // 计划序号：排队任务=队列第几位；暂停任务=冻结的显示顺位；显示与恢复插队都以此为准
        pos: t.planPos || 0,
        resumeIdx: typeof t.resumeIdx === 'number' ? t.resumeIdx : null,
        queueTotal: this._taskQueue.length,
        log: t.log.slice(-500),
      });
    });
    // 展示排序：运行中 → 待运行区 → 已结束（按创建时间）。
    // 待运行区显示顺序：按「恢复所有暂停任务后的最终队列顺序」呈现——
    // 排队任务保持执行队列次序，暂停任务按冻结顺位（resumeIdx）插入到对应位置，
    // 与「暂停时几号、继续后几号」的显示顺位完全一致。
    const ordered = [];
    this._taskQueue.forEach((qid) => { if (this.tasks.get(qid)) ordered.push(qid); });
    list.filter((t) => t.status === 'paused')
      .sort((x, y) => (x.resumeIdx ?? 1e9) - (y.resumeIdx ?? 1e9))
      .forEach((p) => { ordered.splice(Math.min(p.resumeIdx ?? ordered.length, ordered.length), 0, p.id); });
    const orderIdx = new Map();
    ordered.forEach((id, k) => orderIdx.set(id, k));
    list.sort((a, b) => {
      const rank = (s) => (s === 'running' ? 0 : s === 'queued' || s === 'paused' ? 1 : 2);
      const ra = rank(a.status), rb = rank(b.status);
      if (ra !== rb) return ra - rb;
      if (ra === 1) {
        const ia = orderIdx.has(a.id) ? orderIdx.get(a.id) : 1e9;
        const ib = orderIdx.has(b.id) ? orderIdx.get(b.id) : 1e9;
        if (ia !== ib) return ia - ib;
        return a.createdAt - b.createdAt;
      }
      return a.createdAt - b.createdAt;
    });
    // 待运行区显示序号：仅排队任务连续编号（暂停任务显示圆点、不占号，不影响队伍正常序号展示）
    let waitN = 0;
    for (const it of list) {
      if (it.status === 'queued') { waitN++; it.displayPos = waitN; }
    }
    return list;
  }

  _emitTasks() {
  if (this.onTasksChanged) this.onTasksChanged(this.snapshotTasks());
  this._schedulePersist();
  }

  // ── 任务列表持久化：状态变化节流写盘，回收/正常退出时保证落盘；重启后保留任务直到手动清空 ──
  _schedulePersist() {
    if (this._persistTimer || !this.taskStatePath) return;
    this._persistTimer = setTimeout(() => { this._persistTimer = null; this.persistTasks(); }, 200);
  }
  persistTasks() {
    if (!this.taskStatePath) return;
    if (this._persistTimer) { clearTimeout(this._persistTimer); this._persistTimer = null; }
    const data = {
      planSeq: this._planSeq,
      tasks: [...this.tasks.values()].map((t) => ({
        id: t.id, type: t.type, title: t.title, script: t.script, env: t.env || {},
        status: t.status, lockState: t.lockState, progress: t.progress || { current: 0, total: 0 },
        failReason: t.failReason || '', paused: !!t.paused,
        createdAt: t.createdAt, startedAt: t.startedAt || null, endedAt: t.endedAt, planPos: t.planPos || 0,
        resumeIdx: typeof t.resumeIdx === 'number' ? t.resumeIdx : null,
        outDir: t.outDir || '', log: (t.log || []).slice(-500), _stopRequested: !!t._stopRequested,
        groupDate: typeof t.groupDate === 'string' ? t.groupDate : '',
      })),
    };
    // 原子写：任务列表高频落盘，写坏会导致整批任务记录丢失
    atomicWrite(this.taskStatePath, JSON.stringify(data));
  }
  // 启动时恢复上次会话的任务列表（退出前已做 running→interrupted、queued→paused 转换）
  restoreTasks() {
    try {
      if (!this.taskStatePath || !fs.existsSync(this.taskStatePath)) return;
      cleanupTmp(this.taskStatePath); // 清理上次中断遗留的未完成临时状态文件
      const data = JSON.parse(fs.readFileSync(this.taskStatePath, 'utf-8'));
      if (!data || !Array.isArray(data.tasks)) return;
      for (const t of data.tasks) {
        if (!t || typeof t.id !== 'string') continue;
        if (this.tasks.has(t.id)) continue;
        if (t.status !== 'paused' && t.status !== 'done' && t.status !== 'stopped' && t.status !== 'error' && t.status !== 'interrupted') continue;
        const restored = Object.assign({}, t, { env: t.env || {}, pid: null, progress: t.progress || { current: 0, total: 0 }, log: Array.isArray(t.log) ? t.log : [] });
        // 批量任务缺归属日时按提交/创建时刻补算（凌晨0-4点归前一天）
        if (restored.type === 'batch' && typeof restored.groupDate !== 'string') restored.groupDate = this._taskGroupDate(restored.type, restored.env, restored.createdAt);
        // 批量任务的成片文件夹：记录指向有效目录（含人工迁移/手工修正后）则保留；
        // 失效时才按提交时刻推算 + 当天/前一天回退查找（旧记录 outDir 可能指向无关/已删除目录，
        // 凌晨内容人工归入前一天的场景靠回退命中）
        if (restored.type === 'batch') {
          const live = restored.outDir && fs.existsSync(restored.outDir);
          if (!live) {
            const detail = this._batchTaskOutDetail(restored, true);
            if (detail && detail.outDir) restored.outDir = detail.outDir;
          }
        }
        this.tasks.set(restored.id, restored);
        const n = parseInt(String(t.id).replace(/\D/g, ''), 10);
        if (n > this.taskSeq) this.taskSeq = n;
      }
      if (data.planSeq > this._planSeq) this._planSeq = data.planSeq;
      if (this.tasks.size) this._emitTasks();
    } catch (e) {}
  }
  // 退出前收尾：运行中→已中断，排队→暂停（后由 persistTasks 落盘）
  shutdownTasks() {
    const now = Date.now();
    let changed = false;
    for (const t of this.tasks.values()) {
      if (t.status === 'running') {
        t.status = 'interrupted'; t.paused = false; t.endedAt = now;
        t.log.push('[应用退出，任务已中断]'); changed = true;
      } else if (t.status === 'queued') {
        t.status = 'paused'; t.paused = true;
        t.log.push('[应用退出，排队任务转为暂停]'); changed = true;
      }
    }
    this._taskQueue = [];
    this._runningTaskId = null;
    if (changed) this._emitTasks();
    this.persistTasks();
    return { ok: true };
  }
  hasRunningTask() {
    for (const t of this.tasks.values()) if (t.status === 'running') return true;
    return false;
  }
  // 已结束任务单行删除（运行/排队/暂停中的任务不可删；连带删除任务标记文件）
  clearTask(id) {
    const t = this.tasks.get(id);
    if (!t) return { ok: false, error: '任务不存在' };
    if (t.status === 'running' || t.status === 'queued' || t.status === 'paused') return { ok: false, error: '进行中的任务不能删除' };
    this.tasks.delete(id);
    this._removeMarker(t);
    this._emitTasks();
    return { ok: true };
  }
  // 全部继续：所有暂停任务按冻结顺位依次排入执行队列，无运行任务则立即启动
  resumeAllTasks() {
    const paused = [...this.tasks.values()].filter((t) => t.status === 'paused')
      .sort((a, b) => (a.resumeIdx ?? 1e9) - (b.resumeIdx ?? 1e9));
    if (!paused.length) return { ok: false, error: '没有暂停的任务' };
    for (const t of paused) {
      t.status = 'queued'; t.paused = false; delete t.resumeIdx;
      this._taskQueue.push(t.id);
      t.log.push('[全部继续]');
    }
    this._taskQueue.forEach((qid, k) => { this.tasks.get(qid).planPos = k + 1; });
    if (!this._runningTaskId) this._startNextQueued();
    else this._emitTasks();
    return { ok: true, count: paused.length };
  }
  // 全部暂停：所有排队任务移出执行队列并冻结顺位
  pauseAllTasks() {
    const queued = [...this.tasks.values()].filter((t) => t.status === 'queued')
      .sort((a, b) => (a.planPos || 1e9) - (b.planPos || 1e9));
    if (!queued.length) return { ok: false, error: '没有排队中的任务' };
    for (const t of queued) {
      const i = this._taskQueue.indexOf(t.id);
      if (i >= 0) this._taskQueue.splice(i, 1);
      t.status = 'paused'; t.paused = true;
      const waiting = [...this.tasks.values()].filter((x) => x.status === 'queued' || x.status === 'paused')
        .sort((a, b) => (a.planPos || 1e9) - (b.planPos || 1e9));
      t.resumeIdx = Math.max(0, waiting.indexOf(t));
      t.log.push('[全部暂停]');
    }
    this._emitTasks();
    return { ok: true, count: queued.length };
  }

  // 停止任务：排队/暂停中的任务直接取消（移出执行队列）；运行中的任务终止进程树
  stopTask(id) {
    const { spawnSync } = require('child_process');
    const t = this.tasks.get(id);
    if (!t) return { ok: false, error: '任务不存在' };
    if (t.status === 'queued' || t.status === 'paused') {
      const i = this._taskQueue.indexOf(id);
      if (i >= 0) this._taskQueue.splice(i, 1);
      t.status = 'stopped';
      t.paused = false;
      t.planPos = 0;
      t.endedAt = Date.now();
      t.log.push('[已取消任务，不再执行]');
      this._emitTasks();
      return { ok: true };
    }
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

  // 重开失败/中断/停止的任务：完整复用原任务环境变量（含提交时刻，成片命名/日志/输出目录
  // 与首次开始完全一致）重新制作；重开前删除该任务上次遗留的成片与日志产物。
  rerunTask(id) {
    const t = this.tasks.get(id);
    if (!t) return { ok: false, error: '任务不存在' };
    if (t.status !== 'error' && t.status !== 'interrupted' && t.status !== 'stopped') return { ok: false, error: '仅失败/中断/停止的任务可重新开始' };
    // 优先使用任务标记：其中保存了完整 env 与逐个成片的产出清单（精确还原、不依赖日志窗口）
    const marker = this._loadMarker(t);
    const env = Object.assign({}, (marker && marker.env) || t.env || {});
    const src = env.REPLICA_TXT ? String(env.REPLICA_TXT) : '';
    if (!src) {
      this._removeMarker(t);
      return { ok: false, error: '原任务缺少 TXT 配置，无法重新开始' };
    }
    // 删除上次失败残留的成片与日志：有标记按标记精确清单，无标记回退日志解析+目录推算
    if (marker) this._removeMarkerArtifacts(marker);
    else this._removeTaskArtifacts(t);
    this._removeMarker(t);
    this.tasks.delete(id);
    const task = this._createTask(t.type, t.title || this._taskTitle(src), t.script, env, src);
    // 保留预填的进度结构（如批量任务的预计成片数/分组数），其余进度归零
    task.progress = { current: 0, total: 0 };
    if (t.progress && t.progress.groupCount > 0) task.progress.groupCount = t.progress.groupCount;
    if (t.progress && t.progress.total > 0) task.progress.total = t.progress.total;
    this._enqueueTask(task);
    return { ok: true, taskId: task.id };
  }

  // ── 任务标记临时文件：存于任务成片文件夹（含完整 env 与逐成片产出清单）。
  // 任务正常完成时删除；失败/中断/停止时保留，作为「该任务未完成」的标志且供重开精确还原。
  _markerPath(task) {
    const envTxt = task.env && task.env.REPLICA_TXT ? String(task.env.REPLICA_TXT) : '';
    const base = task.outDir || (envTxt ? path.dirname(path.resolve(envTxt)) : '');
    if (!base) return '';
    return path.join(base, '.video-lab-mark-' + task.id + '.json');
  }
  _loadMarker(task) {
    const p = this._markerPath(task);
    if (!p || !fs.existsSync(p)) return null;
    try { const d = JSON.parse(fs.readFileSync(p, 'utf-8')); return d && typeof d === 'object' ? d : null; } catch (e2) { return null; }
  }
  _saveMarker(task, data) {
    const p = this._markerPath(task);
    if (!p) return;
    try { atomicWrite(p, JSON.stringify(data)); } catch (e2) {}
  }
  _removeMarker(task) {
    const p = this._markerPath(task);
    try { if (p && fs.existsSync(p)) fs.unlinkSync(p); } catch (e2) {}
  }
  // 任务真正开始执行时初始化标记（含 env 快照，重开可完整还原环境）
  _touchMarker(task) {
    this._saveMarker(task, {
      taskId: task.id, type: task.type, title: task.title || '', script: task.script || '',
      env: Object.assign({}, task.env || {}), createdAt: task.createdAt || Date.now(),
      videos: [], batchOutDir: '',
    });
  }
  // 追加产物记录：成片完成路径 / batch 专属输出目录（标记不存在时先创建）
  _appendMarkerOut(task, key, value) {
    if (!value) return;
    let data = this._loadMarker(task);
    if (!data) { this._touchMarker(task); data = this._loadMarker(task); }
    if (!data) return;
    if (key === 'videos') {
      if (!Array.isArray(data.videos)) data.videos = [];
      if (data.videos.indexOf(value) < 0) data.videos.push(value);
    } else if (key === 'batchOutDir') {
      data.batchOutDir = value;
    }
    this._saveMarker(task, data);
  }

  // 按任务标记精确删除失败任务遗留产物：
  // 1) 标记中逐成片记录的输出文件（复刻/批量共用）；
  // 2) batch 专属输出目录内的成片 mp4 与拼接日志（与重制结果同名冲突）；
  //    源 TXT 正本若已被脚本移入输出目录且原位置不存在，先移回原处保证重开可读取。
  _removeMarkerArtifacts(marker) {
    const rm = (p) => {
      try {
        if (p && fs.existsSync(p)) {
          const st = fs.statSync(p);
          if (st.isFile()) fs.unlinkSync(p); else fs.rmSync(p, { recursive: true, force: true });
        }
      } catch (e2) {}
    };
    for (const v of (marker.videos || [])) rm(v);
    if (marker.type === 'batch' && marker.batchOutDir) {
      const src = (marker.env && marker.env.REPLICA_TXT) ? String(marker.env.REPLICA_TXT) : '';
      if (src && !fs.existsSync(src)) {
        const dest = path.join(marker.batchOutDir, path.basename(src));
        try { if (fs.existsSync(dest) && fs.statSync(dest).isFile()) fs.renameSync(dest, src); } catch (e2) {}
      }
      try {
        if (fs.existsSync(marker.batchOutDir) && fs.statSync(marker.batchOutDir).isDirectory()) {
          for (const f of fs.readdirSync(marker.batchOutDir)) {
            const fp = path.join(marker.batchOutDir, f);
            if (fs.existsSync(fp) && fs.statSync(fp).isFile() && (path.extname(f).toLowerCase() === '.mp4' || /拼接日志/.test(f))) rm(fp);
          }
        }
      } catch (e2) {}
    }
  }

  // 删除失败任务在磁盘上遗留的产物（无任务标记时的回退方案）：
  // 1) 任务日志中「✅ 成片完成：」明确列出的成片文件；
  _removeTaskArtifacts(task) {
    const rm = (p) => {
      try {
        if (p && fs.existsSync(p)) {
          const st = fs.statSync(p);
          if (st.isFile()) fs.unlinkSync(p); else fs.rmSync(p, { recursive: true, force: true });
        }
      } catch (e2) {}
    };
    // 1) 日志中列出的成片
    for (const line of (task.log || [])) {
      const m = /✅ 成片完成：(.+)$/.exec(line);
      if (m) rm(String(m[1]).trim());
    }
    // 2) batch 专属输出目录（以提交时刻+配置名精确推算，日志行被滚动挤出时仍可命中）
    if (task.type === 'batch') {
      const detail = this._batchTaskOutDetail(task);
      if (detail && detail.outDir) {
        const src = (task.env && task.env.REPLICA_TXT) ? String(task.env.REPLICA_TXT) : '';
        if (src && !fs.existsSync(src)) {
          const dest = path.join(detail.outDir, path.basename(src));
          try { if (fs.existsSync(dest) && fs.statSync(dest).isFile()) fs.renameSync(dest, src); } catch (e2) {}
        }
        try {
          if (fs.existsSync(detail.outDir) && fs.statSync(detail.outDir).isDirectory()) {
            for (const f of fs.readdirSync(detail.outDir)) {
              const fp = path.join(detail.outDir, f);
              if (fs.existsSync(fp) && fs.statSync(fp).isFile() && (path.extname(f).toLowerCase() === '.mp4' || /拼接日志/.test(f))) rm(fp);
            }
          }
        } catch (e2) {}
      }
    }
  }

  // batch 专属输出目录推算：目录名规则 MMdd-HH时mm分-配置名-成片（与 video_batch.ps1 一致）
  _batchTaskOutDetail(task, allowFallback) {
    const src = (task.env && task.env.REPLICA_TXT) ? String(task.env.REPLICA_TXT) : '';
    if (!src) return null;
    const submit = Number(task.env && task.env.BATCH_SUBMIT_TS) || Number(task.env && task.env.REPLICA_SUBMIT_TS) || task.createdAt || Date.now();
    const d = new Date(submit);
    const p = (n) => (n < 10 ? '0' : '') + n;
    const mmdd = p(d.getMonth() + 1) + p(d.getDate());
    const hhmm = p(d.getHours()) + '时' + p(d.getMinutes()) + '分';
    // 基目录：与脚本一致，从路径最外层起取首个「N月」/「4位数字」段之前的路径
    const abs = path.resolve(src);
    const parts = path.dirname(abs).split(path.sep).filter((s) => s && s !== '.');
    let baseIdx = -1;
    for (let i = 0; i < parts.length; i++) {
      if (/^\d+月$/.test(parts[i]) || /^\d{4}$/.test(parts[i])) { baseIdx = i; break; }
    }
    const baseDir = baseIdx >= 0 ? (parts.slice(0, baseIdx).join(path.sep) || path.parse(abs).root) : path.dirname(abs);
    const outputRoot = path.join(baseDir, (d.getMonth() + 1) + '月', mmdd);
    const txtName = path.basename(abs).replace(/\.txt$/i, '');
    const planned = path.join(outputRoot, mmdd + '-' + hhmm + '-' + txtName + '-成片');
    if (fs.existsSync(planned)) return { outDir: planned };
    // 规划目录不存在：可能是"凌晨内容归入前一天"被人工迁移（如 0831 凌晨任务移至 0830）。
    // 回退查找当天与前一天「8月」目录下实际存在的同名成片目录（HH时mm分-配置名-成片）
    if (allowFallback) {
      const yday = new Date(d); yday.setDate(d.getDate() - 1);
      const ymdd = p(yday.getMonth() + 1) + p(yday.getDate());
      const monthDir = path.join(baseDir, (d.getMonth() + 1) + '月');
      const key = hhmm + '-' + txtName + '-成片';
      for (const day of [mmdd, ymdd]) {
        const dd = path.join(monthDir, day);
        try {
          if (!fs.existsSync(dd) || !fs.statSync(dd).isDirectory()) continue;
          for (const e of fs.readdirSync(dd)) {
            if (!String(e).endsWith('成片') || !e.startsWith(day + '-')) continue;
            if (!e.includes(key)) continue;
            const f = path.join(dd, e);
            if (fs.existsSync(f) && fs.statSync(f).isDirectory()) return { outDir: f };
          }
        } catch (e2) {}
      }
    }
    return { outDir: planned };
  }

  clearFinishedTasks(statuses) {
    // 仅清理指定的已结束状态任务（缺省：完成/停止/失败）；运行中、排队中、暂停中的任务保留
    const allow = new Set(Array.isArray(statuses) && statuses.length ? statuses : ['done', 'stopped', 'error']);
    for (const [id, t] of this.tasks) {
      if (allow.has(t.status)) { this.tasks.delete(id); this._removeMarker(t); }
    }
    this._emitTasks();
    return { ok: true };
  }

  // 清除已完成/已停止任务：支持按日期分组 / 指定任务列表 / 三种作用域（仅列表 / 列表+mp4 / 全部清除）。
  // 先删任务列表（连带删除任务标记文件）；文件删除均移动至系统回收站。
  async clearDoneTasks(opts) {
    const { day, scope, statuses, ids } = opts || {};
    const allow = new Set(Array.isArray(statuses) && statuses.length ? statuses : ['done']);
    const dayOf = (ts) => {
      if (!ts) return '';
      const d = new Date(ts);
      const p = (n) => (n < 10 ? '0' : '') + n;
      return String(d.getFullYear()).slice(2) + '.' + p(d.getMonth() + 1) + '.' + p(d.getDate());
    };
    // 指定任务列表时精确按 id 清除（单任务条），否则按状态+日期筛选
    const inIds = Array.isArray(ids) && ids.length ? new Set(ids) : null;
    const targets = [...this.tasks.values()].filter((t) => (inIds ? inIds.has(t.id) : (allow.has(t.status) && (!day || dayOf(t.endedAt) === day))));
    // 先清任务列表（连带任务标记）
    for (const t of targets) { this.tasks.delete(t.id); this._removeMarker(t); }
    const errors = [];
    if (scope && scope !== 'list') {
      const { shell } = require('electron');
      const trash = async (p) => {
        try { await shell.trashItem(p); }
        catch (e) { if (fs.existsSync(p)) throw e; } // 原路径已不存在视为成功
      };
      for (const t of targets) {
        if (!t.outDir) continue;
        const abs = path.resolve(t.outDir);
        if (scope === 'video') {
          // 仅清除 mp4 成片，不影响文件夹内的配置与日志
          let files = [];
          try { files = fs.readdirSync(abs).filter((f) => path.extname(f).toLowerCase() === '.mp4'); }
          catch (e) { errors.push('读取成片目录失败：' + abs); continue; }
          for (const f of files) {
            try { await trash(path.join(abs, f)); }
            catch (e) { errors.push('清除成片失败：' + path.join(abs, f)); }
          }
        } else if (scope === 'all') {
          // 全部清除：整个成片文件夹移入回收站（仅限识别为「成片」的目录，回退目录保守只清 mp4）
          if (path.basename(abs).endsWith('成片')) {
            try { await trash(abs); }
            catch (e) { errors.push('清除成片文件夹失败：' + abs); continue; }
            const parent = path.dirname(abs);
            if (parent && parent !== abs) {
              try { if (fs.readdirSync(parent).length === 0) await trash(parent); }
              catch (e) { errors.push('清除空上级文件夹失败：' + parent); }
            }
          } else {
            let files = [];
            try { files = fs.readdirSync(abs).filter((f) => path.extname(f).toLowerCase() === '.mp4'); }
            catch (e) { errors.push('读取成片目录失败：' + abs); continue; }
            for (const f of files) {
              try { await trash(path.join(abs, f)); }
              catch (e) { errors.push('清除成片失败：' + path.join(abs, f)); }
            }
          }
        }
      }
    }
    this._emitTasks();
    return { ok: true, removed: targets.length, errors };
  }

  // 已完成批量任务重分组：修复分组数错误 / 忘记分组。规则与 video_batch.ps1 完全一致——
  // 按日志记录顺序（即生成顺序）1..N 均匀分成 n 组（前 remainder 组各多 1 个），组后缀依次大写字母 A/B/C…；
  // 已有旧分组后缀（末尾单个大写字母）会先剥除再补新后缀；同时把拼接日志中每个成片名行同步改为新名。
  regroupTask(id, groupCount) {
    const t = this.tasks.get(id);
    if (!t) return { ok: false, error: '任务不存在' };
    if (t.status !== 'done') return { ok: false, error: '仅已完成的任务可重分组' };
    if (t.type !== 'batch') return { ok: false, error: '仅批量拼接任务支持重分组' };
    const n = parseInt(String(groupCount), 10);
    if (!(n > 0)) return { ok: false, error: '分组数必须是大于 0 的正整数' };
    // 输出目录：优先任务日志中记录的「创建输出目录」（脚本实际输出目录），回退任务 outDir
    let outDir = '';
    for (const ln of (t.log || [])) {
      const m = /✅ 创建输出目录：(.+)$/.exec(ln);
      if (m) { outDir = String(m[1]).trim(); break; }
    }
    if (!outDir || !fs.existsSync(outDir)) outDir = t.outDir || '';
    try {
      if (!outDir || !fs.existsSync(outDir) || !fs.statSync(outDir).isDirectory()) return { ok: false, error: '找不到成片输出目录' };
    } catch (e) { return { ok: false, error: '找不到成片输出目录' }; }
    // 本批次专属的拼接日志（文件名含时间戳+配置名），同目录可能同时存在其他批次日志
    let logPath = '';
    try {
      for (const f of fs.readdirSync(outDir)) {
        if (/拼接日志\.txt$/i.test(f) && fs.statSync(path.join(outDir, f)).isFile()) { logPath = path.join(outDir, f); break; }
      }
    } catch (e) {}
    if (!logPath) return { ok: false, error: '输出目录中未找到拼接日志文件' };
    // 按生成顺序解析成片名（批量日志每块首行 = 成片文件名，与 _parseLog 同规则）
    let entries = [];
    try { entries = this._parseLog(logPath).map((en) => String(en.video || '').trim()).filter(Boolean); }
    catch (e) { return { ok: false, error: '拼接日志解析失败' }; }
    const total = entries.length;
    if (!total) return { ok: false, error: '日志中没有成片记录' };
    // 分组后缀计算：与脚本一致
    const groupSize = Math.floor(total / n);
    const remainder = total % n;
    const letterFor = (idx) => {
      if (n <= 1) return '';
      let start = 1;
      for (let g = 0; g < n; g++) {
        const size = groupSize + (g < remainder ? 1 : 0);
        if (idx >= start && idx < start + size) return String.fromCharCode(65 + g);
        start += size;
      }
      return '';
    };
    const renamed = [];   // [旧名, 新名]
    const errors = [];
    for (let i = 0; i < total; i++) {
      const oldName = entries[i];
      const src = path.join(outDir, oldName);
      try {
        if (!fs.existsSync(src)) { errors.push('缺失文件：' + oldName); continue; }
        const ext = path.extname(oldName);
        let base = path.basename(oldName, ext);
        base = base.replace(/[A-Z]$/, ''); // 剥除旧分组后缀
        const newName = base + letterFor(i + 1) + ext;
        if (newName === oldName) continue;
        const dst = path.join(outDir, newName);
        if (fs.existsSync(dst)) { errors.push('目标重名已跳过：' + newName); continue; }
        fs.renameSync(src, dst);
        renamed.push([oldName, newName]);
      } catch (e) { errors.push('重命名失败：' + oldName + '（' + e.message + '）'); }
    }
    // 同步改写拼接日志中的成片名行（严格匹配旧名，避免误伤片段/水印行）
    if (renamed.length) {
      const map = new Map(renamed);
      try {
        const text = fs.readFileSync(logPath, 'utf-8');
        const eol = text.includes('\r\n') ? '\r\n' : '\n';
        const lines = text.split(/\r?\n/);
        let ch = false;
        for (let i = 0; i < lines.length; i++) {
          const s = lines[i].trim();
          if (map.has(s)) { lines[i] = map.get(s); ch = true; }
        }
        if (ch) fs.writeFileSync(logPath, lines.join(eol), 'utf-8');
      } catch (e) { errors.push('日志同步失败：' + e.message); }
      // 成片索引缓存失效：重命名后搜索/日志定位需重建
      this._clipIndex = new Map();
      this._clipIndexDirty = false;
      this._clipIndexRoot = '';
    }
    if (renamed.length) {
    // 同步刷新任务记录的分组数，任务列表卡片随之更新（分组数=输入值；1 表示取消分组置 0 不显示）
    t.progress = Object.assign({}, t.progress || {}, { groupCount: n > 1 ? n : 0 });
    this.persistTasks();
    this._emitTasks();
    }
    if (renamed.length) this._markConfigModified();
    return { ok: true, total, regrouped: renamed.length, errors };
    return { ok: true, total, regrouped: renamed.length, errors };
  }

  // 更新日志（CHANGELOG.md 位于应用目录内，随 app.asar 打包）
  getChangelog() {
    try {
      const p = path.join(__dirname, 'CHANGELOG.md');
      return { ok: true, content: fs.readFileSync(p, 'utf8') };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }

  // 关于页（README.md 位于应用目录内，随 app.asar 打包）
  getReadme() {
    try {
      const p = path.join(__dirname, 'README.md');
      return { ok: true, content: fs.readFileSync(p, 'utf8') };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }

  // 暂停：仅排队中的任务可暂停——移出执行队列并冻结当前显示顺位（前方待运行任务数），继续时按该顺位插队
  pauseTask(id) {
    const t = this.tasks.get(id);
    if (!t) return { ok: false, error: '任务不存在' };
    if (t.status !== 'queued') {
      if (t.status === 'running') return { ok: false, error: '运行中的任务只能停止，不能暂停' };
      return { ok: false, error: '任务已结束' };
    }
    const i = this._taskQueue.indexOf(id);
    t.status = 'paused';
    t.paused = true;
    if (i >= 0) this._taskQueue.splice(i, 1);
    // 冻结显示顺位：记录该任务在当前「待运行显示序列」（排队+暂停按计划序号排序）中的位置，
    // 即它前方还有几个待运行任务。继续时据此插队，保证「暂停时几号，继续后还是几号」。
    const waiting = [];
    this.tasks.forEach((t2) => { if (t2.status === 'queued' || t2.status === 'paused') waiting.push(t2); });
    waiting.sort((x, y) => (x.planPos || 1e9) - (y.planPos || 1e9));
    t.resumeIdx = Math.max(0, waiting.indexOf(t));
    t.log.push('[已暂停，移出执行队列；点击继续将保持当前顺位插回]');
    this._emitTasks();
    return { ok: true };
  }

  // 继续：暂停的任务按冻结的显示顺位插回执行队列；无运行任务时立即启动
  resumeTask(id) {
    const t = this.tasks.get(id);
    if (!t) return { ok: false, error: '任务不存在' };
    if (t.status !== 'paused') return { ok: false, error: '任务未处于暂停状态' };
    // 按暂停时的显示顺位插队（0-based）：前方任务数 + 1 位置；
    // 队列已不足（前方任务陆续完成后缩短）时排在队尾，即成为下一个执行任务
    const idx = typeof t.resumeIdx === 'number' ? t.resumeIdx : Math.max(0, (t.planPos || 1) - 1);
    const pos = Math.min(idx, this._taskQueue.length);
    t.status = 'queued';
    t.paused = false;
    this._taskQueue.splice(pos, 0, id);
    // 重算队列计划序号，使显示顺序与插队位置一致（继续后刷新队伍序号）
    this._taskQueue.forEach((qid, k) => { this.tasks.get(qid).planPos = k + 1; });
    delete t.resumeIdx;
    t.log.push('[已恢复，插入队列第 ' + (pos + 1) + ' 位]');
    if (!this._runningTaskId) this._startNextQueued();
    else this._emitTasks();
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
        // 任务真正开始：创建任务标记（含 env 快照，供失败重开精确还原）
        this._touchMarker(task);
        const decodeLine = (buf) => {
          try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); }
          catch (e) { try { return new TextDecoder('gbk').decode(buf); } catch (e2) { return buf.toString('latin1'); } }
        };
        const pushLine = (buf) => {
          const s = decodeLine(buf).replace(/\r$/, '').trim();
          if (!s || task.status !== 'running') return;
          // 单成片实时进度：目标时长（分母）+ ffmpeg time（分子）。
          // 必须放在进度行拦截前，否则 ffmpeg 进度行被折叠后 clip/clipTarget 不再更新（进度条失效）
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
          // ffmpeg 进度行（frame=/fps=/q=/size=/time=/bitrate=/dup=/drop=/speed=/elapsed=）：
          // 不进日志栈，折叠为单行实时进度（结构化字段，前端按规则直译成中文）；
          // 记录该成片当前最新帧进度，成片完成时固化进日志
          if (/^\s*(frame\s*=|fps\s*=|q\s*=|size\s*=|time\s*=|bitrate\s*=|dup\s*=|drop\s*=|speed\s*=|elapsed\s*=)/.test(s)) {
            const kv = {};
            for (const mm of s.matchAll(/(frame|fps|q|size|time|bitrate|dup|drop|speed|elapsed)\s*=\s*([^\s]+)/g)) kv[mm[1]] = mm[2];
            task.progress.liveLine = kv;
            task._lastFrameLine = kv;
            this._emitTasks();
            return;
          }
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
            // 新成片开始：重置单成片进度与帧进度记录
            task._clipDur = 0;
            task.progress.clip = 0;
            task.progress.clipTarget = 0;
            task._lastFrameLine = null;
          }
          if (/成片完成/.test(s) && task._clipDur > 0) task.progress.clip = task._clipDur;
          // 成片完成：把该成片最后一行帧进度固化进日志（每个成片保留最终进度）
          if (/成片完成/.test(s) && task._lastFrameLine) {
            const finalLine = zhLiveLine(task._lastFrameLine);
            if (finalLine) task.log.push(finalLine);
            task._lastFrameLine = null;
            task.progress.liveLine = null; // 清除实时行，避免与固化行重复显示
          }
          if (/等待获取互斥锁/.test(s)) task.lockState = 'waiting';
          else if (/已获取互斥锁/.test(s)) task.lockState = 'locked';
          else if (/互斥锁已释放|任务全部完成|脚本完成/.test(s)) { task.lockState = 'released'; task.progress.liveLine = null; }
          // 产物记录进任务标记：成片完成路径 / batch 专属输出目录（重开时据此精确删除）
          const outpM = s.match(/✅ 成片完成：(.+)$/);
          if (outpM) this._appendMarkerOut(task, 'videos', String(outpM[1]).trim());
          const outdM = s.match(/✅ 创建输出目录：(.+)$/);
          if (outdM) this._appendMarkerOut(task, 'batchOutDir', String(outdM[1]).trim());
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
          // 任务完整完成：删除任务标记；失败/中断/停止保留（供重开精确还原）
          if (task.status === 'done') this._removeMarker(task);
          this._emitTasks();
          // 运行任务结束：清空运行位并启动执行队列中的下一个任务（暂停/继续不影响插入后的推进）
          this._runningTaskId = null;
          this._startNextQueued();
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

  // 校验 批量/复刻 配置参数是否已设置：数字须>0，字符串须非空（txt_prefix 允许空）。返回缺失项标签，空数组=齐全
  _settingsError(group) {
    const cfg = this.config[group] || {};
    const nums = group === 'batch'
      ? [['max_duration', '最大时长(秒)'], ['max_retry', '重试次数'], ['speed_limit', '倍速阈值']]
      : [['max_duration', '最大时长(秒)'], ['speed_limit', '倍速阈值'], ['dedup_ratio', '去重阈值']];
    const missing = [];
    for (const [k, label] of nums) if (!(parseFloat(cfg[k]) > 0)) missing.push(label);
    if (group === 'batch') {
      if (!String(cfg.producer || '').trim()) missing.push('创作者');
    }
    return missing;
  }

  // 设置页保存后同步 Api 持有的配置副本；root 变化时重设根目录
  updateSettings(s) {
    const cfg = s || {};
    if (typeof cfg.root === 'string' && cfg.root && cfg.root !== this.root) this.setRoot(cfg.root);
    if (cfg.batch && typeof cfg.batch === 'object') this.config.batch = Object.assign({}, this.config.batch, cfg.batch);
    if (cfg.replica && typeof cfg.replica === 'object') this.config.replica = Object.assign({}, this.config.replica, cfg.replica);
  }

  // 水印归属校验：以本项目「主流水印」为基准做一致性判定；仅在用户启用判定时参与判断。
// 未启用判定的项目一律放行（默认不启用，勾选后才判定）。只返回布尔值（不暴露真实路径/文件名）。
  checkWatermarkProject(project, watermarkPath) {
    const wm = String(watermarkPath || '').trim();
    try {
      if (!wm) return { inProject: true };
      const pdir = path.resolve(path.join(this.root, project));
      const wmAbs = path.isAbsolute(wm) ? path.resolve(wm) : path.resolve(pdir, wm);
      const wmKey = wmAbs.toLowerCase();
      this._loadWatermarkCache();
      const cacheKey = this.root + '\u0000' + project;
      // 未启用判定：直接放行
      if (!this._wmEnabled[cacheKey]) return { inProject: true };
      if (!Object.prototype.hasOwnProperty.call(this._wmCache, cacheKey)) {
        // 本项目主流水印未固化：现场统计一次并落盘（保存前默认取配置主流作为初始值）
        this._wmCache[cacheKey] = this._computeMajorityWatermark(pdir);
        this._saveWatermarkCache();
      }
      const majorityKey = this._wmCache[cacheKey] || '';
      // 无主流水印(项目无任何水印)放行；有则当前水印必须与其一致
      return { inProject: majorityKey === '' || wmKey === majorityKey };
    } catch (e) { return { inProject: true }; }
  }

  // 读取项目主流水印设置（弹窗初始化）：main=已保存的设置（无则现场统计主流作为初始默认值）；enabled=是否启用判定
  getProjectWatermark(project) {
    try {
      if (!this.root || !project) return { ok: true, main: '', enabled: false };
      const pdir = path.resolve(path.join(this.root, project));
      this._loadWatermarkCache();
      const cacheKey = this.root + '\u0000' + project;
      let main = this._wmCache[cacheKey] || '';
      if (!main) main = this._computeMajorityWatermark(pdir); // 保留统计主流作初始默认值
      return { ok: true, main, enabled: !!this._wmEnabled[cacheKey] };
    } catch (e) { return { ok: false, error: String(e), main: '', enabled: false }; }
  }

  // 保存项目主流水印设置：更新判定参照文件与启用标记；applyToAll=true 时把本项目全部 txt（含日志）的水印行改为新水印
  setProjectWatermark(project, watermark, enabled, applyToAll) {
    try {
      const wm = String(watermark || '').trim();
      const pdir = path.resolve(path.join(this.root, project));
      const wmKey = wm ? (path.isAbsolute(wm) ? path.resolve(wm) : path.resolve(pdir, wm)).toLowerCase() : '';
      this._loadWatermarkCache();
      const cacheKey = this.root + '\u0000' + project;
      if (wmKey) { this._wmCache[cacheKey] = wmKey; this._wmEnabled[cacheKey] = !!enabled; }
      else {
        delete this._wmCache[cacheKey];
        delete this._wmEnabled[cacheKey]; // 未设置水印时视同不启用
      }
      this._saveWatermarkCache();
      if (applyToAll && wm && fs.existsSync(pdir) && fs.statSync(pdir).isDirectory()) {
        const replaced = this._replaceProjectWatermarks(pdir, wm);
        this._markConfigModified(); // 改动配置：清内存缓存并触发前端即时刷新
        return { ok: true, replaced };
      }
      return { ok: true, replaced: 0 };
    } catch (e) { return { ok: false, error: String(e) }; }
  }

  // 递归改写本项目目录下全部 txt 的水印行：配置 txt 替换末尾水印行（保留其余行原样），日志 txt 替换全部 .png 行
  _replaceProjectWatermarks(pdir, newWm) {
    let replaced = 0;
    const walk = (dir) => {
      let entries = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
      for (const en of entries) {
        const fp = path.join(dir, en.name);
        if (en.isDirectory()) { walk(fp); continue; }
        if (!en.isFile() || path.extname(en.name).toLowerCase() !== '.txt') continue;
        if (this._replaceWmLine(fp, newWm)) replaced++;
      }
    };
    walk(pdir);
    return replaced;
  }
  _replaceWmLine(fp, newWm) {
    let text;
    try { text = fs.readFileSync(fp, 'utf-8'); } catch (e) { return false; }
    const eol = (text.replace(/\r?\n/g, '\n').length === text.length) ? '\n' : (text.includes('\r\n') ? '\r\n' : '\n');
    const lines = text.split(/\r?\n/);
    const isLog = LOG_NAME_RE.test(path.basename(fp));
    let changed = false;
    if (isLog) {
      // 日志 txt：水印行是成片块末尾的 .png 路径行，全部替换为新水印
      for (let i = 0; i < lines.length; i++) {
        const s = lines[i].trim();
        if (!s || !/\.png$/i.test(s)) continue;
        if (lines[i] !== newWm) { lines[i] = newWm; changed = true; }
      }
    } else {
      // 配置 txt：水印行 = 最后一个 PNG 路径行（非排除/非注释）；无则追加
      let idx = -1;
      for (let i = lines.length - 1; i >= 0 && idx < 0; i--) {
        const s = lines[i].trim();
        if (!s || s.startsWith('=') || s.startsWith('-')) continue;
        if (/\.png$/i.test(s)) idx = i;
      }
      if (idx >= 0) {
        if (lines[idx] !== newWm) { lines[idx] = newWm; changed = true; }
      } else {
        if (lines.length && lines[lines.length - 1].trim()) lines.push('');
        lines.push(newWm);
        changed = true;
      }
    }
    if (!changed) return false;
    try { fs.writeFileSync(fp, lines.join(eol), 'utf-8'); } catch (e) { return false; }
    return true;
  }

  // 查找主流水印与指定水印一致的项目（归属判定升级：供保存/启动时选择目标项目）
  // 复用 watermark_cache 缓存，缺失项目才现场统计并落盘；返回项目名数组（不含复刻）
  // 若当前项目本身就以该水印为主流（共用或多个项目同时使用），归属明确、不触发弹窗
  findWatermarkProject(project, watermarkPath) {
    try {
      const wm = String(watermarkPath || '').trim();
      if (!wm || !this.root) return { hits: [] };
      const pdir = path.resolve(path.join(this.root, project));
      const wmAbs = path.isAbsolute(wm) ? path.resolve(wm) : path.resolve(pdir, wm);
      const wmKey = wmAbs.toLowerCase();
      this._loadWatermarkCache();
      const seen = new Map(); // 项目目录 -> 项目名（去重）
      for (const t of this._collectAllTxt()) {
        const pd = path.resolve(t.pdir);
        if (!seen.has(pd)) seen.set(pd, path.basename(t.pdir));
      }
      let dirty = false;
      const majorityOf = (pd, proj) => {
        const ck = this.root + '\u0000' + proj;
        if (!Object.prototype.hasOwnProperty.call(this._wmCache, ck)) {
          this._wmCache[ck] = this._computeMajorityWatermark(pd);
          dirty = true;
        }
        return this._wmCache[ck] || '';
      };
      // 当前项目自己就在用该水印：共用场景归属明确，直接放行不弹窗
      const curMk = majorityOf(pdir, project);
      if (curMk !== '' && curMk === wmKey) {
        if (dirty) this._saveWatermarkCache();
        return { hits: [], inOwn: true };
      }
      const hits = [];
      for (const [pd, proj] of seen) {
        if (proj === REPLICA_PROJECT) continue; // 复刻虚拟项目无配置水印
        const mk = majorityOf(pd, proj);
        if (mk !== '' && mk === wmKey) hits.push(proj);
      }
      if (dirty) this._saveWatermarkCache();
      return { hits };
    } catch (e) { return { hits: [] }; }
  }

  // 统计本项目主流水印：所有配置使用频次最高的水印（小写规范化路径返回）
  _computeMajorityWatermark(pdir) {
    const counts = new Map();
    for (const t of this._collectAllTxt()) {
      if (path.resolve(t.pdir) !== pdir) continue;
      let cfg;
      try { cfg = this.readConfig(t.full); } catch (e) { continue; }
      const w = String(cfg && cfg.watermark || '').trim();
      if (!w) continue;
      const k = (path.isAbsolute(w) ? path.resolve(w) : path.resolve(pdir, w)).toLowerCase();
      counts.set(k, (counts.get(k) || 0) + 1);
    }
    let majorityKey = '', majorityN = 0;
    for (const [k, n] of counts) { if (n > majorityN) { majorityN = n; majorityKey = k; } }
    return majorityKey;
  }

  // 刷新配置时预填充水印缓存：扫描当前工作目录下所有项目，缺失归属的项目补算主流，已有条目保持不动
  _warmWatermarkCache() {
    if (!this.watermarkCachePath || !this.root) return;
    try {
      this._loadWatermarkCache();
      const seen = new Map(); // 项目目录 -> 项目名（去重）
      for (const t of this._collectAllTxt()) {
        const pdir = path.resolve(t.pdir);
        if (!seen.has(pdir)) seen.set(pdir, path.basename(t.pdir));
      }
      let dirty = false;
      for (const [pdir, project] of seen) {
        const cacheKey = this.root + '\u0000' + project;
        if (Object.prototype.hasOwnProperty.call(this._wmCache, cacheKey)) continue; // 已有条目不动
        this._wmCache[cacheKey] = this._computeMajorityWatermark(pdir);
        dirty = true;
      }
      if (dirty) this._saveWatermarkCache();
    } catch (e) {}
  }

  _loadWatermarkCache() {
    if (!this._wmCache) this._wmCache = {};
    if (this._wmCacheLoadedRoot === this.root || !this.watermarkCachePath) return;
    this._wmCacheLoadedRoot = this.root;
    this._wmCache = {};
    this._wmEnabled = {};
    const prefix = this.root + '\u0000';
    cleanupTmp(this.watermarkCachePath); // 清理上次中断遗留的未完成临时缓存
    try {
      const data = JSON.parse(fs.readFileSync(this.watermarkCachePath, 'utf-8'));
      if (data && typeof data.watermarks === 'object' && data.watermarks) {
        // 只加载当前工作目录下的条目：换 root 后旧条目不再参与，保存时自然被覆盖清理
        for (const k in data.watermarks) {
          if (Object.prototype.hasOwnProperty.call(data.watermarks, k) && k.startsWith(prefix)) this._wmCache[k] = data.watermarks[k];
        }
      }
      if (data && typeof data.enabled === 'object' && data.enabled) {
        for (const k in data.enabled) {
          if (Object.prototype.hasOwnProperty.call(data.enabled, k) && k.startsWith(prefix)) this._wmEnabled[k] = !!data.enabled[k];
        }
      }
    } catch (e) {}
  }

  _saveWatermarkCache() {
    if (!this.watermarkCachePath) return;
    atomicWrite(this.watermarkCachePath, JSON.stringify({ watermarks: this._wmCache || {}, enabled: this._wmEnabled || {} }));
  }

  runBatch(filePath, count, group) {
    const script = path.join(this.scriptsDir, 'video_batch.ps1');
    if (!fs.existsSync(script)) return { ok: false, error: '未找到脚本：' + script };
    const notSet = this._settingsError('batch');
    if (notSet.length) return { ok: false, error: '批量拼接参数未设置：' + notSet.join('、') + '，请到 设置-批量拼接 中配置后再启动' };
    const b = this.config.batch || {};
    const env = { REPLICA_TXT: path.resolve(filePath), VL_CACHE_DIR: this.videoCachePath ? path.dirname(this.videoCachePath) : '' };
    Object.assign(env, {
      BATCH_MAX_DURATION: String(b.max_duration),
      BATCH_MAX_RETRY: String(b.max_retry),
      BATCH_SPEED_LIMIT: String(b.speed_limit),
      BATCH_TXT_PREFIX: String(b.txt_prefix == null ? '' : b.txt_prefix).trim(),
      BATCH_PRODUCER: String(b.producer).trim(),
      BATCH_SUFFIX_MARK: String(b.suffix_mark == null ? 'YX' : b.suffix_mark).trim(),
    });
    const countStr = String(count).trim();
    if (/^\d+$/.test(countStr) && parseInt(countStr, 10) > 0) env.BATCH_COUNT = countStr;
    const groupStr = String(group).trim();
    env.BATCH_GROUP = /^\d+$/.test(groupStr) && parseInt(groupStr, 10) > 0 ? groupStr : '0';
    // 任务提交时刻：排队跨天运行时，成片命名/日志/输出目录按提交日期而非运行日期
    env.BATCH_SUBMIT_TS = String(Date.now());
    env.REPLICA_NO_WAIT = '1';
    const task = this._enqueueTask(this._createTask('batch', this._taskTitle(filePath), script, env, filePath));
    // 排队即预填预计成片数/分组数（配置底部输入），运行后由输出解析覆写 total
    const preTotal = parseInt(String(count), 10) || 0;
    const preGroup = parseInt(String(group), 10) || 0;
    if (preTotal > 0) task.progress.total = preTotal;
    if (preGroup > 0) task.progress.groupCount = preGroup;
    return { ok: true, taskId: task.id };
  }

  runReplica(logPath, mode = 1, entryVideo) {
    const script = path.join(this.scriptsDir, 'video_replica.ps1');
    if (!fs.existsSync(script)) return { ok: false, error: '未找到脚本：' + script };
    const notSet = this._settingsError('replica');
    if (notSet.length) return { ok: false, error: '视频复刻参数未设置：' + notSet.join('、') + '，请到 设置-视频复刻 中配置后再启动' };
    const r = this.config.replica || {};
    const env = {
      REPLICA_TXT: path.resolve(logPath),
      REPLICA_MODE: String(mode) === '2' ? '2' : '1',
      REPLICA_NO_WAIT: '1',
      VL_CACHE_DIR: this.videoCachePath ? path.dirname(this.videoCachePath) : '',
      REPLICA_MAX_DURATION: String(r.max_duration),
      REPLICA_SPEED_LIMIT: String(r.speed_limit),
      REPLICA_DEDUP_RATIO: String(r.dedup_ratio),
    };
    // 任务提交时刻：排队跨天运行时，复刻命名/日志/输出目录按提交日期而非运行日期
    env.REPLICA_SUBMIT_TS = String(Date.now());
    // 仅复刻日志中的单个指定成片（右侧「复刻」按钮/批量选择传入成片名）
    if (entryVideo) env.REPLICA_ONLY_NAME = String(entryVideo).trim();
    const task = this._enqueueTask(this._createTask('replica', this._taskTitle(logPath) + (String(mode) === '2' ? '（去重）' : ''), script, env, logPath));
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
