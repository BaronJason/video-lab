// -*- coding: utf-8 -*-
// Video Lab — 后端逻辑（Node.js 移植，与 main.py 行为一致）
// 负责扫描项目/TXT、解析配置、预检测、调度内置任务引擎。
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

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
// 项目实际依赖的 FFmpeg 滤镜清单（三模块 + 视频处理工具的滤镜调用全量收集）：
// 缺任何一个都视为环境不合格（精简版/第三方便携构建常缺 colorchannelmixer、signalstats 等）
const FFMPEG_REQUIRED_FILTERS = [
  'scale', 'overlay', 'colorchannelmixer', 'rotate', 'transpose', 'atempo',
  'trim', 'setpts', 'select', 'aselect', 'concat', 'fps', 'volume',
  'format', 'signalstats', 'metadata',
];

// 必需编码器（硬件编码硬约束）：三档转码格式都走 NVENC ——
// 只查滤镜查不到编码器能力（老版本 ffmpeg 没有 av1_nvenc，会"检测合格但选 AV1 就失败"）
const FFMPEG_REQUIRED_ENCODERS = ['h264_nvenc', 'hevc_nvenc', 'av1_nvenc'];

const DEFAULT_CONFIG = {
  skin: 'white_blue',
  ffmpeg_dir: '',             // FFmpeg 自愈下载目录（数据目录 ffmpeg\）；空 = 用系统 PATH 里的
  notify_task_end: true,      // 任务失败 / 本轮跑完的 Windows 系统通知（默认开启，可在 设置-通用设置 关闭）
  show_maintenance: false,    // 设置页「维护」板块是否可见（用户侧默认关闭：重建缓存/日志等属维护用途）
  backup_dir: '',             // 视频处理「处理前备份」的默认目录；留空 = 数据目录下 backup（与缓存库同目录）
  backup_auto_clean: false,   // 视频处理任务完成后自动清理过期备份（默认关闭；删除走回收站可还原）
  backup_keep_days: 7,        // 备份保留天数（3 / 7 / 15 / 30）
  auto_check_update: true,    // 启动时自动检查更新
  check_update_daily: false,  // 每日定时检查更新（整点触发，需 app 保持运行）
  check_update_hour: 9,       // 每日定时检查更新时间（24 小时制整点 0-23，默认 9）
  update_source: 'gitee',     // 更新源：gitee=码云 release / github=GitHub release，默认码云
  update_mode: 'notify',      // 更新方式：notify=有新版本仅提醒（默认）/ auto=自动检查并下载
  config_storage: 'program',  // 配置文件保存位置：program=程序所在目录 / appdata=%APPDATA%\Video Lab
  http_port: 9527,            // 浏览器访问端口（0-65535，默认 9527）
  // video_batch.ps1 顶部全局参数（文件内同名常量被顶部读环境变量 BATCH_* 覆盖）
  batch: {
    // 工作路径：批量拼接模式自己的工作目录（存放各项目文件夹及 TXT 配置）。
    // 2026-09-26 从顶层 root 迁移至此 —— 它本就是批量模式的工作目录，放进 batch 与遮罩的
    // mask.root 对称；各模式的工作目录由各模式自己承接。（旧顶层 root 由 main 启动时一次性迁移）
    root: '',
    max_duration: 179,   // MaxTotalDurationSec 最大成片时长(秒)
    max_retry: 45,       // MaxRetry 重试次数
    speed_limit: 1.2,    // SpeedThreshold 倍速阈值
    txt_prefix: '',      // TxtNamePrefix 提取前缀，可留空
    producer: '',      // 成片名固定品牌名（设置页-批量拼接 配置）
    suffix_mark: '',     // 序号后缀（成片名中的序号标识），可留空 = 无任何后缀
  },
  // video_replica.ps1 顶部全局参数（文件内同名常量被顶部读环境变量 REPLICA_* 覆盖）
  replica: {
    max_duration: 179,   // MaxTotalDurationSec
    speed_limit: 1.2,    // SpeedThreshold
    dedup_ratio: 0.4,    // 重复度下限（DedupRatio）：低于它会被判定重复度过高
    dedup_ratio_max: 0.5,    // 重复度上限：超过它会被判定为全新视频（继承不到流量）
    dedup_ratio_on: true,    // 下限是否启用（复刻弹窗默认勾选状态）
    dedup_ratio_max_on: true,// 上限是否启用（复刻弹窗默认勾选状态）
  },
  // 遮罩叠加：独立工作路径 + 固定水印（设置页配置，遮罩模式界面默认使用）
  mask: {
    root: '',            // 遮罩叠加项目工作路径（不允许复用批量拼接工作路径）
    watermark_mov: '',   // 固定水印 mov（模式1/2 默认水印，界面可临时更换）
    watermark_alpha: '', // 水印透明度（0.05-1；留空用脚本默认 0.3）
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

// 异步遍历（启动路径专用）：用 fs.promises 读目录，每处理 yieldEvery 个条目让出一轮事件循环，
// 使主进程在扫描期间仍能响应 IPC / 重绘（同步版会整段占死，表现为窗口无响应、进度条不动）。
// onTick(processed) 用于上报进度，返回 false 可中断遍历（取消语义）。
async function walkFilesAsync(dir, opts) {
  const yieldEvery = (opts && opts.yieldEvery) || 60;
  const onTick = (opts && opts.onTick) || null;
  const shouldStop = (opts && opts.shouldStop) || null;
  const out = [];
  const stack = [dir];
  let since = 0;
  while (stack.length) {
    if (shouldStop && shouldStop()) return out;
    const cur = stack.pop();
    let entries;
    try { entries = await fs.promises.readdir(cur, { withFileTypes: true }); } catch (e) { continue; }
    for (const ent of entries) {
      const full = path.join(cur, ent.name);
      if (ent.isDirectory()) stack.push(full);
      else if (ent.isFile()) out.push(full);
      if (++since >= yieldEvery) {
        since = 0;
        if (onTick) onTick(out.length);
        await new Promise((r) => setImmediate(r));   // 让位：主进程可处理其他事件
        if (shouldStop && shouldStop()) return out;
      }
    }
  }
  if (onTick) onTick(out.length);
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
  constructor(root, config, enginesDir, storageDir) {
    this.root = root;
    this.config = Object.assign({}, DEFAULT_CONFIG, config || {});
    this.enginesDirFixed = enginesDir || ''; // Node 引擎位置（源码形态 app\engines，分发形态 resources\Engines）
    this.storageDir = storageDir || '';      // 数据目录：引导文件与两个库（config.json / settings.db / cache.db）同目录
    this._persistTimer = null;                          // 任务持久化节流定时器
    this._clipIndex = null;        // Map<baseDir, {mtime, entries}>
    this._clipIndexRoot = '';
    this._clipIndexDirty = false;
    this._rebuildingClip = false; // 成片索引后台分批重建进行中标志（防并发重复触发）
    this.onScanProgress = null;   // 各扫描/重建环节进度回调（main 注入，推送主窗口渲染实时状态）
    this._precheckToken = 0;      // 预检测取消令牌：token 变化即中断旧探测（重置/换路径/手动取消）
    this._inlineProbing = 0;      // 行内预检测进行中计数：后台大探测遇其让路，保证用户操作优先
    this._cleanupStaleLocks();    // 启动时清掉历史残留的过期锁（异常退出留下的，否则一直累积）
    this._loadAppSettings();      // 应用级设置：settings.db 为主（config 只作兼容回退）
    // ffprobe 探测并发上限：保持低值，避免占用过多 CPU/IO 拖慢整机
    this.probeConcurrency = 4;
    this._videoCache = null;
    this._videoInfoCache = new Map();
    this._videoCacheDirty = false; // 缓存内容是否有未落盘变更：无变更时预检测不再重复写整份缓存
    this._videoCacheDirtyKeys = new Set();   // 待写回的路径（增量 upsert）
    this._videoCacheRemovedKeys = new Set(); // 待删除的路径
    this._cacheStore = null;       // 数据缓存库（<storageDir>\cache.db），惰性打开
    this._cacheBackendMode = '';   // 'db' | 'mem'：首次使用时判定一次（mem = 库不可用，退化纯内存不落盘）
    this._settingsStore = null;    // 设置库（<storageDir>\settings.db），惰性打开
    this._settingsMode = '';       // 'db' | 'mem'
    this._lnkCache = new Map();    // .lnk 解析结果缓存（lnk 路径 → { mtimeMs, target }），lnk 未变则免重复解析
    this._lnkParser = undefined;   // .lnk 解析器（惰性取底座引擎实现）
    this._txtTree = null;
    // 启动后空闲期执行一次 video_cache 失效清理（文件已删除/旧工作目录残留回收）
    setImmediate(() => { this._gcVideoCacheNow().catch(() => {}); });
    this._txtTreeRoot = null;
    this._projectsCache = null;
    this._projectsInflight = null;   // 进行中的 listProjectsAsync（并发合并，避免同一份扫描跑多遍）
    this._projectsSeq = 0;           // 刷新代际：force 后令在跑的旧任务结果作废
    this._lastFreshTiming = null;    // isScanCacheFreshAsync 的分段耗时，供启动日志定位瓶颈
    this._versionsCache = new Map();
    this._versionsFp = new Map(); // 各配置版本列表的「目录级指纹」，list_versions 入口核对自动失效
    this._scanCache = new Map();
    this._scanLoadedRoot = '';
    this._scanDirty = false;
    this._scanDirtyKeys = new Set();   // 待写回的指纹键（增量 upsert）
    this._scanRemovedKeys = new Set(); // 待删除的指纹键
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
    // 启动恢复期抑制标志：为真时 _taskHasOutput 直接给乐观值，绝不做同步磁盘探测。
    // 起因（2026-09-26 冷态实测）：历史任务的成片目录多在机械盘（115 任务里 66 个在 E 盘），
    // 冷启动首次访问每个目录约 87ms，snapshotTasks 逐任务同步探测会冻结主进程约 5.7 秒。
    // 由 restoreTasks 置真、_prewarmHasOutputAsync 预热完成后复位（详见两处注释）。
    this._bootProbeSuppressed = false;
  }

  // ── 库路径：两个库与引导文件同目录（扁平布局），一律由 storageDir 派生，不做重算 ──
  get cacheDbPath() {
    return this.storageDir ? path.join(this.storageDir, 'cache.db') : '';
  }

  get settingsDbPath() {
    return this.storageDir ? path.join(this.storageDir, 'settings.db') : '';
  }

  // Node 引擎根目录：由 main 按形态动态解析传入（源码形态 app\engines，分发形态 resources\Engines）；
  // 未传入时按本文件所在目录同级探测作为兜底
  get enginesDir() {
    if (this.enginesDirFixed) return this.enginesDirFixed;
    const parent = __dirname;
    // 源码形态为 app\engines，分发形态为 resources\Engines：逐一探测并取回真实大小写
    for (const name of ['engines', 'Engines']) {
      const cand = path.join(parent, name);
      try { if (fs.existsSync(cand)) return fs.realpathSync(cand); } catch (e) {}
    }
    return path.join(parent, 'engines');
  }

  // 运行日志出口（懒加载；写日志永不影响主流程）
  _lg(verb, action, summary, data) {
    try {
      if (!this._runLog) this._runLog = require(path.join(this.enginesDir, 'base', 'runlog.js'));
      this._runLog.logEvent(verb, action, summary, data);
    } catch (e) {}
  }
  // 任务 env 的业务字段快照 —— 复现「成片命名 / 输出目录 / 续跑范围」的唯一凭据，
  // 任务记录一旦被清除就再也没有别处留存了。
  _envBrief(env) {
    const E = env || {};
    const keys = ['REPLICA_TXT', 'REPLICA_OUTPUT_DIR', 'BATCH_COUNT', 'BATCH_GROUP', 'BATCH_SUBMIT_TS',
      'BATCH_TXT_PREFIX', 'BATCH_SUFFIX_MARK', 'BATCH_PRODUCER', 'BATCH_ONLY_NAMES', 'BATCH_ONLY_INDEX',
      'REPLICA_ONLY_NAMES', 'REPLICA_ONLY_NAME', 'REPLICA_SUBMIT_TS',
      'MASK_ONLY_NAMES', 'MASK_RAW_DIRS', 'MASK_THEMES', 'MASK_OUTPUT_DIR'];
    const out = {};
    for (const k of keys) { const v = E[k]; if (v !== undefined && v !== null && String(v) !== '') out[k] = String(v).slice(0, 240); }
    return out;
  }
  // 被删产物的可复盘清单（路径 + 大小 + 修改时间）—— 必须在删除之前调用
  _describeForLog(paths) {
    try {
      if (!this._runLog) this._runLog = require(path.join(this.enginesDir, 'base', 'runlog.js'));
      return this._runLog.describeFiles(paths);
    } catch (e) { return { files: [], count: 0, bytes: 0, truncated: false }; }
  }
  _humanSize(n) {
    try {
      if (!this._runLog) this._runLog = require(path.join(this.enginesDir, 'base', 'runlog.js'));
      return this._runLog.humanSize(n);
    } catch (e) { return String(n) + ' B'; }
  }

  // 引擎入口文件；不存在返回空串（调用方据此判定引擎不可用）
  _engineRunnerPath() {
    const d = this.enginesDir;
    if (!d) return '';
    const p = path.join(d, 'engine-runner.js');
    try { return fs.existsSync(p) ? p : ''; } catch (e) { return ''; }
  }

  // 传给任务的缓存环境变量：引擎直读同一个库（<storageDir>\cache.db），无中间文件
  _cacheEnvBase() {
    return { VL_CACHE_DB: this.cacheDbPath || '' };
  }

  // 引擎是否为当前执行路径：引擎入口文件就绪即可用
  _nodeEnginePrimary() {
    return !!this._engineRunnerPath();
  }

  // 任务是否可分发到内置引擎：未知任务类型一律不分发
  shouldUseNodeEngine(type) {
    if (!type) return false;
    return this._nodeEnginePrimary();
  }

  getRoot() { return this.root; }

  setRoot(newRoot) {
    // 相同路径（如启动时 ensureConfig 每次都调用 setRoot(同 root)）：仅同步内存，不清缓存——
    // 否则会清掉已保存的主流水印设置（watermark_cache 被误删，用户需重新设置）
    if (String(newRoot || '') === String(this.root || '')) {
      this.root = newRoot || '';
      return;
    }
    // 更换工作目录（即使重选相同目录）：仅清内存触发重载，不物理删除文件——
    // 水印/默认分组数按 root+项目 隔离保存，属设置数据，不能被换目录/清缓存抹掉
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
    // 预检测缓存库随 root 重建连接：root 前缀隔离在库内以 gcPlan / 载入过滤体现
    if (this._cacheStore) { try { this._cacheStore.close(); } catch (e) {} }
    this._cacheStore = null;
    this._cacheBackendMode = '';
    this._videoCacheDirtyKeys.clear();
    this._videoCacheRemovedKeys.clear();
    this._rebuildingClip = false;
    // 预检测随工作目录取消：旧路径的探测结果不写入新目录缓存
    this._precheckToken++;
  }

  // ── 存储位置与连接管理（切换「配置和数据保存位置」时由 main 调用）──

  // 有任务正在运行或排队 → 禁止迁移存储位置（Windows 下子进程持有库句柄，移动必然失败）
  hasRunningTasks() {
    for (const t of this.tasks.values()) {
      if (t.status === 'running' || t.status === 'queued') return true;
    }
    return false;
  }

  // 关闭全部库连接并落盘（切换保存位置前必须调用）；随后由 onStorageMoved 按新位置重开
  closeStorageConnections() {
    const store = this._cacheStore;
    if (store) {
      // WAL 收尾：TRUNCATE 把 -wal 内容合并回主库并清空，否则移动时 -wal/-shm 会与主库脱节
      try { store.open().exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch (e) {}
      try { store.close(); } catch (e) {}
    }
    this._cacheStore = null;
    this._cacheBackendMode = '';
    if (this._settingsStore) { try { this._settingsStore.close(); } catch (e) {} }
    this._settingsStore = null;
    this._settingsMode = '';
  }

  // 保存位置已变更：更新数据目录、清空全部内存缓存，下次访问时按新位置重新打开
  onStorageMoved(dir) {
    this.storageDir = dir || '';
    this._videoCache = null;
    this._videoCacheDirty = false;
    this._videoCacheDirtyKeys.clear();
    this._videoCacheRemovedKeys.clear();
    this._videoInfoCache.clear();
    this._scanCache = new Map();
    this._scanLoadedRoot = '';
    this._scanDirty = false;
    this._logCache = null;
    this._logCacheRoot = '';
    this._wmCache = null;
    this._wmEnabled = null;
    this._wmGroup = null;
    this._wmGroupEnabled = null;
    this._wmCacheLoadedRoot = null;
    this._clipIndex = null;
    this._clipIndexRoot = '';
    this._clipIndexDirty = false;
    this.persistTasks(); // 新位置先把当前任务列表落一份，避免切换后列表为空
  }

  // 手动取消进行中的预检测（前端"缩到后台"后点击 ✕、或再次重置/换路径时自动取消防重复）
  cancelPrecheck() {
    this._precheckToken++;
    return { ok: true };
  }

  // 清理项目/TXT 相关内存缓存（保存配置、重建列表时调用；不清持久化指纹缓存）
  // 清理项目/TXT 相关内存缓存（保存配置、重建列表时调用；不清持久化指纹缓存）
  // dropPersist=true 时连持久化条目一并删除 —— 供「强制重扫」（force）使用：
  //   否则内存清了、持久化指纹仍在，重扫会直接读回旧缓存，force 语义失效。
  _invalidateCaches(dropPersist = false) {
    this._txtTree = null;
    this._txtTreeRoot = null;
    this._projectsCache = null;
    this._projectsInflight = null;
    this._projectsSeq = (this._projectsSeq || 0) + 1;   // 在跑的旧任务结果作废
    this._versionsCache.clear();
    this._versionsFp.clear();
    this._logCache = null;
    this._logCacheRoot = '';
    if (dropPersist && this._useDbCache()) {
      try { this._cacheStore.removeKv('log_index:' + this.root); } catch (e) {}
      try { this._cacheStore.removeKv('txt_tree:' + this.root); } catch (e) {}
    }
  }

  // 配置文件写操作统一收口：清缓存 + 广播，前端据此即时自愈版本/日期分支/侧栏徽章
  _markConfigModified() {
    this._invalidateCaches();
    if (typeof this.onVersionsChanged === 'function') { try { this.onVersionsChanged(); } catch (e) {} }
  }

  // ── 扫描指纹缓存（scan_cache 表）：文件 (mtime,size) 未变则复用已算的 hash，变了才重读 ──
  // 库不可用时退化为纯内存：本次会话内仍可复用，仅跨启动失效（代价只是首次扫描重算指纹）
  _loadScanCache() {
    if (this._scanLoadedRoot === this.root) return;
    this._scanLoadedRoot = this.root;
    this._scanCache = new Map();
    this._scanDirtyKeys.clear();
    this._scanRemovedKeys.clear();
    if (!this._useDbCache()) return;
    try {
      for (const row of this._cacheStore.listScans(this.root + '\n')) {
        let extra = {};
        try { extra = JSON.parse(row.payload || '{}') || {}; } catch (e) { extra = {}; }
        this._scanCache.set(row.key, Object.assign({ mtimeMs: 0, size: 0 }, extra, { hash: row.fingerprint }));
      }
    } catch (e) {}
  }

  // 增量落盘：只写新增/变更的键、删失效键（原实现每次重写整份 JSON）
  _saveScanCache() {
    this._scanDirty = false;
    if (!this._useDbCache()) { this._scanDirtyKeys.clear(); this._scanRemovedKeys.clear(); return; }
    const store = this._cacheStore;
    try {
      store.transaction(() => {
        for (const k of this._scanDirtyKeys) {
          const v = this._scanCache.get(k);
          if (!v) continue;
          store.setScan(k, String(v.hash == null ? '' : v.hash), JSON.stringify({ mtimeMs: v.mtimeMs || 0, size: v.size || 0 }));
        }
        if (this._scanRemovedKeys.size) store.deleteScans(Array.from(this._scanRemovedKeys));
      });
    } catch (e) {}
    this._scanDirtyKeys.clear();
    this._scanRemovedKeys.clear();
  }

  // ── 日志 txt 缓存（cache_kv，键 log_index:<root>）：刷新配置时一并收集 ──
  // 存 { files, fp }：fp = 目录树指纹，用于启动时判断能否直接复用（见 _collectLogFiles）。
  // 兼容旧格式（纯数组）——读到数组时视为无指纹，回退一次全量扫描后自动升级。
  _loadLogCache() {
    if (this._logCacheRoot === this.root) return;
    this._logCacheRoot = this.root;
    this._logCache = { files: [], fp: '' };
    if (!this._useDbCache()) return;
    try {
      const raw = this._cacheStore.getKv('log_index:' + this.root);
      if (!raw) return;
      const data = JSON.parse(raw);
      if (Array.isArray(data)) this._logCache.files = data;                       // 旧格式
      else if (data && Array.isArray(data.files)) {                               // 新格式
        this._logCache.files = data.files;
        this._logCache.fp = String(data.fp || '');
      }
    } catch (e) {}
  }

  _saveLogCache() {
    if (!this._useDbCache()) return;
    try {
      const payload = { files: this._logCache.files || [], fp: this._logCache.fp || '' };
      this._cacheStore.setKv('log_index:' + this.root, JSON.stringify(payload));
    } catch (e) {}
  }

  // 一次性收集根目录下所有非复刻日志 txt（刷新时写入日志缓存）
  // 返回 { files:[{ project, name, path, date, config }] }
  // 归属规则：date 取文件路径中「最近的 4 位 MMdd 目录」（日志绝不会存在于别的日期文件夹），
  //           project 取路径第一级目录（即左侧项目名）。配置与日志都按此规则归一后匹配。
  //
  // ⚡ 启动性能（关键）：命中持久化缓存（log_index:<root>）且「根目录树指纹」未变时，
  //    直接复用缓存返回，**跳过 walkFiles 全量遍历 + 每文件 statSync**。
  //    原实现虽然 _loadLogCache() 读回了缓存，但紧接着 `const files = []` 丢弃、无条件重扫，
  //    使持久化缓存形同虚设（冷启动白扫约 6600 个文件、耗时秒级）。
  //    失效判定用「根目录 + 各一级项目目录的 mtimeMs 摘要」：目录 mtime 对增删子项敏感，
  //    新增/删除项目或目录即变化；文件内容变化不改目录 mtime，但日志列表只关心「有哪些文件」，
  //    内容变化不影响本列表（config 归属由路径决定），故无需更细粒度指纹。
  _collectLogFiles(force = false) {
    if (!force && this._logCache && this._logCacheRoot === this.root) return this._logCache;
    this._loadLogCache();
    if (!force && this._logCache && this._logCacheRoot === this.root && this._logCache.files && this._logCache.files.length) {
      const fp = this._logTreeFingerprint();
      if (fp && fp === this._logCache.fp) return this._logCache;   // 缓存有效：免全量遍历
    }
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
    this._logCache = { files, fp: this._logTreeFingerprint() };
    this._logCacheRoot = this.root;
    this._saveLogCache();
    return this._logCache;
  }

  // 日志树指纹：根目录 + 各一级目录（排除项除外）的 mtimeMs 摘要。
  // 目录增删子项会更新父目录 mtime —— 够用且只读少量目录（非全量 walkFiles）。
  _logTreeFingerprint() {
    try {
      const parts = [];
      const st = fs.statSync(this.root);
      parts.push(String(st.mtimeMs));
      const skip = new Set(EXCLUDED_TOP_DIRS);
      for (const ent of fs.readdirSync(this.root, { withFileTypes: true })) {
        if (!ent.isDirectory()) continue;
        if (ent.name.startsWith('.') || ent.name.startsWith('_') || skip.has(ent.name)) continue;
        let m = '';
        try { m = String(fs.statSync(path.join(this.root, ent.name)).mtimeMs); } catch (e) { m = '?'; }
        parts.push(ent.name + ':' + m);
      }
      return parts.join('|');
    } catch (e) { return ''; }
  }

  // 日志树指纹（异步版）：语义与 _logTreeFingerprint 完全一致，供异步路径使用。
  // ⚠ 启动路径必须用这个：工作目录在机械盘时，系统重启后首次同步访问该盘可冻结主进程
  //   达 117 秒（2026-09-26 实测 gapMs=117531：窗口、托盘全都出不来），异步版只让出等待、不阻塞。
  async _logTreeFingerprintAsync() {
    try {
      const parts = [];
      const st = await fs.promises.stat(this.root);
      parts.push(String(st.mtimeMs));
      const skip = new Set(EXCLUDED_TOP_DIRS);
      let ents = [];
      try { ents = await fs.promises.readdir(this.root, { withFileTypes: true }); } catch (e) { ents = []; }
      for (const ent of ents) {
        if (!ent.isDirectory()) continue;
        if (ent.name.startsWith('.') || ent.name.startsWith('_') || skip.has(ent.name)) continue;
        let m = '';
        try { m = String((await fs.promises.stat(path.join(this.root, ent.name))).mtimeMs); } catch (e) { m = '?'; }
        parts.push(ent.name + ':' + m);
      }
      return parts.join('|');
    } catch (e) { return ''; }
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

  // ⚠ 键分隔符禁用 \u0000：SQLite 的 TEXT 在 NUL 处截断，会把所有文件指的纹键
  //   压成同一个「根目录」字符串（既互相覆盖、又读不回来），导致指纹缓存全量失效。
  //   改用 \n —— Windows 路径非法字符，路径中不可能出现，语义等价且可安全持久化。
  _scanKey(full) { return this.root + '\n' + full; }

  _hashFor(full, mtimeMs, size) {
    this._loadScanCache();
    const key = this._scanKey(full);
    const cached = this._scanCache.get(key);
    if (cached && cached.mtimeMs === mtimeMs && cached.size === size) return cached.hash;
    const h = contentHash(full);
    this._scanCache.set(key, { mtimeMs, size, hash: h });
    this._scanDirty = true;
    this._scanDirtyKeys.add(key);
    return h;
  }

  // 一次性收集根目录下所有项目的配置 TXT（每项目仅递归扫描一次）
  //
  // ⚡ 启动性能（关键）：加「持久化指纹复用」。原实现是纯内存缓存（this._txtTree），
  //    跨启动必然失效 → 每次冷启动都要重新 walkFiles(6600 文件) + 对 1055 个 txt
  //    逐个 statSync + contentHash（readFileSync 读全内容），实测约 31 秒。
  //    现改为把结果按「目录树指纹」持久化（cache_kv 的 txt_tree:<root>）：
  //    指纹未变则直接复用，跳过全部遍历与读文件。
  //    指纹 = 各一级项目目录的 mtimeMs 摘要 —— 目录增删子项会更新其 mtime，
  //    足以发现「新增/删除配置或目录」；文件内容变更不改目录 mtime，但内容只用于
  //    去重（同内容配置保留一份），短暂延后一次不影响列表正确性，且下次任一目录变动即自愈。
  _collectAllTxt() {
    if (this._txtTree && this._txtTreeRoot === this.root) return this._txtTree;
    const fp = this._logTreeFingerprint();
    const cached = this._loadTxtTree(fp);
    if (cached) { this._txtTree = cached; this._txtTreeRoot = this.root; return cached; }
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
      const prefix = this.root + '\n';
      for (const k of [...this._scanCache.keys()]) {
        if (k.startsWith(prefix) && !active.has(k)) { this._scanCache.delete(k); this._scanRemovedKeys.add(k); }
      }
      this._scanDirty = false;
      this._saveScanCache();
    }
    this._saveTxtTree(out, fp);
    return out;
  }

  // 配置 TXT 树持久化（cache_kv，键 txt_tree:<root>）：存 { fp, items }
  // fp 为目录树指纹，与 _collectAllTxt 传入的一致才复用。库不可用时静默跳过（退化为纯内存）。
  _loadTxtTree(fp) {
    if (!fp || !this._useDbCache()) return null;
    try {
      const raw = this._cacheStore.getKv('txt_tree:' + this.root);
      if (!raw) return null;
      const data = JSON.parse(raw);
      if (!data || data.fp !== fp || !Array.isArray(data.items)) return null;
      return data.items;
    } catch (e) { return null; }
  }

  _saveTxtTree(items, fp) {
    if (!this._useDbCache()) return;
    try {
      this._cacheStore.setKv('txt_tree:' + this.root, JSON.stringify({ fp: fp || '', items: items || [] }));
    } catch (e) {}
  }

  // 扫描缓存是否新鲜（毫秒级）：仅比对目录树指纹，不做任何遍历。
  // 供 main 判断「启动是否需要弹扫描小窗」——命中则连小窗都不必出现。
  isScanCacheFresh() {
    try {
      if (!this.root) return false;
      if (!this._useDbCache()) return false;
      const fp = this._logTreeFingerprint();
      if (!fp) return false;
      const rawIdx = this._cacheStore.getKv('log_index:' + this.root);
      if (!rawIdx) return false;
      let idx = null;
      try { idx = JSON.parse(rawIdx); } catch (e) { return false; }
      if (!Array.isArray(idx) && idx && Array.isArray(idx.files) && idx.fp === fp) return true;
      const rawTree = this._cacheStore.getKv('txt_tree:' + this.root);
      if (!rawTree) return false;
      const t = JSON.parse(rawTree);
      return !!(t && t.fp === fp && Array.isArray(t.items));
    } catch (e) { return false; }
  }

  // 扫描缓存是否新鲜（异步版，启动专用）：判定语义与 isScanCacheFresh 一致，
  // 但目录树指纹走 fs.promises —— **绝不阻塞主进程事件循环**（同步版曾冻结 117 秒）。
  // SQLite 读取仍为同步：库在系统盘（SSD）且仅 24MB，实测毫秒级；单独计时便于定位。
  // 分段耗时写入 this._lastFreshTiming（{ db, fp, kv, total } 毫秒），由 main 落进 app.timing。
  async isScanCacheFreshAsync() {
    const timing = { db: 0, fp: 0, kv: 0, total: 0 };
    const _all = process.hrtime.bigint();
    const _ms = (t0) => Math.round(Number(process.hrtime.bigint() - t0) / 1e6);
    // 判定结果落进 _lastFreshTiming.reason：缓存命中（hit:idx / hit:tree）或未命中的具体分支。
    // 未命中时把关键量（fp 长度、缓存 fp、kv 长度）一并带上，便于一次冷启动就定位到根因。
    let reason = '';
    try {
      if (!this.root) { reason = 'no-root'; return false; }
      let t0 = process.hrtime.bigint();
      const useDb = this._useDbCache();
      timing.db = _ms(t0);
      if (!useDb) { reason = 'no-db'; return false; }
      t0 = process.hrtime.bigint();
      const fp = await this._logTreeFingerprintAsync();
      timing.fp = _ms(t0);
      if (!fp) { reason = 'no-fp'; return false; }
      t0 = process.hrtime.bigint();
      const rawIdx = this._cacheStore.getKv('log_index:' + this.root);
      const rawTree = this._cacheStore.getKv('txt_tree:' + this.root);
      timing.kv = _ms(t0);
      timing.idxLen = rawIdx ? rawIdx.length : 0;
      timing.treeLen = rawTree ? rawTree.length : 0;
      timing.fpLen = fp.length;
      if (!rawIdx) { reason = 'no-idx'; return false; }
      let idx = null;
      try { idx = JSON.parse(rawIdx); } catch (e) { reason = 'idx-bad-json'; return false; }
      if (!Array.isArray(idx) && idx && Array.isArray(idx.files) && idx.fp === fp) { reason = 'hit:idx'; return true; }
      timing.idxFpLen = idx && idx.fp ? String(idx.fp).length : 0;
      if (!rawTree) { reason = 'no-tree'; return false; }
      const t = JSON.parse(rawTree);
      if (t && t.fp === fp && Array.isArray(t.items)) { reason = 'hit:tree'; return true; }
      timing.treeFpLen = t && t.fp ? String(t.fp).length : 0;
      reason = 'miss-both';
      return false;
    } catch (e) {
      reason = 'throw:' + ((e && e.message) || e);
      return false;
    } finally {
      timing.total = _ms(_all);
      timing.reason = reason;
      this._lastFreshTiming = timing;
    }
  }

  // 是否已有完整的项目列表结果（供 main 判断「唤起时是否还需要扫描」）
  get hasProjectsCache() { return !!this._projectsCache; }

  // ── 异步扫描路径（启动专用）──
  // 与同步版同语义，但全程用 fs.promises + 分片让位，不阻塞主进程事件循环。
  // 缓存未命中（首次启动 / 目录结构变化）时走这里，窗口可先显示、扫描期间 UI 不卡。
  async _collectAllTxtAsync(opts) {
    if (this._txtTree && this._txtTreeRoot === this.root) return this._txtTree;
    const fp = await this._logTreeFingerprintAsync();
    const cached = this._loadTxtTree(fp);
    if (cached) { this._txtTree = cached; this._txtTreeRoot = this.root; return cached; }
    this._loadScanCache();
    const out = [];
    const active = new Set();
    const onTick = (opts && opts.onTick) || null;
    const shouldStop = (opts && opts.shouldStop) || null;
    let rootOk = false;
    try { const st = await fs.promises.stat(this.root); rootOk = st.isDirectory(); } catch (e) { rootOk = false; }
    if (rootOk) {
      let entries = [];
      try { entries = await fs.promises.readdir(this.root); } catch (e) { entries = []; }
      for (const name of entries) {
        if (shouldStop && shouldStop()) break;
        if (name.startsWith('.') || name.startsWith('_')) continue;
        if (EXCLUDED_TOP_DIRS.has(name)) continue;
        const pdir = path.join(this.root, name);
        let isDir = false;
        try { isDir = (await fs.promises.stat(pdir)).isDirectory(); } catch (e) { isDir = false; }
        if (!isDir) continue;
        const files = await walkFilesAsync(pdir, { onTick, shouldStop });
        for (const full of files) {
          if (!path.basename(full).toLowerCase().endsWith('.txt')) continue;
          if (LOG_NAME_RE.test(path.basename(full))) continue;
          let st2;
          try { st2 = await fs.promises.stat(full); } catch (e) { continue; }
          const mtimeMs = st2.mtimeMs, size = st2.size;
          const hash = await this._hashForAsync(full, mtimeMs, size);
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
      const prefix = this.root + '\n';
      for (const k of [...this._scanCache.keys()]) {
        if (k.startsWith(prefix) && !active.has(k)) { this._scanCache.delete(k); this._scanRemovedKeys.add(k); }
      }
      this._scanDirty = false;
      this._saveScanCache();
    }
    this._saveTxtTree(out, fp);
    return out;
  }

  // 异步指纹：命中 (mtime,size) 直接复用；未命中才读文件内容算 hash，并周期性让位
  async _hashForAsync(full, mtimeMs, size) {
    this._loadScanCache();
    const key = this._scanKey(full);
    const cached = this._scanCache.get(key);
    if (cached && cached.mtimeMs === mtimeMs && cached.size === size) return cached.hash;
    let h = null;
    try { h = crypto.createHash('md5').update(await fs.promises.readFile(full)).digest('hex'); } catch (e) { h = null; }
    this._scanCache.set(key, { mtimeMs, size, hash: h });
    this._scanDirty = true;
    this._scanDirtyKeys.add(key);
    return h;
  }

  // 异步版 listProjects：缓存命中时与同步版等价（毫秒级）；未命中走异步扫描，不阻塞主进程。
  // 返回值与 listProjects 完全一致（供 IPC / HTTP 路由替换）。
  async listProjectsAsync(force = false, opts) {
    if (force) {
      this._emitScan('clear');
      this._invalidateCaches(true);
      this._rebuildClipIndexAsync();
      try { setImmediate(() => { this._emitScan('mark'); this._warmWatermarkCache(); }); } catch (e) {}
    }
    if (!force && this._projectsCache) return this._projectsCache;
    // 并发合并：启动预热、托盘唤起、前端 IPC / HTTP 首次加载几乎同时调用，
    // 不合并则同一份扫描并发跑多遍（各自遍历工作目录 + 读文件），冷态下代价成倍放大。
    if (!force && this._projectsInflight) return this._projectsInflight;
    const seq = this._projectsSeq || 0;
    const run = (async () => {
      this._emitScan('walk');
      await this._collectLogFilesAsync(opts);
      this._emitScan('log');
      await this._collectAllTxtAsync(opts);
      this._emitScan('list');
      const data = this._buildProjectsData();
      if (seq === (this._projectsSeq || 0)) this._projectsCache = data;   // 期间被 force 刷新过则丢弃本次结果
      return data;
    })();
    if (!force) {
      this._projectsInflight = run;
      const clear = () => { if (this._projectsInflight === run) this._projectsInflight = null; };
      run.then(clear, clear);
    }
    return run;
  }

  // 异步版日志收集：缓存有效则秒回；否则异步遍历
  async _collectLogFilesAsync(opts) {
    if (this._logCache && this._logCacheRoot === this.root) return this._logCache;
    this._loadLogCache();
    if (this._logCache && this._logCacheRoot === this.root && this._logCache.files && this._logCache.files.length) {
      const fp = await this._logTreeFingerprintAsync();
      if (fp && fp === this._logCache.fp) return this._logCache;
    }
    const files = [];
    let rootOk = false;
    try { rootOk = (await fs.promises.stat(this.root)).isDirectory(); } catch (e) { rootOk = false; }
    if (rootOk) {
      const skip = new Set(EXCLUDED_TOP_DIRS);
      const all = await walkFilesAsync(this.root, opts);
      for (const full of all) {
        const base = path.basename(full);
        if (!base.toLowerCase().endsWith('.txt')) continue;
        if (!LOG_NAME_RE.test(base)) continue;
        const config = this._configNameFromLog(full);
        if (!config) continue;
        const rel = path.relative(this.root, full).split(path.sep);
        if (skip.has(rel[0])) continue;
        files.push({ project: rel[0], name: base, path: full, date: this._dateBranchOf(full), config });
      }
    }
    this._logCache = { files, fp: await this._logTreeFingerprintAsync() };
    this._logCacheRoot = this.root;
    this._saveLogCache();
    return this._logCache;
  }

  // 扫描/重建环节状态上报：phase ∈ clear/walk/log/clip/mark/list/done，前端按阶段映射中文提示
  _emitScan(phase, done, total) {
    if (typeof this.onScanProgress !== 'function') return;
    try { this.onScanProgress({ phase: String(phase || ''), done: done || 0, total: total || 0 }); } catch (e) {}
  }

  listProjects(force = false) {
    if (force) {
      this._emitScan('clear');
      this._invalidateCaches(true);   // force：连持久化缓存一并清，确保真重扫
      // 重建成片索引：后台分批重建（解析日志+写大缓存），不阻塞本次列表返回；搜索仍走按目录惰性命中
      this._rebuildClipIndexAsync();
      // 刷新配置时预填充水印缓存：缺失项目归属补算，已有条目不动（后台，不阻塞本次列表返回）
      try { setImmediate(() => { this._emitScan('mark'); this._warmWatermarkCache(); }); } catch (e) {}
    }
    if (!force && this._projectsCache) {
      return this._projectsCache;
    }
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
          this._recycleFile(s.full);
          deleted.push(s.full);
        }
      }
    }
    if (commit && deleted.length) {
      const info = this._describeForLog(deleted);
      this._lg('DEL', 'clean.duplicate.sources',
        '清理重复星标素材 · ' + info.count + ' 个文件 · 共 ' + this._humanSize(info.bytes), info);
      this._markConfigModified();
    }
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
      // 外部 * 配置：位于成片文件夹之外（路径不含「成片」段），其「成片」不在本分支目录内，
      // 整体删除会连累同目录下其它任务的产物 → 拒绝 folder 整体删除，仅允许 txt/both
      const inChengpian = String(filePath).split(/[\\/]/).some((p) => p.endsWith('成片'));
      if (mode === 'folder' && !inChengpian) return { ok: false, error: '该配置不在成片文件夹内（外部配置），不能整体删除；请选「仅移除该配置」' };
      if (mode === 'folder') {
        if (dir.length <= root.length) return { ok: false, error: '不允许删除工作根目录' };
        // 整个文件夹走回收站（可还原），不再递归永久删除
        if (!this._recycleFile(dir)) return { ok: false, error: '移入回收站失败' };
      } else {
        if (mode === 'both') {
          let entries = [];
          try { entries = fs.readdirSync(dir); } catch (e) {}
          for (const ent of entries) {
            const full = path.join(dir, String(ent));
            let st;
            try { st = fs.statSync(full); } catch (e) { continue; }
            if (st.isFile() && String(ent).toLowerCase().endsWith('.txt')) this._recycleFile(full);
          }
        } else {
          if (!filePath.toLowerCase().endsWith('.txt')) return { ok: false, error: '仅支持移除 TXT 分支' };
          this._recycleFile(filePath);
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

  // ── 数据缓存持久层（<storageDir>\cache.db）──
  // 唯一持久层：Ticks 以 TEXT 精确承载（INTEGER 列读 Int64 会抛 RangeError）、
  // 支持增量写与 backend↔引擎跨进程并发（WAL）。
  // 旧 JSON 数据由启动期的布局迁移器（engines/base/migrate.js）一次性并入，此处不做 JSON 迁移。
  // 库不可打开时（极端异常）退化为纯内存：本次会话照常出片与预检测，只是不落盘，也不产生任何回退文件。

  // 作用域位掩码：与 engines/base/cache.js 的 SCOPES 同源（惰性取用，避免构造期依赖引擎目录）；
  // 取不到时用等价内联值兜底，行为不随加载失败而改变。
  get _scopes() {
    if (!this._scopesCache) {
      try { this._scopesCache = require(path.join(this.enginesDir, 'base', 'cache.js')).SCOPES; }
      catch (e) { this._scopesCache = { batch: 1, replica: 2, mask: 4 }; }
    }
    return this._scopesCache;
  }

  // 选择数据缓存后端（进程内只判定一次）
  _useDbCache() {
    if (this._cacheBackendMode) return this._cacheBackendMode === 'db';
    const dbPath = this.cacheDbPath;
    if (!dbPath) { this._cacheBackendMode = 'mem'; return false; }
    let store = null;
    try {
      const CacheStore = require(path.join(this.enginesDir, 'base', 'cache.js'));
      store = new CacheStore(dbPath, { root: this.root });
      store.open();
    } catch (e) { store = null; }
    this._cacheStore = store;
    this._cacheBackendMode = store ? 'db' : 'mem';
    if (!store) console.error('[cache] 缓存库不可用，本次会话退化为纯内存（出片不受影响）');
    return !!store;
  }

  // 设置库（<storageDir>\settings.db）：批量 / 遮罩等项目设置的持久层，不可用时同样退化纯内存
  _useSettings() {
    if (this._settingsMode) return this._settingsMode === 'db';
    const dbPath = this.settingsDbPath;
    if (!dbPath) { this._settingsMode = 'mem'; return false; }
    let store = null;
    try {
      const SettingsStore = require(path.join(this.enginesDir, 'base', 'settings.js'));
      store = new SettingsStore(dbPath);
      store.open();
    } catch (e) { store = null; }
    this._settingsStore = store;
    this._settingsMode = store ? 'db' : 'mem';
    if (!store) console.error('[settings] 设置库不可用，本次会话退化为纯内存（出片不受影响）');
    return !!store;
  }

  // 移入系统回收站（可还原）。两步走：① 同步把原路径改名摘除 —— 调用方（如重跑前清旧产物）
  // 需要"旧文件立刻不再冲突"，异步送站做不到这一点；② 再异步送回收站。
  // 送站失败时文件以 .bak 形态保留，绝不静默永久删除。
  _recycleFile(p) {
    if (!p || !fs.existsSync(p)) return false;
    let target = p;
    try {
      const bak = p + '.bak';
      fs.renameSync(p, bak);
      target = bak;
    } catch (e) { /* 改名失败：退回直接送回收站 */ }
    try {
      const { shell } = require('electron');
      if (shell && typeof shell.trashItem === 'function') {
        shell.trashItem(target).catch(() => {});   // 失败则保留 target，数据不丢
        return true;
      }
    } catch (e) {}
    return true;   // 非 Electron 环境：已摘除原路径，以 .bak 形态保留
  }

  // 标记缓存变更：记录具体键，据此做增量写（避免每次全量 upsert）
  _markVideoCacheDirty(vPath) {
    this._videoCacheDirty = true;
    if (vPath) this._videoCacheDirtyKeys.add(String(vPath));
  }

  _markVideoCacheRemoved(vPath) {
    this._videoCacheDirty = true;
    const k = String(vPath);
    this._videoCacheDirtyKeys.delete(k);
    this._videoCacheRemovedKeys.add(k);
  }

  _loadVideoCache() {
    if (this._videoCache !== null) return this._videoCache;
    let cache = {};
    if (this._useDbCache()) {
      // 默认作用域：批量 + 复刻。遮罩素材必须由调用方显式声明掩码才会被读到。
      try { cache = this._cacheStore.loadVideoMap({ scopesMask: this._scopes.batch | this._scopes.replica }); }
      catch (e) { cache = {}; }
    }
    // 库不可用时不落盘：探测结果仅在本会话内复用（重新打开应用后重探一次）
    this._videoCache = cache;
    this._videoCacheDirty = false;
    this._videoCacheDirtyKeys.clear();
    this._videoCacheRemovedKeys.clear();
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

  // 文件指纹：mtime（Ticks）+ 字节大小。
  // ⚠ 只比 mtime 不足以判断"素材是否被替换"：Windows 的 CopyFile（含资源管理器粘贴）、
  //   解压、同步工具都会保留源文件的修改时间 —— 覆盖同名素材后时间戳可能分毫不变，
  //   指纹不变 → 预检测一直沿用旧结论，表现为"重新覆盖正确文件后仍显示不合格，
  //   刷新配置/切换配置/刷新预缓存都无效，只有重开软件才好"。
  //   大小与 mtime 一起比：一次 statSync 同时取到，且分辨率/内容变过的文件大小几乎必变。
  _fileFingerprint(p) {
    try {
      const st = fs.statSync(p, { bigint: true });
      return { ticks: String((st.mtimeNs / 100n) + 621355968000000000n), size: Number(st.size) || 0 };
    } catch (e) { return null; }
  }
  // 缓存条目是否仍与当前文件一致（size 缺失或为 0 的旧条目退化为只比 mtime）
  _fingerprintMatches(fp, ticks, size) {
    if (!fp) return false;
    if (this._ticksToStr(ticks) !== fp.ticks) return false;
    const sz = Number(size) || 0;
    return sz === 0 || sz === fp.size;
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

  // 读取缓存视频信息：命中且指纹（mtime + 大小）未变则复用，否则返回 null（交由并发探测）
  _fetchCachedVideoInfo(videoPath) {
    const fp = this._fileFingerprint(videoPath);
    if (!fp) return null;
    const hit = this._videoInfoCache.get(videoPath);
    if (hit) {
      // 内存条目不带指纹，必须回缓存核对后才能复用 —— 否则同名覆盖后一直返回旧结论
      const c0 = this._loadVideoCache()[videoPath];
      if (this._fingerprintMatches(fp, c0 && c0.LastWriteTime, c0 && c0.FileSize)) return hit;
      this._videoInfoCache.delete(videoPath);
    }
    const cache = this._loadVideoCache();
    const cached = cache[videoPath];
    if (this._fingerprintMatches(fp, cached && cached.LastWriteTime, cached && cached.FileSize)) {
      const info = { valid: !!cached.Valid, duration: Number(cached.Duration) || 0, width: cached.Width || 0, height: cached.Height || 0 };
      this._videoInfoCache.set(videoPath, info);
      return info;
    }
    if (cached) { delete cache[videoPath]; this._markVideoCacheRemoved(videoPath); } // 指纹变化，丢弃旧缓存交由重新探测
    return null;
  }

  // 按作用域读取探测结果：指纹未变才命中；命中写入内存缓存键（含作用域，避免与其它模式串用）
  _fetchScopedVideoInfo(videoPath, scope) {
    const key = scope + '\u0000' + videoPath;
    const fp = this._fileFingerprint(videoPath);
    if (!fp) return null;
    const hit = this._videoInfoCache.get(key);
    if (hit) {
      // 同 _fetchCachedVideoInfo：内存条目不带指纹，须回库核对后才能复用
      let r0 = null;
      try { r0 = this._useDbCache() ? this._cacheStore.getVideo(videoPath, { scopesMask: scope }) : null; } catch (e) { r0 = null; }
      if (this._fingerprintMatches(fp, r0 && r0.last_write, r0 && r0.file_size)) return hit;
      this._videoInfoCache.delete(key);
    }
    if (!this._useDbCache()) return null;
    let row = null;
    try { row = this._cacheStore.getVideo(videoPath, { scopesMask: scope }); } catch (e) { return null; }
    if (!this._fingerprintMatches(fp, row && row.last_write, row && row.file_size)) return null;
    const info = {
      valid: !!row.valid, duration: Number(row.duration) || 0,
      width: Number(row.width) || 0, height: Number(row.height) || 0,
    };
    this._videoInfoCache.set(key, info);
    return info;
  }

  // 按作用域写入探测结果：scopes 按位或累加，不覆盖其它模式已有的来源标记
  _saveScopedVideoInfo(videoPath, info, scope) {
    if (!this._useDbCache()) return false;
    try {
      this._cacheStore.upsertVideo(videoPath, {
        lastWrite: this._ticksToStr(this._mtimeToTicks(videoPath)),
        duration: info.duration, width: info.width, height: info.height,
        valid: info.valid, scopes: scope, fileSize: this._fileSize(videoPath),
      });
      this._videoInfoCache.set(scope + '\u0000' + videoPath, {
        valid: !!info.valid, duration: Number(info.duration) || 0,
        width: Number(info.width) || 0, height: Number(info.height) || 0,
      });
      return true;
    } catch (e) { return false; }
  }

  // 文件字节大小（计数认领的多命中消歧依据；取不到记 0，不影响其它逻辑）
  _fileSize(p) {
    try { return Number(fs.statSync(p).size) || 0; } catch (e) { return 0; }
  }

  // 遮罩素材信息：先按「遮罩作用域」查缓存，命中直接用时长；未命中才 ffprobe 并写回缓存。
  // 遮罩列表此前每次打开都全量探测，接缓存后重复打开不再重复启动 ffprobe。
  async _maskMediaInfo(videoPath) {
    const cached = this._fetchScopedVideoInfo(videoPath, this._scopes.mask);
    if (cached) return cached;
    const info = await this._probeVideoAsync(videoPath);
    this._saveScopedVideoInfo(videoPath, info, this._scopes.mask);
    return info;
  }

  // 计数认领：缓存未命中的路径（本轮新素材）先尝试从既有条目继承使用计数。
  // 素材改名 / 移位后不再被当作全新素材重新计数；与任务引擎共用持久层的同一实现，
  // 保证「刷新预检测」与「跑任务」两条路径行为一致。
  // 认领成功后原条目的路径整体转到新路径（含计数与作用域标记），旧路径随之消失。
  // 返回真正发生迁移的条数（已在库中的路径不算）。
  // 认领使用计数：新路径（素材被替换/移动后）继承既有同字节条目的使用计数。
  // scopesMask 默认批量|复刻；遮罩素材刷新时传 mask —— 三类归属各自认领，互不干扰。
  _claimUsageForPaths(paths, scopesMask) {
    if (!paths || !paths.length || !this._useDbCache()) return 0;
    const store = this._cacheStore;
    const mask = Number(scopesMask) || (this._scopes.batch | this._scopes.replica);
    let n = 0;
    for (const p of paths) {
      try {
        const r = store.claimUsage(p, this._ticksToStr(this._mtimeToTicks(p)), {
          fileSize: this._fileSize(p), scopesMask: mask, scopes: mask,
        });
        if (r && r.adopted && Number(r.usageCount) > 0) n++;
      } catch (e) { /* 单条认领失败不影响预检测 */ }
    }
    return n;
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
    const claimed = this._claimUsageForPaths(needProbe); // 新路径先认领既有条目的使用计数
    if (claimed > 0) console.log('[video_cache] 已识别 ' + claimed + ' 个素材的既有使用计数（路径变化）');
    const infos = await this._runWithLimit(needProbe, (p) => this._probeVideoAsync(p).then((info) => { tick(); return info; }), this.probeConcurrency);
    const cache = this._loadVideoCache();
    for (let i = 0; i < needProbe.length; i++) {
      const p = needProbe[i];
      const info = infos[i] || { valid: false, duration: 0, width: 0, height: 0 };
      cache[p] = {
        LastWriteTime: this._ticksToStr(this._mtimeToTicks(p)), Duration: info.duration,
        Valid: info.valid, Width: info.width, Height: info.height, FileSize: this._fileSize(p),
      };
      this._videoInfoCache.set(p, info);
      result.set(p, info);
      this._markVideoCacheDirty(p);
    }
    return result;
  }

  // 缓存落盘：只写脏键（增量事务）。
  // 刻意不做同步写：大缓存下序列化 + write 可达数十毫秒，同步执行会推迟同期 IPC 响应，
  // 前端表现为行内徽章长时间停在「检测中…」。
  // full=true 用于「重置后整体替换」——此时内存对象即全量，脏键集合不代表全量。
  async _saveVideoCache(full) {
    const snapshot = this._videoCache;
    // 纯内存态（库不可用）：无需落盘，清脏标记即可
    if (!(this._cacheBackendMode === 'db' && this._cacheStore)) {
      if (this._videoCache === snapshot) {
        this._videoCacheDirty = false;
        this._videoCacheDirtyKeys.clear();
        this._videoCacheRemovedKeys.clear();
      }
      return;
    }
    const upserts = {};
    if (snapshot) for (const k of this._videoCacheDirtyKeys) if (snapshot[k]) upserts[k] = snapshot[k];
    const deletes = Array.from(this._videoCacheRemovedKeys);
    if (!full && !Object.keys(upserts).length && !deletes.length) { this._videoCacheDirty = false; return; }
    try {
      if (full) this._cacheStore.replaceVideoMap(snapshot || {});
      else this._cacheStore.applyVideoDelta(upserts, deletes);
    } catch (e) { return; } // 写入失败保留脏标记，下次再试
    if (this._videoCache === snapshot) {
      this._videoCacheDirty = false;
      this._videoCacheDirtyKeys.clear();
      this._videoCacheRemovedKeys.clear();
    }
  }

  // 失效清理「判定分区」：分出「当场可判」与「需核验文件是否存在」两组。
  // 免 IO 是本函数的意义：本轮刚枚举过的路径（knownPaths）必然存在，无需再 stat；
  // 非当前 root 的残留条目直接判删，同样无需 stat。只有两者都不适用（手动清理、目录已从配置移除）
  // 才落到 verify —— 这正是把「数千次同步 stat」压缩成「通常为零」的关键。
  _videoCacheGcPlan(knownPaths) {
    const c = this._videoCache;
    const verify = [];
    if (!c) return { drop: [], verify, missing: new Set(), expired: new Set() };
    for (const f of Object.keys(c)) {
      if (knownPaths && knownPaths.has(f)) continue; // 刚枚举到 → 文件必然存在
      verify.push(f);
    }
    return { drop: [], verify, missing: new Set(), expired: new Set() };
  }

  // video_cache 失效清理（异步分批）：核验「文件是否仍存在」，不存在只置位、不删除。
  // 保留期内的条目仍留在库中 —— 素材移位后新路径才有机会认领它的使用计数；
  // 到期仍不存在才真删；文件重新出现则清除置位（复活），计数一并保留。
  // 每 YIELD 条让出一次事件循环：主线程始终能响应 IPC，前端不再出现长时间「检测中…」。
  // 判定分区由持久层给出（库走 gcPlan，纯内存态走 _videoCacheGcPlan），语义一致。
  async _gcVideoCache(knownPaths) {
    if (!this.storageDir) return 0;
    const store = (this._cacheBackendMode === 'db' && this._cacheStore) ? this._cacheStore : null;
    this._loadVideoCache();
    const c = this._videoCache;
    if (!c) return 0;
    let plan;
    try { plan = store ? store.gcPlan(knownPaths, { now: Date.now() }) : this._videoCacheGcPlan(knownPaths); }
    catch (e) { if (store) return 0; plan = this._videoCacheGcPlan(knownPaths); }
    const gone = [], back = [];
    const YIELD = 256;
    for (let i = 0; i < plan.verify.length; i++) {
      // 让路期间缓存可能已被重置/重载（取消预检测、切工作目录）→ 放弃本次清理，避免写回陈旧快照
      if (this._videoCache !== c) return 0;
      let missing = false;
      try { await fs.promises.stat(plan.verify[i]); } catch (e) { missing = true; }
      if (missing) gone.push(plan.verify[i]);
      else back.push(plan.verify[i]);
      if ((i + 1) % YIELD === 0) await new Promise((r) => setImmediate(r));
    }
    if (this._videoCache !== c) return 0;
    if (!store) {
      // 纯内存态没有保留期概念（会话结束即消失）：核验不存在的条目直接丢弃
      for (const f of plan.drop.concat(gone)) delete c[f];
      if (!gone.length) return 0;
      this._videoCacheDirty = true;
      await this._saveVideoCache();
      return gone.length;
    }
    const expired = plan.expired || new Set();
    const stillMissing = gone.filter((p) => !expired.has(p));
    const remove = gone.filter((p) => expired.has(p));
    let removed = 0;
    try {
      if (stillMissing.length) store.markMissing(stillMissing, Date.now());
      if (back.length) store.clearMissing(back); // 文件已放回 → 复活并保留计数
      if (remove.length) removed = store.deleteVideos(remove);
    } catch (e) { return 0; }
    for (const f of remove) delete c[f];
    return removed;
  }

  // 触发一次失效清理：启动时与「清理数据缓存」手动入口调用（无定时器，全部为显式触发）
  async _gcVideoCacheNow() {
    if (!this.storageDir) return 0;
    try { return await this._gcVideoCache(); } catch (e) { return 0; }
  }

  // 前台接口：清理 video_cache 失效条目（手动入口，返回删除数）
  async cleanVideoCache() {
    const removed = await this._gcVideoCacheNow();
    return { ok: true, removed: removed || 0 };
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

  // .lnk 目标解析：直接读二进制（不再 spawn pwsh —— 预检测剩余的数百毫秒主要来自这里）。
  // 解析器与 batch 模块共用底座实现（engines/base/lnk.js）；失败一律降级为空串，不中断预检测。
  _parseLnkTarget(lnk) {
    if (this._lnkParser === undefined) {
      try { this._lnkParser = require(path.join(this.enginesDir, 'base', 'lnk.js')).parseLnkTarget || null; }
      catch (e) { this._lnkParser = null; }
    }
    if (typeof this._lnkParser !== 'function') return '';
    try { return String(this._lnkParser(lnk) || '').trim(); } catch (e) { return ''; }
  }

  // 解析结果缓存读取：命中且 lnk 文件未变（mtime 相同）直接复用；未缓存返回 null，缓存了「无目标」返回 ''
  _lnkCached(lnk) {
    const c = this._lnkCache.get(lnk);
    if (!c) return null;
    let mtimeMs = null;
    try { mtimeMs = fs.statSync(lnk).mtimeMs; } catch (e) { mtimeMs = null; }
    if (mtimeMs === null || mtimeMs === c.mtimeMs) return c.target;
    this._lnkCache.delete(lnk);
    return null;
  }

  _lnkStore(lnk, target) {
    let mtimeMs = null;
    try { mtimeMs = fs.statSync(lnk).mtimeMs; } catch (e) { mtimeMs = null; }
    this._lnkCache.set(lnk, { mtimeMs, target: String(target || '') });
  }

  // 分流：命中缓存的直接给结果，其余交给解析器
  _lnkSplit(paths) {
    const out = {};
    const todo = [];
    for (const p of paths) {
      const hit = this._lnkCached(p);
      if (hit !== null) { if (hit) out[p] = hit; continue; }
      todo.push(p);
    }
    return { out, todo };
  }

  // 批量解析 .lnk 快捷方式目标（与视频批量脚本语义一致）：返回 { lnkPath: targetPath }；
  // 解析失败/失效返回空对象降级，不影响预检测其余流程。纯内存操作，同步即可（不再有 pwsh 进程开销）。
  _resolveShortcutTargets(paths) {
    if (!paths || !paths.length) return {};
    const { out, todo } = this._lnkSplit(paths);
    for (const p of todo) {
      const target = this._parseLnkTarget(p);
      this._lnkStore(p, target);
      if (target) out[p] = target;
    }
    return out;
  }

  // 保留异步入口：预检测/重置等调用方无需改动；内部已改为纯内存解析，不再阻塞主线程（原 spawnSync 最坏阻塞 10s）
  async _resolveShortcutTargetsAsync(paths) {
    return this._resolveShortcutTargets(paths);
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
        const map = await this._resolveShortcutTargetsAsync(lnks);
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
                cc[key] = { LastWriteTime: this._ticksToStr(this._mtimeToTicks(key)), Duration: info.duration, Valid: info.valid, Width: info.width, Height: info.height, FileSize: this._fileSize(key) };
                this._videoInfoCache.set(key, info);
                this._markVideoCacheDirty(key);
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
    // 仅在有实际变更时落盘：常态（全部命中缓存）下预检测完全不写盘，行内徽章立即出结果
    if (this._videoCacheDirty) await this._saveVideoCache();
    return results;
  }

  // 重置预检测：清除物理缓存，收集所有配置指向的路径并全量探测（跨路径去重），可实时回报进度
  // 收集所有配置指向的视频候选：跨配置路径去重、目录递归收集、跳过非视频扩展名
  // 异步：快捷方式解析走非阻塞通道，避免「检测中」期间主线程被 pwsh 启动阻塞
  async _gatherAllVideos() {
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
    // 遮罩模式登记的素材目录（含手动添加的项目外路径）一并纳入刷新范围 ——
    // 增量探测成本低，用户点一次即可同时刷新批量与遮罩的预缓存，不必分两处各点一次
    for (const p of this._maskSessionDirs()) pathSet.add(p);
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
          const map = await this._resolveShortcutTargetsAsync(lnks);
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
    const allVideos = await this._gatherAllVideos();

    const report = (s) => { if (onProgress) { try { onProgress(s); } catch (e) {} } };
    const total = allVideos.length;
    let probed = 0, valid = 0;
    const cache = this._loadVideoCache();
    const token = ++this._precheckToken; // 本次探测的令牌：作废任何更早的后台探测
    await this._runWithLimit(allVideos, async (f) => {
      // 行内预检测优先：后台探测遇用户操作让路（每批轮询，短暂让出 IO）
      if (this._inlineProbing > 0) await new Promise((r) => setTimeout(r, 80));
      const info = await this._probeVideoAsync(f);
      cache[f] = { LastWriteTime: this._ticksToStr(this._mtimeToTicks(f)), Duration: info.duration, Valid: info.valid, Width: info.width, Height: info.height, FileSize: this._fileSize(f) };
      this._videoInfoCache.set(f, info);
      probed++;
      if (info.valid) valid++;
      report({ done: probed, total });
    }, this.probeConcurrency, () => token !== this._precheckToken);

    const cancelled = token !== this._precheckToken;
    if (cancelled) { // 取消/中断：丢弃本次内存探测结果，下次从原缓存文件重新加载（不覆盖原文件）
      this._videoCache = null;
      this._videoInfoCache = new Map();
    } else { await this._saveVideoCache(true); } // 全部完成才整体替换缓存；取消/中断时保留原缓存
    report({ done: probed, total, finished: true, cancelled });
    return { ok: true, total, valid, invalid: total - probed, cancelled };
  }

  // 仅刷新预缓存：不删缓存、不重置，只对「缺失或 mtime 已变」的视频重新探测更新；
  // 命中（缓存有效）的路径直接跳过，进度按全量候选回报（起始即跳过数）
  async refreshPrecache(onProgress) {
    const report = (s) => { if (onProgress) { try { onProgress(s); } catch (e) {} } };
    const allVideos = await this._gatherAllVideos();
    const total = allVideos.length;
    const cache = this._loadVideoCache();
    const toProbe = [];
    for (const f of allVideos) {
      const c = cache[f];
      // 指纹 = mtime + 大小：覆盖同名素材时时间戳可能被保留（CopyFile / 解压 / 同步工具都如此），
      // 只比 mtime 会漏判 —— 表现为「刷新预缓存」跳过了其实已被替换的文件
      const fp = this._fileFingerprint(f);
      if (c && this._fingerprintMatches(fp, c.LastWriteTime, c.FileSize)) continue; // 已缓存且文件未变：跳过
      toProbe.push(f);
    }
    const base = total - toProbe.length; // 进度起点 = 已跳过数
    const token = ++this._precheckToken; // 作废旧探测，保证只跑本次
    let probed = 0, valid = 0;
    await this._runWithLimit(toProbe, async (f) => {
      // 行内预检测优先：与全量重置同一让路策略
      if (this._inlineProbing > 0) await new Promise((r) => setTimeout(r, 80));
      const info = await this._probeVideoAsync(f);
      cache[f] = { LastWriteTime: this._ticksToStr(this._mtimeToTicks(f)), Duration: info.duration, Valid: info.valid, Width: info.width, Height: info.height, FileSize: this._fileSize(f) };
      this._videoInfoCache.set(f, info);
      this._markVideoCacheDirty(f);
      probed++;
      if (info.valid) valid++;
      report({ done: base + probed, total });
    }, this.probeConcurrency, () => token !== this._precheckToken);

    const cancelled = token !== this._precheckToken;
    if (cancelled) { // 取消/中断：丢弃本次内存增量，下次从原缓存重新加载（不覆盖原缓存）
      this._videoCache = null;
      this._videoInfoCache = new Map();
    } else { await this._saveVideoCache(); } // 已完成的增量结果才写入缓存；取消/中断保留原缓存
    report({ done: base + probed, total, finished: true, cancelled });
    // 失效清理放到后台执行（用户主动点刷新即清，不受后台 1h 节流限制）。
    // 传入本次刚枚举出的路径集合：这些文件必然存在，GC 直接判「保留」，不再逐条 fs.stat
    // （原先数千条同步 existsSync 会占住主线程数秒～数十秒，把紧随其后的行内预检测 IPC 一起堵住，
    //  前端表现为刷新完成后徽章仍长时间停在「检测中…」）；剩余候选项也已异步分批并让路事件循环。
    // 遮罩素材：单独认领使用计数并落库标注 mask 作用域 ——
    // 作用域位掩码即归属标记（与批量/复刻分开，同一素材多模式共用时按位或累加）；
    // 它们已在 allVideos 中，失效清理不会误判为「非当前 root 的残留」而删除；
    // 素材被暂时删除/替换时，DB 侧只置 missing_since 走软删除，并在保留期内等待新路径认领。
    if (!cancelled) {
      const maskFiles = [];
      for (const d of this._maskSessionDirs()) {
        try {
          const st = fs.statSync(d);
          if (st.isDirectory()) { for (const f of walkFiles(d)) if (VIDEO_EXTS.has(path.extname(f).toLowerCase())) maskFiles.push(f); }
          else if (VIDEO_EXTS.has(path.extname(d).toLowerCase())) maskFiles.push(d);
        } catch (e) { /* 目录不存在时跳过（软删除留待保留期处理） */ }
      }
      if (maskFiles.length) {
        const claimedMask = this._claimUsageForPaths(maskFiles, this._scopes.mask);
        if (claimedMask > 0) console.log('[video_cache] 遮罩素材认领既有使用计数 ' + claimedMask + ' 条');
        for (const f of maskFiles) {
          const c = cache[f];
          if (c && typeof c.Duration === 'number') {
            this._saveScopedVideoInfo(f, { duration: c.Duration, width: c.Width || 0, height: c.Height || 0, valid: !!c.Valid }, this._scopes.mask);
          }
        }
      }
    }
    if (!cancelled) {
      this._gcVideoCache(new Set(allVideos))
        .then((n) => { if (n > 0) console.log('[video_cache] 后台清理失效条目 ' + n + ' 条'); })
        .catch(() => { /* 后台清理失败不影响刷新结果 */ });
    }
    return { ok: true, total, updated: probed, valid, cancelled, removed: 0 };
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
  //    与数据缓存同库（cache.db 的 clip_index 表），冷启动直接复用，避免每次搜索全量读盘解析。
  //    旧数据由布局迁移器并入（见 engines/base/migrate.js）。
  // 打开索引所在连接：与数据缓存同库，直接复用其连接；库不可用时返回 null → 索引退化为纯内存模式
  _openClipDb() {
    try {
      if (!this._useDbCache() || !this._cacheStore) return null;
      return this._cacheStore.open();
    } catch (e) { return null; }
  }

  _loadClipIndex() {
    if (this._clipIndex && this._clipIndexRoot === this.root) return;
    this._clipIndexRoot = this.root;
    this._clipIndex = new Map();
    const db = this._openClipDb();
    if (!db) return;
    try {
      const rows = db.prepare('SELECT dir, mtime, entries FROM clip_index').all();
      const prefix = String(this.root || '').replace(/[\\/]+$/, '');
      for (const r of rows) {
        if (!String(r.dir).startsWith(prefix)) continue; // 仅载入当前工作目录下的条目
        try { this._clipIndex.set(r.dir, { mtime: r.mtime, entries: JSON.parse(r.entries) }); } catch (e) {}
      }
    } catch (e) {}
  }

  _saveClipIndex() {
    if (!this._clipIndexDirty) return;
    if (!this._openClipDb()) { this._clipIndexDirty = false; return; } // 纯内存态：无需落盘
    const db = this._cacheStore.open();
    try {
      this._cacheStore.transaction(() => {
        const ins = db.prepare('INSERT INTO clip_index(dir, mtime, entries) VALUES (?, ?, ?) ON CONFLICT(dir) DO UPDATE SET mtime=excluded.mtime, entries=excluded.entries');
        this._clipIndex.forEach((v, k) => { if (Array.isArray(v.entries)) ins.run(k, v.mtime, JSON.stringify(v.entries)); });
      });
      this._clipIndexDirty = false;
    } catch (e) {}
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
          const hit = fs.readdirSync(dir).find((n) => /\.mp4$/i.test(n) && (n.toLowerCase().replace(/\.mp4$/i, '') === baseName || n.toLowerCase().replace(/\.mp4$/i, '').replace(/^\d{6}改\d*-/, '') === baseName));
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

  _parseLog(logPath, text) {
    if (text == null) text = readText(logPath);
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
  // 任务定位信息：解析任务来源（配置 TXT / 日志 TXT）供主窗口「定位至配置/日志」
  taskLocate(taskId) {
    const t = this.tasks.get(taskId);
    if (!t) return { ok: false, error: '任务不存在' };
    const info = { ok: true, project: '', name: '', txtPath: '', logPath: '', mode: t.type === 'replica' ? 'log' : '' };
    const src = String((t.env && t.env.REPLICA_TXT) || '').trim();
    if (src) {
      const abs = path.resolve(src);
      info.name = path.basename(abs, path.extname(abs));
      if (this.root) {
        const rel = path.relative(this.root, abs).split(path.sep);
        if (rel.length && rel[0] !== '..') info.project = rel[0];
      }
      if (t.type === 'replica') {
        info.project = REPLICA_PROJECT; // 主窗口定位目标为虚拟复刻项目
        // 输出目录与复刻日志按提交日期推算（与脚本 Get-TaskDate 一致），模式名来自 REPLICA_MODE
        const outc = this._replicaOutInfo(t);
        if (!outc) return { ok: false, error: '缺少复刻源日志，无法定位' };
        // 复刻输出目录未生成：不允许定位（不得退回源日志日期目录）
        if (!outc.outDir || !fs.existsSync(outc.outDir) || !fs.statSync(outc.outDir).isDirectory()) {
          return { ok: false, error: '复刻成片文件夹未生成，无法定位' };
        }
        info.replicaMode = outc.mode;
        // 定位本次复刻生成的输出日志（<MMdd>-<模式名>日志.txt，取同日最新）；无日志文件同样拒绝定位
        let logFile = '';
        try {
          const pat = new RegExp('^\\d{4}-' + outc.mode.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '日志\\.txt$');
          const logs = fs.readdirSync(outc.outDir).filter((n) => pat.test(n)).sort();
          if (logs.length) logFile = path.join(outc.outDir, logs[logs.length - 1]);
        } catch (e) {}
        if (!logFile) return { ok: false, error: '未找到本次复刻的日志文件，无法定位' };
        info.logPath = logFile;
      }
      else info.txtPath = abs;
    }
    // 批量任务：成片目录内优先匹配当前配置的日志 TXT
    if (t.type === 'batch' && t.outDir) {
      try {
        const hit = fs.readdirSync(t.outDir).find((n) => LOG_NAME_RE.test(n));
        if (hit) info.logPath = path.join(t.outDir, hit);
      } catch (e) {}
    }
    return info;
  }

  // 复刻任务的输出目录推算：与 video_replica.ps1 的 Get-TaskDate + baseDir 规则完全一致——
  // 日期用提交时刻（REPLICA_SUBMIT_TS，续跑亦注入），层级 月份/MMdd/模式名；
  // baseDir 取源日志路径中首个月份/MMdd 段之前，无日期段时回退日志所在目录
  _replicaOutInfo(t) {
    const env = (t && t.env) || {};
    const src = String(env.REPLICA_TXT || '').trim();
    const mode = String(env.REPLICA_MODE || '1') === '2' ? '去重复刻' : '原片复刻';
    if (!src) return null;
    let d = new Date();
    const ts = Number(env.REPLICA_SUBMIT_TS || 0);
    if (ts > 0) d = new Date(ts);
    const month = (d.getMonth() + 1) + '月';
    const day = String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
    const parts = path.resolve(src).split(path.sep);
    let idx = parts.findIndex((p) => /^\d+月$/.test(p));
    if (idx < 0) idx = parts.findIndex((p) => /^\d{4}$/.test(p));
    let base;
    if (idx > 0) base = parts.slice(0, idx).join(path.sep);
    else if (idx === 0) base = parts[0];
    else base = path.dirname(path.resolve(src));
    return { outDir: path.join(base, month, day, mode), mode };
  }

  // 复刻任务的成片输出目录：按提交日期推算复刻产物目录（月份/MMdd/模式目录）；
  // 目录不存在即明确报错「未生成」，绝不退而求其次指向源日志目录（那里是原始日志与素材）
  taskReplicaOutputDir(taskId) {
    const t = this.tasks.get(taskId);
    if (!t) return { ok: false, error: '任务不存在' };
    if (t.type !== 'replica') return { ok: false, error: '非复刻任务' };
    const outc = this._replicaOutInfo(t);
    if (!outc) return { ok: false, error: '缺少复刻源日志' };
    if (!outc.outDir || !fs.existsSync(outc.outDir) || !fs.statSync(outc.outDir).isDirectory()) {
      return { ok: false, error: '复刻成片文件夹未生成' };
    }
    return { ok: true, dir: outc.outDir };
  }

  _createTask(type, title, env, srcPath) {
    const id = 'task_' + (++this.taskSeq) + '_' + Date.now().toString(36);
    const task = {
      id, type, title, env: Object.assign({}, env),
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
  // 其余类型取源 TXT 所在目录下以「成片」结尾的子目录。
  // 找不到即返回空串：绝不回退成源目录 —— 源目录放着原始日志与素材，
  // 一旦被当成成片目录用于打开/删除，会直接误伤业务文件。
  _taskOutDir(type, srcPath, env) {
    // 视频处理工具没有「成片目录」概念 —— 必须显式返回空串。
    // 否则会落到下面的「找以成片结尾的子目录」分支，把源目录旁的成片目录当成工具任务的产物目录，
    // 而那正是后续删除类操作的目标（计划 §5.3）。
    if (type === 'tool') return '';
    if (type === 'mask') {
      const out = String((env && env.MASK_OUTPUT_DIR) || '').trim();
      return out ? path.resolve(out) : '';
    }
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
    return '';
  }

  // 业务归属日（MMDD）：按任务提交/创建时刻，凌晨 0-4 点归入前一天（跨日任务视同昨天产出）。
  // 批量任务优先取提交时刻（BATCH_SUBMIT_TS），缺失（旧版本创建的任务）则用创建时刻兜底；
  // 仅用于前端排序，不展示。
  _taskGroupDate(type, env, createdAt) {
    if (type !== 'batch' && type !== 'mask') return '';
    const ts = Number(env && env.MASK_SUBMIT_TS) || Number(env && env.BATCH_SUBMIT_TS) || Number(env && env.REPLICA_SUBMIT_TS) || Number(createdAt) || Date.now();
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
      this._spawnEngine(task.type, task.env, task);
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
      this._spawnEngine(t.type, t.env, t);
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
      [/全局异常/, '运行过程中出现异常'],
      [/(脚本|任务)完成（有错误）/, '运行出错'],
      [/ffmpeg|ffprobe/, '视频处理工具不可用'],
    ];
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      for (const [re, msg] of rules) {
        if (re.test(line)) return msg;
      }
    }
    return '运行失败';
  }

  // 任务的成片是否还在磁盘上：仅对「曾经产出过」的已结束任务判定。
  // 用途是列表提示（成片消失时标题置灰），任务行本身始终保留；
  // 从未产出的任务（未开始即失败等）不参与判定，避免把正常状态显示为异常。
  // 成片「产出证据」探测目标（纯内存解析，无磁盘 IO）：供同步判定与异步预热共用，
  // 保证两处探测的路径完全一致（否则预热读的不是判定要读的，等于白读）。
  // 返回 null 表示该任务无需探测（非终态 / 无任何产出证据）。
  _taskOutputProbes(t) {
    if (!t) return null;
    const st = String(t.status || '');
    if (st !== 'done' && st !== 'stopped' && st !== 'error' && st !== 'interrupted') return null;
    // 产出证据：标记清单 / 日志中的「成片完成」/ 批量任务的真实输出目录记录
    const marker = this._loadMarker(t);
    const marked = (marker && Array.isArray(marker.videos)) ? marker.videos.filter(Boolean) : [];
    const logged = [];
    for (const ln of (t.log || [])) {
      const m = /✅ 成片完成：(.+)$/.exec(ln);
      if (m) logged.push(String(m[1]).trim());
    }
    const outDirAuth = this._taskOutDirFromLog(t);
    const hadOutput = marked.length > 0 || logged.length > 0 || (t.type === 'batch' && !!outDirAuth);
    if (!hadOutput) return null;
    return { files: marked.concat(logged).filter(Boolean), dir: outDirAuth || t.outDir || '' };
  }
  _taskHasOutput(t) {
    if (!t) return true;
    // 启动恢复期（含紧随的异步预热窗口）：返回乐观值，**绝不做同步磁盘探测**。
    // 冷态下这些目录在机械盘上，逐任务同步访问会冻结主进程数秒（实测 5.7 秒），
    // 而窗口此时已经画出来了 —— 用户观感就是「窗口出来但点不动」。
    // 真实值由 _prewarmHasOutputAsync 预热完成后的一次 _emitTasks 给出（判定逻辑不变）。
    if (this._bootProbeSuppressed) return true;
    const probes = this._taskOutputProbes(t);
    if (!probes) return true;
    // 现存证据：任一记录的文件仍在，或批量输出目录内仍有成片
    for (const p of probes.files) {
      try { if (fs.existsSync(p)) return true; } catch (e) {}
    }
    const dir = probes.dir;
    if (dir) {
      try {
        if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()
          && fs.readdirSync(dir).some((f) => path.extname(f).toLowerCase() === '.mp4')) return true;
      } catch (e) {}
    }
    return false;
  }

  snapshotTasks() {
    const list = [];
    this.tasks.forEach((t) => {
      // 首次进入运行态时打点（惰性：覆盖直接启动/队列轮到/恢复启动所有路径）
      if (t.status === 'running' && !t.startedAt) t.startedAt = Date.now();
      list.push({
        id: t.id, type: t.type, title: t.title, pid: t.pid,
        status: t.status, lockState: t.lockState, paused: !!t.paused,
        progress: t.progress || { current: 0, total: 0 }, failReason: t.failReason || '',
        createdAt: t.createdAt, startedAt: t.startedAt || null, endedAt: t.endedAt, outDir: t.outDir || '',
        groupDate: typeof t.groupDate === 'string' ? t.groupDate : '', // 业务归属日（前端排序用，不展示）
        softPaused: t._softPaused === true,   // 软暂停待续任务（继续时按类型补缺片/接续）
        // 任务总用时（秒）：首次开始至今的墙钟时间；已结束任务取结束时间
        elapsedSec: taskElapsed(t),
        // 计划序号：排队任务=队列第几位；暂停任务=冻结的显示顺位；显示与恢复插队都以此为准
        pos: t.planPos || 0,
        resumeIdx: typeof t.resumeIdx === 'number' ? t.resumeIdx : null,
        queueTotal: this._taskQueue.length,
        // 成片是否仍在磁盘（仅曾产出过的已结束任务会为 false）：前端据此提示，不影响任务行本身
        hasOutput: this._taskHasOutput(t),
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

  // ── 任务列表持久化（tasks + task_logs 分表 + cache_kv.plan_seq）──
  // 状态变化节流落盘，回收/正常退出时保证落盘；重启后保留任务直到手动清空。
  // 日志按行独立存储：状态变更只重写任务主体，日志仅在追加时写新增行（日志是任务数据里体积最大的部分）。
  _schedulePersist() {
    if (this._persistTimer) return;
    this._persistTimer = setTimeout(() => { this._persistTimer = null; this.persistTasks(); }, 200);
  }
  persistTasks() {
    if (this._persistTimer) { clearTimeout(this._persistTimer); this._persistTimer = null; }
    if (!this._useDbCache()) return; // 纯内存态：任务列表本次会话不落盘
    const store = this._cacheStore;
    try {
      store.transaction(() => {
        // 列表中已不存在的任务：连同其日志行一并删除
        const keep = new Set(this.tasks.keys());
        for (const id of store.listTaskIds()) { if (!keep.has(id)) store.removeTask(id); }
        for (const t of this.tasks.values()) {
          const body = {
            id: t.id, type: t.type, title: t.title, env: t.env || {},
            status: t.status, lockState: t.lockState, progress: t.progress || { current: 0, total: 0 },
            failReason: t.failReason || '', paused: !!t.paused,
            createdAt: t.createdAt, startedAt: t.startedAt || null, endedAt: t.endedAt, planPos: t.planPos || 0,
            resumeIdx: typeof t.resumeIdx === 'number' ? t.resumeIdx : null,
            outDir: t.outDir || '', _stopRequested: !!t._stopRequested,
            groupDate: typeof t.groupDate === 'string' ? t.groupDate : '',
            failedVideos: Array.isArray(t.failedVideos) ? t.failedVideos.slice(-100) : [],
          };
          store.upsertTask({
            id: t.id, seq: parseInt(String(t.id).replace(/\D/g, ''), 10) || 0,
            type: t.type || '', status: t.status || '', title: t.title || '',
            createdAt: t.createdAt || 0, updatedAt: t.endedAt || t.startedAt || t.createdAt || Date.now(),
            payload: JSON.stringify(body),
          });
          // 日志：保留末尾 500 行。新增且未溢出窗口时只追加新行；否则整体重写。
          const all = t.log || [];
          const saved = typeof t._savedLogLen === 'number' ? t._savedLogLen : 0;
          if (all.length !== saved) {
            if (all.length > saved && all.length <= 500) store.appendTaskLog(t.id, saved, all.slice(saved));
            else store.setTaskLog(t.id, all.slice(-500));
            t._savedLogLen = all.length;
          }
        }
        store.setKv('plan_seq', String(this._planSeq));
      });
    } catch (e) {
      // 不静默吞错：任务列表写坏会导致整批任务记录丢失，必须能从日志定位
      console.error('[tasks] 任务列表落盘失败（本次变更已丢弃，下次状态变化会重试）：' + ((e && e.message) || e));
    }
  }
  // 启动时恢复上次会话的任务列表（退出前已做 running→interrupted、queued→paused 转换）
  restoreTasks() {
    // 待异步校验输出目录的批量任务（见 _verifyBatchOutDirs）：声明在 try 外，
    // 保证同步段即使异常，已收集的目录校验仍会继续（校验本身失败也被吞掉，不影响任务恢复）
    const pendingOut = [];
    try {
      if (!this._useDbCache()) return;
      const store = this._cacheStore;
      const _t0 = Date.now();
      const rows = store.listTasks();
      const _t1 = Date.now();
      for (const row of rows) {
        let t = null;
        try { t = JSON.parse(row.payload); } catch (e) { continue; }
        if (!t || typeof t.id !== 'string') continue;
        if (this.tasks.has(t.id)) continue;
        if (t.status !== 'paused' && t.status !== 'done' && t.status !== 'stopped' && t.status !== 'error' && t.status !== 'interrupted'
          && t.status !== 'queued' && t.status !== 'running') continue;
        t.log = store.getTaskLog(t.id);
        const restored = Object.assign({}, t, { env: t.env || {}, pid: null, progress: t.progress || { current: 0, total: 0 }, log: Array.isArray(t.log) ? t.log : [], failedVideos: Array.isArray(t.failedVideos) ? t.failedVideos : [] });
        // 强杀/异常退出恢复兜底：非终态任务转为可继续状态，避免任务从列表凭空消失
        // （正常退出走 shutdownTasks 已完成转换，此处仅兜底）
        if (restored.status === 'queued') {
          restored.status = 'paused'; restored.paused = true;
          if (restored.log[restored.log.length - 1] !== '[上次异常退出，排队任务已转为暂停]') { restored.log.push('[上次异常退出，排队任务已转为暂停]'); }
        } else if (restored.status === 'running') {
          restored.status = 'interrupted'; restored.paused = false;
          restored.endedAt = restored.endedAt || Date.now();
          if (restored.log[restored.log.length - 1] !== '[上次异常退出，任务已中断，可继续制作]') { restored.log.push('[上次异常退出，任务已中断，可继续制作]'); }
        }
        // 批量任务缺归属日时按提交/创建时刻补算（凌晨0-4点归前一天）
        if (restored.type === 'batch' && typeof restored.groupDate !== 'string') restored.groupDate = this._taskGroupDate(restored.type, restored.env, restored.createdAt);
        // 批量任务的成片文件夹：记录指向有效目录（含人工迁移/手工修正后）则保留；
        // 失效时仅按本任务提交时刻+配置名确定性推算规范路径，绝不跨日搜索猜替代品（见 _verifyBatchOutDirs）。
        // ⚠ 校验必须**异步**：此处位于启动关键路径，同步 existsSync 会逐任务冷访问磁盘
        //   （实测 49 个历史任务的输出目录在机械盘上 → 冷启动冻结主进程约 9 秒）。故只登记待校验项。
        if (restored.type === 'batch') pendingOut.push(restored);
        restored._savedLogLen = restored.log.length; // 已与库一致，避免下次持久化重复重写
        this.tasks.set(restored.id, restored);
        // 历史脏 ID 的数字部分曾被推到天文数字（科学计数法形态）：超出安全整数一律不采纳，
        // 否则 taskSeq 永远停在 e 记法大数上，新 ID 的数字部分 ++ 无效且只能靠时间戳后缀保唯一
        const n = parseInt(String(t.id).replace(/\D/g, ''), 10);
        if (Number.isSafeInteger(n) && n > this.taskSeq) this.taskSeq = n;
      }
      const _t2 = Date.now();
      const planSeq = parseInt(store.getKv('plan_seq') || '0', 10) || 0;
      if (planSeq > this._planSeq) this._planSeq = planSeq;
      // 恢复期抑制 hasOutput 的同步磁盘探测（详见 _taskHasOutput / _prewarmHasOutputAsync）：
      // 这次 emit 会走一遍任务快照，冷态下会对机械盘逐目录同步访问 → 冻结主进程数秒。
      // 抑制一直持续到异步预热完成（由 _prewarmHasOutputAsync 复位）。
      if (this.tasks.size) { this._bootProbeSuppressed = true; this._emitTasks(); }
      this._gcOrphanMarkers(); // 任务恢复完成后回收孤儿标记（任务不存在的残留）
      const _t3 = Date.now();
      // 分段留痕：冷启动卡顿定位依据（读库 / 主循环 / GC 三段，另记待异步校验的输出目录数）
      this._lg('SYS', 'task.restore',
        '任务恢复完成（同步段 ' + (_t3 - _t0) + 'ms · 读库 ' + (_t1 - _t0) + ' / 主循环 ' + (_t2 - _t1) + ' / GC ' + (_t3 - _t2) + ' · 任务 ' + rows.length + ' 条 · 待异步校验输出目录 ' + pendingOut.length + ' 条）',
        { dbMs: _t1 - _t0, loopMs: _t2 - _t1, gcMs: _t3 - _t2, tasks: rows.length, pendingOut: pendingOut.length });
    } catch (e) {}
    // 输出目录校验放到恢复完成后异步执行（不阻塞启动；见 _verifyBatchOutDirs）
    if (pendingOut.length) this._verifyBatchOutDirs(pendingOut);
    // 处于抑制期（说明已 emit 过任务）则启动异步预热，完成后复位抑制并刷新前端
    if (this._bootProbeSuppressed) this._prewarmHasOutputAsync();
  }
  // 启动后异步预热「成片是否仍在磁盘」判定所需的目录/文件元数据（restoreTasks 的延后部分）。
  // 为什么需要：_taskHasOutput 是**同步**判定（被 snapshotTasks 逐任务调用），而历史任务的成片
  // 目录多在机械盘 —— 冷启动首次访问每个目录约 87ms，66 个就是 5.7 秒（2026-09-26 冷态实测 GC 段）。
  // 本方法用 fs.promises 并发把**同一批路径**（_taskOutputProbes 与判定同源）的元数据读进系统缓存，
  // 之后同步判定即落在缓存上（同一批任务实测 13ms）。判定逻辑与语义**完全不变**，
  // 只是把「冷读」从启动关键路径挪到异步阶段。完成后复位抑制标志并再 emit 一次，
  // 让界面从乐观值切到真实值（缺失成片的提示因此最多晚 1~2 秒出现）。
  _prewarmHasOutputAsync() {
    const targets = [];
    this.tasks.forEach((t) => { const p = this._taskOutputProbes(t); if (p) targets.push(p); });
    if (!targets.length) { this._bootProbeSuppressed = false; return; }
    const fsp = fs.promises;
    const _t = Date.now();
    const jobs = [];
    for (const p of targets) {
      for (const f of p.files) jobs.push(fsp.access(f).catch(() => {}));
      if (p.dir) jobs.push(fsp.stat(p.dir).then((s) => (s.isDirectory() ? fsp.readdir(p.dir) : null)).catch(() => {}));
    }
    Promise.all(jobs).then(() => {
      this._lg('SYS', 'task.restore.hasoutput',
        '成片存在性元数据预热完成（' + (Date.now() - _t) + 'ms · 探测 ' + jobs.length + ' 项 / 任务 ' + targets.length + ' 条）',
        { probes: jobs.length, tasks: targets.length, ms: Date.now() - _t });
    }).catch(() => {}).then(() => {
      this._bootProbeSuppressed = false;      // 解除抑制：此后同步判定走系统缓存
      if (this.tasks.size) this._emitTasks(); // 由乐观值切到真实判定
    });
  }
  // 批量任务输出目录的异步校验（restoreTasks 的延后部分）。
  // 语义与原先的同步版完全一致：记录指向有效目录则保留；失效时仅按「提交时刻 + 配置名」
  // 确定性推算规范输出路径（脚本本就会创建的目录），绝不跨日/跨盘搜索猜替代品。
  // 与同步版的唯一差异：修正发生在任务恢复之后（首次 emitTasks 用的是记录值），
  // 有修正时会再发一次 emitTasks 让界面刷新 —— 换来的是启动关键路径不再被磁盘 IO 冻住。
  _verifyBatchOutDirs(tasks) {
    const fsp = fs.promises;
    const _t = Date.now();
    let changed = 0;
    return Promise.all(tasks.map((t) => {
      const od = t.outDir;
      const check = od ? fsp.access(od).then(() => true, () => false) : Promise.resolve(false);
      return check.then((live) => {
        if (live) return;
        const detail = t.status === 'done' ? this._batchTaskOutDetail(t, false) : null;
        if (detail && detail.outDir && detail.outDir !== od) { t.outDir = detail.outDir; changed++; }
      }).catch(() => {});
    })).then(() => {
      this._lg('SYS', 'task.restore.outdir',
        '任务输出目录异步校验完成（' + (Date.now() - _t) + 'ms · 校验 ' + tasks.length + ' 条 · 修正 ' + changed + ' 条）',
        { checked: tasks.length, changed: changed });
      if (changed) this._emitTasks();
    }).catch(() => {});
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
  hasQueuedTask() {
    for (const t of this.tasks.values()) if (t.status === 'queued') return true;
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
    // 工具任务必须走 rerunToolTask（重新执行、不删文件）：
    // 本方法会「删除上次失败残留的产物」，而工具任务的产物正是被覆盖的源视频，
    // 且它没有任务标记可依（会回退到「日志解析 + 目录推算」，推算出的产物很可能就是源目录里的视频）
    if (t.type === 'tool') return this.rerunToolTask(id);
    if (t.status !== 'error' && t.status !== 'interrupted' && t.status !== 'stopped') return { ok: false, error: '仅失败/中断/停止的任务可重新开始' };
    // 优先使用任务标记：其中保存了完整 env 与逐个成片的产出清单（精确还原、不依赖日志窗口）
    const marker = this._loadMarker(t);
    const env = Object.assign({}, (marker && marker.env) || t.env || {});
    // 遮罩任务 env 为 MASK_* 系列；批量/复刻为 REPLICA_TXT + 其它变量
    const isMask = t.type === 'mask';
    const src = isMask
      ? (env.MASK_RAW_DIRS ? String(env.MASK_RAW_DIRS).split(';')[0] : '')
      : (env.REPLICA_TXT ? String(env.REPLICA_TXT) : '');
    if (!src) {
      this._removeMarker(t);
      return { ok: false, error: isMask ? '原任务缺少遮罩配置，无法重新开始' : '原任务缺少 TXT 配置，无法重新开始' };
    }
    // 删除上次失败残留的成片与日志：有标记按标记精确清单，无标记回退日志解析+目录推算
    this._lg('DEL', 'task.rerun',
      '重新开始 · 将删除上次产物并从第 1 片重做 · ' + t.type + ' · ' + String(t.title || '').slice(0, 50),
      { id: t.id, hasMarker: !!marker,
        markerVideos: (marker && Array.isArray(marker.videos) ? marker.videos.slice(0, 30) : []),
        env: this._envBrief(env) });
    if (marker) this._removeMarkerArtifacts(marker);
    else this._removeTaskArtifacts(t);
    this._removeMarker(t);
    this.tasks.delete(id);
    const task = this._createTask(t.type, t.title || this._taskTitle(src), env, src);
    // 保留预填的进度结构（如批量任务的预计成片数/分组数），其余进度归零
    task.progress = { current: 0, total: 0 };
    if (t.progress && t.progress.groupCount > 0) task.progress.groupCount = t.progress.groupCount;
    if (t.progress && t.progress.total > 0) task.progress.total = t.progress.total;
    this._enqueueTask(task);
    return { ok: true, taskId: task.id };
  }

  // ── 任务标记（task_marks 表）：含完整 env 与逐成片产出清单，不在用户成片文件夹留下文件。
  // 任务正常完成时保留（供「清除成片/日志」精确删除）；失败/中断/停止时同样保留，作为未完成的标志且供重开精确还原。
  _loadMarker(task) {
    if (!task || !this._useDbCache()) return null;
    try {
      const raw = this._cacheStore.getMark(task.id);
      if (!raw) return null;
      const d = JSON.parse(raw);
      return d && typeof d === 'object' ? d : null;
    } catch (e2) { return null; }
  }
  _saveMarker(task, data) {
    if (!task || !this._useDbCache()) return;
    try { this._cacheStore.setMark(task.id, JSON.stringify(data), data && data.createdAt); } catch (e2) {}
  }
  // 删除任务标记（cache.db 的 task_marks 记录）。标记是「产物归属」的判定依据 ——
  // 一旦删除，任务身份/环境快照就再无别处留存，故默认留痕；批量场景传 silent 由调用方汇总。
  _removeMarker(task, opts) {
    if (!task || !this._useDbCache()) return;
    let removed = false;
    try { removed = this._cacheStore.removeMark(task.id) !== false; } catch (e2) {}
    if (removed && !(opts && opts.silent)) {
      this._lg('DEL', 'task.marker.remove',
        '删除任务标记 · ' + String(task.type || '') + ' · ' + String(task.title || '').slice(0, 40),
        { id: task.id, env: this._envBrief(task.env) });
    }
  }
  // 孤儿任务标记回收：标记对应的任务已不存在于列表（清除/历史遗留）时删除；
  // 仍存在的任务（含 done 历史，供「清除成片/日志」精确删除）标记保留。
  _gcOrphanMarkers() {
    if (!this._useDbCache()) return;
    try {
      const known = new Set(this.tasks.keys());
      let removed = 0;
      for (const id of this._cacheStore.listMarkIds()) {
        if (known.has(id)) continue;
        if (this._cacheStore.removeMark(id)) removed++;
      }
      if (removed) console.log('[cache] 已回收孤儿任务标记 ' + removed + ' 个');
    } catch (e) {}
  }
  // 任务真正开始执行时初始化标记（含 env 快照，重开可完整还原环境）
  _touchMarker(task) {
    this._saveMarker(task, {
      taskId: task.id, type: task.type, title: task.title || '',
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
    // 先留痕再删：产物一旦删除，这里是唯一还能还原「删了什么、多大、原修改时间」的地方
    const targets = (marker.videos || []).slice();
    if (marker.type === 'batch' && marker.batchOutDir) {
      try {
        if (fs.existsSync(marker.batchOutDir)) {
          for (const f of fs.readdirSync(marker.batchOutDir)) {
            if (path.extname(f).toLowerCase() === '.mp4' || /拼接日志/.test(f)) targets.push(path.join(marker.batchOutDir, f));
          }
        }
      } catch (e2) {}
    }
    const info = this._describeForLog(targets);
    this._lg('DEL', 'task.artifacts.remove',
      '清除任务产物 · ' + String(marker.type || '') + ' · ' + info.count + ' 个文件 · 共 ' + this._humanSize(info.bytes),
      Object.assign({ outDir: marker.batchOutDir || '' }, info));

    // 一律移入回收站（可还原），不做永久删除
    const rm = (p) => { try { if (p && fs.existsSync(p)) this._recycleFile(p); } catch (e2) {} };
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

  // 从任务日志行中解析该任务产出的成片路径（清除/续跑对账用，与标记互为补充）
  collectDoneFromLog(task) {
    const out = [];
    for (const line of ((task && task.log) || [])) {
      const m = /✅ 成片完成：(.+)$/.exec(String(line));
      if (m) out.push(String(m[1]).trim());
    }
    return out;
  }

  // 从复刻日志文件中移除指定成片的日志块（按成片文件路径的 basename 精确匹配）
  // 复刻日志格式：各成片块以「成片文件名.mp4」单行开头，块间以「=×46」分隔，以 EOF 结尾
  _removeLogEntries(videoPaths) {
    if (!Array.isArray(videoPaths) || !videoPaths.length) return;
    // 按目录分组成片路径：日志文件与成片同目录（脚本把日志写在复刻输出目录）
    const byDir = new Map();
    for (const v of videoPaths) {
      let p = v;
      try { p = path.resolve(String(v)); } catch (e) { continue; }
      const dir = path.dirname(p);
      if (!byDir.has(dir)) byDir.set(dir, []);
      byDir.get(dir).push(path.basename(p));
    }
    for (const [dir, bases] of byDir) {
      try {
        const files = fs.readdirSync(dir);
        const logFile = files.find((f) => /^\d{4}-(原片复刻|去重复刻)日志\.txt$/.test(f));
        if (!logFile) continue;
        const logPath = path.join(dir, logFile);
        const lines = fs.readFileSync(logPath, 'utf-8').split('\n');
        // 收集所有块起点：以成片文件名（不含路径分隔符、.mp4 结尾）开始的行
        const starts = [];
        for (let i = 0; i < lines.length; i++) {
          const ln = (lines[i] || '').trimEnd();
          if (ln.endsWith('.mp4') && !ln.includes('\\') && !ln.includes('/')) starts.push(i);
        }
        // 确定要删除的块起点
        const delSet = new Set(bases);
        const delStarts = new Set();
        for (const si of starts) {
          if (delSet.has((lines[si] || '').trimEnd())) delStarts.add(si);
        }
        if (!delStarts.size) continue;
        // 标记删除行：被删块内容（起点到下一块起点/EOF）+ 每块紧邻前方的分隔线
        const delIdx = new Set();
        for (let k = 0; k < starts.length; k++) {
          const si = starts[k];
          if (!delStarts.has(si)) continue;
          const end = k + 1 < starts.length ? starts[k + 1] : lines.length;
          for (let i = si; i < end; i++) delIdx.add(i);
          let p = si - 1;
          while (p >= 0 && !(lines[p] || '').trim()) p--;
          if (p >= 0 && /^=+$/.test((lines[p] || '').trimEnd())) delIdx.add(p);
        }
        const out = [];
        for (let i = 0; i < lines.length; i++) if (!delIdx.has(i)) out.push(lines[i]);
        while (out.length && !(out[out.length - 1] || '').trim()) out.pop();
        // 仅剩分隔线/空行视为已空 → 移除日志文件（走回收站），否则重写
        if (!out.some((l) => (l || '').trim() && !/^=+$/.test((l || '').trim()))) this._recycleFile(logPath);
        else fs.writeFileSync(logPath, out.join('\n'), 'utf-8');
      } catch (e) {}
    }
  }

  // 遮罩任务清除：从项目「遮罩日志」目录（MASK_LOG_DIR）的 *.txt 中移除目标成片的条目块。
  // 遮罩日志块结构与复刻日志一致：成片名（.mp4）行开头，块含使用片段列表/原片/遮罩/@out/分隔线
  _removeMaskLogBlocks(task, videoPaths) {
    const logDir = String((task && task.env && task.env.MASK_LOG_DIR) || '').trim();
    if (!logDir || !fs.existsSync(logDir) || !fs.statSync(logDir).isDirectory()) return;
    if (!Array.isArray(videoPaths) || !videoPaths.length) return;
    const bases = new Set();
    for (const v of videoPaths) {
      try { const b = path.basename(String(v)); if (b) bases.add(b); } catch (e) {}
    }
    if (!bases.size) return;
    let files = [];
    try {
      files = fs.readdirSync(logDir).filter((f) => /遮罩日志\.txt$/.test(String(f)) && fs.statSync(path.join(logDir, f)).isFile());
    } catch (e) { return; }
    for (const f of files) {
      const lp = path.join(logDir, f);
      try {
        const lines = fs.readFileSync(lp, 'utf-8').split('\n');
        const starts = [];
        for (let i = 0; i < lines.length; i++) {
          const ln = (lines[i] || '').trimEnd();
          if (ln.endsWith('.mp4') && !ln.includes('\\') && !ln.includes('/')) starts.push(i);
        }
        const delStarts = new Set();
        for (const si of starts) if (bases.has((lines[si] || '').trimEnd())) delStarts.add(si);
        if (!delStarts.size) continue;
        const delIdx = new Set();
        for (let k = 0; k < starts.length; k++) {
          const si = starts[k];
          if (!delStarts.has(si)) continue;
          const end = k + 1 < starts.length ? starts[k + 1] : lines.length;
          for (let i = si; i < end; i++) delIdx.add(i);
          let p = si - 1;
          while (p >= 0 && !(lines[p] || '').trim()) p--;
          if (p >= 0 && /^=+$/.test((lines[p] || '').trimEnd())) delIdx.add(p);
        }
        const out = [];
        for (let i = 0; i < lines.length; i++) if (!delIdx.has(i)) out.push(lines[i]);
        while (out.length && !(out[out.length - 1] || '').trim()) out.pop();
        // 仅剩分隔线/空行视为已空 → 移除遮罩日志文件（走回收站），否则重写
        if (!out.some((l) => (l || '').trim() && !/^=+$/.test((l || '').trim()))) this._recycleFile(lp);
        else fs.writeFileSync(lp, out.join('\n'), 'utf-8');
      } catch (e) {}
    }
  }

  // 删除失败任务在磁盘上遗留的产物（无任务标记时的清理）：
  // 1) 任务日志中「✅ 成片完成：」明确列出的成片文件 —— 精确清单，始终执行；
  // 2) 批量输出目录内的残留 mp4 与拼接日志 —— 仅在能确认该目录确属本任务时执行
  //    （目录内确有日志列出的成片文件）。推算目录在同日同名任务间会撞车，
  //    无归属证据时一律不动：找不到就是找不到，不猜。
  _removeTaskArtifacts(task) {
    // 一律移入回收站（可还原），不做永久删除
    const rm = (p) => { try { if (p && fs.existsSync(p)) this._recycleFile(p); } catch (e2) {} };
    // 1) 日志中列出的成片
    const listed = [];
    for (const line of (task.log || [])) {
      const m = /✅ 成片完成：(.+)$/.exec(line);
      if (m) { const p = String(m[1]).trim(); if (p) { listed.push(p); rm(p); } }
    }
    // 2) batch 专属输出目录：先确认归属，再做残留清理与配置 TXT 归位
    if (task.type === 'batch') {
      const detail = this._batchTaskOutDetail(task);
      if (detail && detail.outDir) {
        const dir = path.resolve(detail.outDir);
        const belongs = listed.some((p) => path.dirname(path.resolve(p)) === dir);
        if (belongs) {
          const src = (task.env && task.env.REPLICA_TXT) ? String(task.env.REPLICA_TXT) : '';
          if (src && !fs.existsSync(src)) {
            const dest = path.join(dir, path.basename(src));
            try { if (fs.existsSync(dest) && fs.statSync(dest).isFile()) fs.renameSync(dest, src); } catch (e2) {}
          }
          try {
            if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
              for (const f of fs.readdirSync(dir)) {
                const fp = path.join(dir, f);
                if (fs.existsSync(fp) && fs.statSync(fp).isFile() && (path.extname(f).toLowerCase() === '.mp4' || /拼接日志/.test(f))) rm(fp);
              }
            }
          } catch (e2) {}
        }
      }
    }
  }

  // 任务在磁盘上的真实输出目录：取日志中脚本明确创建的目录（权威记录）。
  // 推算目录（提交时刻+配置名）在同日同名任务之间会撞车，不能作为删除依据。
  _taskOutDirFromLog(task) {
    for (const ln of (task.log || [])) {
      const m = /✅ 创建输出目录：(.+)$/.exec(ln);
      if (m) {
        const d = String(m[1]).trim();
        if (d) return d;
      }
    }
    return '';
  }

  // 校验某目录确属该任务：目录内存在任务产出清单（标记/日志解析）中的文件
  _dirOwnsVideos(dir, videos) {
    if (!dir || !Array.isArray(videos) || !videos.length) return false;
    const target = path.resolve(dir);
    for (const p of videos) {
      if (!p) continue;
      if (path.dirname(path.resolve(p)) === target) return true;
    }
    return false;
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
    const removed = [];
    for (const [id, t] of this.tasks) {
      if (allow.has(t.status)) { this.tasks.delete(id); this._removeMarker(t, { silent: true }); removed.push(t); }
    }
    if (removed.length) {
      this._lg('DEL', 'task.marker.remove.batch',
        '批量清除任务标记 · ' + removed.length + ' 个 · 状态 ' + [...allow].join('/'),
        { ids: removed.slice(0, 50).map((t) => t.id) });
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
    // 先缓存每个任务的标记（文件删除用精确产物清单，删除前读取；任务记录清掉后再删标记文件）
    const marked = targets.map((t) => ({ t, marker: this._loadMarker(t) }));
    // 清除动作留痕：范围 + 任务清单。任务记录与标记随后都会消失，这里是唯一的凭据。
    if (marked.length) {
      this._lg('DEL', 'task.clearDone',
        '清除已完成任务 · ' + marked.length + ' 个 · 范围 ' + String(scope || 'list') + (day ? ' · 日期 ' + day : ''),
        { scope: scope || 'list', day: day || '',
          tasks: marked.slice(0, 50).map(({ t }) => ({
            id: t.id, type: t.type, title: String(t.title || '').slice(0, 40),
            outDir: t.outDir || '', clips: (t.progress && t.progress.current) || 0,
          })) });
    }
    // 先清任务列表（连带任务标记）
    for (const { t } of marked) { this.tasks.delete(t.id); this._removeMarker(t, { silent: true }); }
    const errors = [];
    if (scope && scope !== 'list') {
      const { shell } = require('electron');
      const trash = async (p) => {
        try { await shell.trashItem(p); }
        catch (e) { if (fs.existsSync(p)) throw e; } // 原路径已不存在视为成功
      };
      for (const { t, marker } of marked) {
        // 该任务精确产出的成片清单：优先任务标记（脚本逐条记录 ✅ 成片完成），缺失时回退任务日志行解析
        const exactVideos = (marker && Array.isArray(marker.videos) ? marker.videos.slice() : [])
          .concat(this.collectDoneFromLog(t));
        if (t.type === 'batch') {
          // 候选目录：日志中脚本实际创建的目录（权威）→ 推算目录。
          // 两者都必须通过「目录内产出确属本任务」校验：同分钟同配置名的任务共享同一成片目录，
          // 只凭"日志里有创建记录"就整目录删除，会误删重跑任务的成片 —— 找不到就是找不到，不猜。
          const cand = this._taskOutDirFromLog(t) || (t.outDir ? path.resolve(t.outDir) : '');
          if (!cand || !this._dirOwnsVideos(cand, exactVideos)) continue;
          const abs = cand;
          try { if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) continue; } catch (e2) { continue; }
          // 目录内 mp4 全部属于本任务 → 独占，可整目录删除；否则说明与同分钟同名任务共享目录，
          // 降级为「只删本任务的成片」，避免波及他人产物
          let mp4s = [];
          try { mp4s = fs.readdirSync(abs).filter((f) => path.extname(f).toLowerCase() === '.mp4'); }
          catch (e) { errors.push('读取成片目录失败：' + abs); continue; }
          const owned = new Set(exactVideos.filter(Boolean).map((p) => path.resolve(p)));
          const exclusive = mp4s.length > 0 && mp4s.every((f) => owned.has(path.resolve(path.join(abs, f))));
          const trashOwned = async () => {
            for (const f of mp4s) {
              const fp = path.join(abs, f);
              if (!owned.has(path.resolve(fp))) continue;
              try { await trash(fp); }
              catch (e) { errors.push('清除成片失败：' + fp); }
            }
          };
          // 删除前留痕：产物进回收站后，「删了什么、多大、原修改时间」就只剩这一行了
          const toRemove = (scope === 'all' && path.basename(abs).endsWith('成片') && exclusive)
            ? [abs]
            : mp4s.map((f) => path.join(abs, f)).filter((fp) => owned.has(path.resolve(fp)));
          if (toRemove.length) {
            const info = this._describeForLog(toRemove);
            this._lg('DEL', 'task.artifacts.clear',
              '清除任务产物 · ' + t.type + ' · ' + info.count + ' 个 · 共 ' + this._humanSize(info.bytes)
              + ' · 范围 ' + String(scope),
              Object.assign({ id: t.id, title: String(t.title || '').slice(0, 40) }, info));
          }
          if (scope === 'video') {
            await trashOwned();
          } else if (scope === 'all') {
            if (path.basename(abs).endsWith('成片') && exclusive) {
              try { await trash(abs); }
              catch (e) { errors.push('清除成片文件夹失败：' + abs); continue; }
              const parent = path.dirname(abs);
              if (parent && parent !== abs) {
                try { if (fs.readdirSync(parent).length === 0) await trash(parent); }
                catch (e) { errors.push('清除空上级文件夹失败：' + parent); }
              }
            } else {
              await trashOwned();
            }
          }
          continue;
        }
        // 复刻等非批量任务：只精确删除该任务自己的成片与日志块——
        // outDir 可能指向源日志目录（复刻历史日志时产物在提交日目录），按目录整删会误伤原始日志旁的产物
        if (!exactVideos.length) continue;
        const rootRes = path.resolve(this.root || process.cwd());
        const uniq = [...new Set(exactVideos)];
        // 删除前留痕（同上）
        {
          const info = this._describeForLog(uniq);
          this._lg('DEL', 'task.artifacts.clear',
            '清除任务产物 · ' + t.type + ' · ' + info.count + ' 个 · 共 ' + this._humanSize(info.bytes)
            + ' · 范围 ' + String(scope),
            Object.assign({ id: t.id, title: String(t.title || '').slice(0, 40) }, info));
        }
        for (const p of uniq) {
          try { if (p && fs.existsSync(p)) await trash(p); }
          catch (e) { errors.push('清除成片失败：' + p); }
          // 成片删除后，所在输出目录若已空则逐级向上清理（到工作根为界）——不留「复刻成片文件夹空壳」；
          // 任一目录非空即停止（重建/并行任务产物、日志文件等都会让它保留）
          if (p) {
            let cur = path.dirname(path.resolve(p));
            while (cur.length > rootRes.length && cur !== rootRes) {
              let entries = [];
              try { entries = fs.readdirSync(cur); } catch (e) { break; }
              if (entries.length) break;
              try { fs.rmdirSync(cur); } catch (e) { break; }
              cur = path.dirname(cur);
            }
          }
        }
        if (scope === 'all' || scope === 'video') {
          this._removeLogEntries(uniq);
          this._removeMaskLogBlocks(t, uniq); // 遮罩任务：从项目遮罩日志中移除该批成片的条目块
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

  // 暂停：排队中的任务移出执行队列并冻结当前显示顺位；**运行中的任务 = 软暂停**——
  // 不打断当前成片，当前成片完成后终止引擎（本片已完整落盘），恢复顺位提到 1 号，
  // 下一个任务先跑，剩余部分靠「继续任务」断点续传（用户定案 2026-09-21）
  pauseTask(id) {
    const t = this.tasks.get(id);
    if (!t) return { ok: false, error: '任务不存在' };
    if (t.status === 'running') {
      // 视频处理任务按文件粒度重跑语义不匹配，暂不支持软暂停
      if (t.type === 'tool') return { ok: false, error: '视频处理任务不支持暂停，请使用「停止」后重新提交' };
      t._softPause = true;
      this._lg('RUN', 'task.softPause',
        '软暂停 · 当前成片完成后生效 · ' + t.type + ' · ' + String(t.title || '').slice(0, 50),
        { id: t.id });
      t.log.push('[软暂停] 当前成片完成后暂停，让下一个任务先执行；剩余部分可「继续任务」续跑]');
      this._emitTasks();
      return { ok: true, soft: true, message: '将在当前成片完成后暂停' };
    }
    if (t.status !== 'queued') {
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
    // ★ 软暂停恢复按类型分流（用户定案 2026-09-21：参数/分组/去重/计数必须原样保留）：
    //   batch / replica → 走 continueReplica 的「补缺片」构造（已完成片从任务标记反推，
    //     以 ONLY_NAMES 只补剩余，env 全量复用 —— 分组/提交时刻/命名与首次一致）；
    //   mask → 直接重新入队（引擎对已存在成片有 skip 幂等检测，天然续跑）；
    //   恢复后必须清软暂停标志，否则下一个成片完成时会被再次终止（暂停死循环）。
    if (t._softPaused && (t.type === 'batch' || t.type === 'replica')) {
      return this.continueReplica(id);
    }
    delete t._softPause;
    delete t._softPaused;
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

  // Node 引擎子进程：以 Electron 自带 Node（ELECTRON_RUN_AS_NODE）运行引擎，
  // 既不依赖系统安装 Node，也不依赖 pwsh；stdio 形态与 pwsh 分支完全一致，协议行解析无需改动。
  _spawnNodeEngineChild(task, env) {
    const { spawn } = require('child_process');
    return spawn(process.execPath, [this._engineRunnerPath(), '--module', task.type], {
      env: Object.assign({}, process.env, this._ffmpegBinEnv(), env, { ELECTRON_RUN_AS_NODE: '1' }),
      cwd: this.enginesDir,
      windowsHide: true,
      detached: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }

  _spawnEngine(type, env, task) {
    // 以内置 Node 引擎执行任务；stdout/stderr 实时捕获与协议行解析供任务窗口显示。
    const { spawn } = require('child_process');
    const childEnv = Object.assign({}, env);
    childEnv.VL_CACHE_DB = this.cacheDbPath || '';
    return new Promise((resolve) => {
      const child = this._spawnNodeEngineChild(task, childEnv);
      if (task) {
        task.pid = child.pid;
        this._lg('RUN', 'task.start',
          '任务开始 · ' + task.type + ' · ' + String(task.title || '').slice(0, 60) + ' · pid=' + child.pid,
          { id: task.id, type: task.type, pid: child.pid, env: this._envBrief(task.env) });
        this._emitTasks();
        // 任务真正开始：创建任务标记（含 env 快照，供失败重开精确还原）
        this._touchMarker(task);
        const decodeLine = (buf) => {
          try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); }
          catch (e) { try { return new TextDecoder('gbk').decode(buf); } catch (e2) { return buf.toString('latin1'); } }
        };
        const pushLine = (buf) => {
          const s = decodeLine(buf).replace(/\r$/, '').trim();
          if (!s) return;
          // ★ 引擎诊断通道（过程信息）：不进任务窗口日志（用户视图保持简洁），
          //   只收集到任务对象；任务失败时随 task.diag 落运行日志（保留 30 天）。
          //   这样「结论给用户、过程给排查」各得其所。
          if (s.indexOf('@@VLDIAG@@') === 0) {
            try {
              const arr = JSON.parse(s.slice(10));
              if (Array.isArray(arr)) task._diag = (task._diag || []).concat(arr).slice(-4000);
            } catch (e) { /* 诊断解析失败不影响任务 */ }
            return;
          }
          if (task.status !== 'running') return;
          // 单成片实时进度：目标时长（分母）+ ffmpeg time（分子）。
          // 必须放在进度行拦截前，否则 ffmpeg 进度行被折叠后 clip/clipTarget 不再更新（进度条失效）
          const durM = s.match(/(?:成片预计时长|当前文件时长):\s*([\d.]+)\s*秒/);
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
          // 进度解析：匹配 "共 N 个" 与 "生成第 X / Y 个成片" / "复刻第 X / Y 个成片" /
          // 视频处理工具的 "处理第 X / Y 个视频"（同一套进度字段，措辞按模块区分）
          const totalMatch = s.match(/共\s*(\d+)\s*个/);
          if (totalMatch) {
            const n = parseInt(totalMatch[1], 10);
            if (n > 0) task.progress.total = n;
          }
          const curMatch = s.match(/(?:生成|复刻)第\s*(\d+)\s*\/\s*(\d+)\s*个成片/)
            || s.match(/处理第\s*(\d+)\s*\/\s*(\d+)\s*个视频/);
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
          else if (/互斥锁已释放|任务完成/.test(s)) { task.lockState = 'released'; task.progress.liveLine = null; }
          // 产物记录进任务标记：成片完成路径 / batch 专属输出目录（重开时据此精确删除）
          const outpM = s.match(/✅ 成片完成：(.+)$/);
          if (outpM) {
            const outp = String(outpM[1]).trim();
            this._appendMarkerOut(task, 'videos', outp);
            this._lg('RUN', 'clip.done',
              '成片产出 · ' + String(task.title || '').slice(0, 40) + ' · ' + path.basename(outp),
              { task: task.id, path: outp });
          }
          const outdM = s.match(/✅ 创建输出目录：(.+)$/);
          if (outdM) this._appendMarkerOut(task, 'batchOutDir', String(outdM[1]).trim());
          // 失败成片记录：脚本输出 `❌ 失败成片：<成片名>|<原因>`，供续跑/对账/前端展示
          // ★ 软暂停触发点：当前成片已完成（该行即当前片的完成标志）——
          //   此刻终止引擎进程，本片已完整落盘，剩余部分靠「继续任务」断点续传
          if (task._softPause && !task._softPaused && /成片完成/.test(s)) {
            task._softPaused = true;
            task.resumeIdx = 1;   // 恢复队列第 1 号：让被让位的任务优先接续
            try { if (child.pid) process.kill(child.pid); } catch (e2) {}
            this._lg('RUN', 'task.softPause.fire',
              '软暂停生效 · 当前成片已完成，终止引擎让位下一个任务',
              { id: task.id });
          }
          // 用户指引：引擎错误块里的「如何解决 / 问题归属」—— 供任务窗口直接展示
          // （前端保持简洁，但要让用户知道怎么修、以及是不是程序的问题）
          const howM = s.match(/^如何解决[:：]\s*(.+)$/);
          if (howM) task.solution = howM[1].trim().slice(0, 300);
          const whoM = s.match(/^问题归属[:：]\s*(.+)$/);
          if (whoM) task.blame = whoM[1].trim().slice(0, 120);

          // 失败成片【序号】（命名前失败，如批量组合凑不出时长）：记入 failedIndices 供续跑按序号补做，
          // 同时以「第 N 个」形式进 failedVideos，让任务窗口能显示失败项
          const failIdxM = s.match(/❌ 失败成片序号：(\d+)(?:\|(.*))?$/);
          if (failIdxM) {
            const idx = parseInt(failIdxM[1], 10);
            if (Number.isInteger(idx) && idx > 0) {
              task.failedIndices = task.failedIndices || [];
              if (task.failedIndices.indexOf(idx) < 0) task.failedIndices.push(idx);
              task.failedVideos = task.failedVideos || [];
              task.failedVideos.push({ name: '第' + idx + '个', reason: String(failIdxM[2] || '').trim() });
              task.failReason = '存在失败成片，可点击「继续制作」续跑';
            }
          }
          const failM = s.match(/❌ 失败成片：(.+)$/);
          if (failM) {
            const parts = String(failM[1]).split('|');
            task.failedVideos = task.failedVideos || [];
            task.failedVideos.push({ name: (parts[0] || '').trim(), reason: (parts.slice(1).join('|') || '').trim() });
            task.failReason = '存在失败成片，可点击「继续制作」续跑';
          }
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
          // 结算对账（复刻）：脚本内单条失败会 continue 并置 HasError → 退出码 1；
          // 若 exit 0 但存在失败记录（异常场景），也归为 error 并提示续跑，避免误判为全部成功
          // 软暂停：当前成片已完成、引擎被主动终止 —— 状态归为 paused（非停止/失败），
          // 恢复顺位提到 1 号（resumeIdx=1），用户点「继续任务」即从剩余部分接续
          let status = task._softPaused ? 'paused' : (task._stopRequested ? 'stopped' : (code === 0 ? 'done' : 'error'));
          if (task._softPaused) {
            task.endedAt = null;
            task.failReason = '';
            task.resumeIdx = 1;
            task.log.push('[软暂停生效] 当前成片已完成并保留，任务转入暂停队列第 1 位；点击「继续任务」接续]');
          }
          if (code === 0 && Array.isArray(task.failedVideos) && task.failedVideos.length && (task.type === 'replica' || task.type === 'mask' || task.type === 'batch')) {
            status = 'error';
            task.failReason = '存在失败成片，可点击「继续制作」续跑';
          }
          task.status = status;
          task.paused = false;
          if (task.status === 'error' && !task.failReason) task.failReason = this._deriveFailReason(task);
          this._lg('RUN', 'task.end',
            '任务结束 · ' + status + ' · ' + task.type + ' · 退出码 ' + code
            + ' · 成片 ' + ((task.progress && task.progress.current) || 0) + '/' + ((task.progress && task.progress.total) || 0)
            + ' · 失败记录 ' + ((task.failedVideos || []).length) + ' 条'
            + (task.failReason ? ' · ' + String(task.failReason).slice(0, 80) : ''),
            { id: task.id, status: status, code: code,
              failed: (task.failedVideos || []).slice(0, 20).map((f) => f && f.name) });
          // ★ 失败诊断留痕：引擎输出（task.log）与 stderr 尾部一并落盘 ——
          //   任务窗口的日志会随任务记录被清除，运行日志是事后唯一凭据。
          //   引擎自己会打印「错误信息 / 出错步骤 / 错误详情」块，这里原样带上，
          //   排查时只看 error-YYYY-MM-DD.log 即可定位，不必反推代码。
          if (status === 'error') {
            try {
              const tailLog = (task.log || []).slice(-40);
              const stderrTail = String((err && err.data && err.data.length) ? err.data.toString('utf8') : '').slice(-1500);
              // 引擎报错块优先：先把「错误信息」那几行提到摘要里，肉眼扫读即可见
              // 摘要优先取「错误详情」（信息量最大：含具体路径/原因），其次「出错步骤」等，
              // 目标是扫一眼错误日志就知道为什么失败，不必展开 JSON
              let why = '';
              for (const l of (task.log || [])) {
                const t = String(l || '').trim();
                if (/^错误详情[:：]/.test(t)) { why = t.slice(0, 200); break; }
              }
              if (!why) {
                for (const l of (task.log || [])) {
                  const t = String(l || '').trim();
                  if (/出错步骤[:：]|未找到|不存在|失败[:：]|ERROR|Error/.test(t) && !/^=+$/.test(t)) { why = t.slice(0, 200); break; }
                }
              }
              this._lg('RUN', 'task.error',
                '任务失败诊断 · ' + task.type + ' · 退出码 ' + code
                + (why ? ' · ' + why : (task.failReason ? ' · ' + String(task.failReason).slice(0, 160) : ' · 无引擎报错信息')),
                { id: task.id, title: task.title, code: code,
                  failReason: task.failReason, why: why,
                  solution: task.solution || '', blame: task.blame || '',
                  stderrTail: stderrTail, engineTail: tailLog,
                  env: this._envBrief(task.env) });
              // 过程诊断（引擎 diag 通道）：完整记录每次尝试/候选/排除/档位，
              // 单独一条落盘（量大，只在失败时写）—— 回答「怎么走到这个结论」
              if (Array.isArray(task._diag) && task._diag.length) {
                this._lg('DIAG', 'task.diag',
                  '任务过程诊断 · ' + task.type + ' · ' + task._diag.length + ' 条（每次尝试 / 候选 / 排除原因 / 参数档位）',
                  { id: task.id, events: task._diag });
              }
            } catch (e3) { /* 日志失败不影响主流程 */ }
          }
          // 任务标记统一保留：done 也保留供「清除成片/日志」精确删除（不误伤同目录其他任务的产物）
          this._emitTasks();
          // 运行任务结束：清空运行位并启动执行队列中的下一个任务（暂停/继续不影响插入后的推进）
          this._runningTaskId = null;
          this._startNextQueued();
          // ★ 系统通知（用户定案 2026-09-22）：任务失败必报；队列彻底空闲（无运行中、无排队）
          //   时报「全部任务完成」并区分最后一次是否带失败项
          // 视频处理任务结束后按设置清理过期备份（仅开启时执行）
          if (task.type === 'tool') this._cleanupBackups();
          if (status === 'error') {
            this._notify('任务失败：' + String(task.title || '').slice(0, 50),
              task.failReason || '存在失败项，可在任务列表中查看详情或继续制作');
          }
          // 队列已无待运行任务（queued 空）即视为「本轮跑完」——此时可能还有**暂停待续**的任务
          // （用户主动暂停 / 软暂停让位），这类不在执行队列里，需在通知里明确提醒，避免误以为全做完
          if (!this._runningTaskId && this._taskQueue.length === 0 && (status === 'done' || status === 'error')) {
            var pendingPaused = 0;
            this.tasks.forEach((t2) => { if (t2.status === 'paused') pendingPaused++; });
            const head = status === 'error' ? '任务已跑完（存在失败项）' : '任务已跑完';
            const tail = pendingPaused > 0
              ? '另有 ' + pendingPaused + ' 个任务处于暂停待续，点「继续任务」可接着制作'
              : '任务队列已清空，全部成功';
            this._notify(head, tail);
          }
        });
        child.on('error', (err2) => {
          task.log.push('[启动失败] ' + String(err2));
          task.status = 'error';
          task.failReason = '程序运行组件启动失败，请重新安装或校验程序文件';
          task.endedAt = Date.now();
          this._lg('ERR', 'engine.spawn',
            '运行组件启动失败 · ' + task.type + ' · ' + String(task.title || '').slice(0, 40),
            { id: task.id, enginesDir: this.enginesDir, error: String(err2) });
          this._emitTasks();
        });
      }
      child.on('error', (err2) => {
        this._lg('ERR', 'engine.spawn', '引擎子进程异常 · ' + String(err2));
        resolve({ ok: false, error: String(err2) });
      });
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

  // 复刻任务简化标题：项目名/MMdd-名字/模式——
  // 将批量拼接日志名 MMdd-<HH时MM分>-<名字>-拼接日志 压缩为 MMdd-<名字>，
  // 模式（原片/去重）以斜杠后缀标识；非拼接日志命名形态则保留原文件名
  _replicaTaskTitle(logPath, modeLabel) {
    const abs = path.resolve(logPath);
    const rel = path.relative(this.root, abs);
    const parts = rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel.split(path.sep).filter(Boolean) : [];
    let name = path.basename(abs).replace(/\.txt$/i, '');
    name = name.replace(/^(\d{4})-(\d{1,2}时\d{1,2}分)-(.*)$/, '$1-$3')
               .replace(/[-–—_]\s*拼接日志$/i, '');
    const project = parts.length > 0 ? parts[0] : '';
    return (project ? project + '/' : '') + name + (modeLabel ? '/' + modeLabel : '');
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

  // 设置页保存后同步 Api 持有的配置副本；批量工作目录（batch.root）变化时重设根目录
  updateSettings(s) {
    const cfg = s || {};
    // 工作路径从顶层 root 迁到 batch.root（2026-09-26）：此处改读 batch.root
    const br = (cfg.batch && typeof cfg.batch === 'object' && typeof cfg.batch.root === 'string')
      ? cfg.batch.root.trim() : '';
    if (br && br !== this.root) this.setRoot(br);
    if (cfg.batch && typeof cfg.batch === 'object') this.config.batch = Object.assign({}, this.config.batch, cfg.batch);
    if (cfg.replica && typeof cfg.replica === 'object') this.config.replica = Object.assign({}, this.config.replica, cfg.replica);
    if (cfg.mask && typeof cfg.mask === 'object') this.config.mask = Object.assign({}, this.config.mask, cfg.mask);
    // 应用级设置（通知开关 / 备份项等）：backend 侧 _notify 等直接读 this.config，
    // 运行时改动必须同步，否则「关了通知仍在弹」直到下次重启。
    for (const k of Api.APP_SETTING_KEYS) {
      if (cfg[k] !== undefined) this.config[k] = cfg[k];
    }
    if (cfg.ffmpeg_dir !== undefined) this.config.ffmpeg_dir = cfg.ffmpeg_dir;
  }

  // 水印归属校验：以本项目「主流水印」为基准做一致性判定；仅在用户启用判定时参与判断。
// 未启用判定的项目一律放行（默认不启用，勾选后才判定）。只返回布尔值（不暴露真实路径/文件名）。
  checkWatermarkProject(project, watermarkPath) {
    const wm = String(watermarkPath || '').trim();
    try {
      if (!wm) return { inProject: true, fileMissing: false };
      const pdir = path.resolve(path.join(this.root, project));
      const wmAbs = path.isAbsolute(wm) ? path.resolve(wm) : path.resolve(pdir, wm);
      // 水印文件本身不存在 → 返回 fileMissing，前端据此阻断启动（与归属判定分离，两种错误分别提示）
      if (!fs.existsSync(wmAbs) || !fs.statSync(wmAbs).isFile()) return { inProject: false, fileMissing: true };
      const wmKey = wmAbs.toLowerCase();
      this._loadWatermarkCache();
      const cacheKey = this.root + '\u0000' + project;
      // 未启用判定：直接放行
      if (!this._wmEnabled[cacheKey]) return { inProject: true, fileMissing: false };
      if (!Object.prototype.hasOwnProperty.call(this._wmCache, cacheKey)) {
        // 本项目主流水印未固化：现场统计一次并落盘（保存前默认取配置主流作为初始值）
        this._wmCache[cacheKey] = this._computeMajorityWatermark(pdir);
        this._saveWatermarkCache();
      }
      const majority = this._wmCache[cacheKey] || '';
      // 无主流水印(项目无任何水印)放行；有则当前水印必须与其一致（路径比较大小写不敏感）
      return { inProject: !majority || wmKey === String(majority).toLowerCase(), fileMissing: false };
    } catch (e) { return { inProject: true, fileMissing: false }; }
  }

  // 读取项目主流水印设置（弹窗初始化）：main=已保存的设置（无则现场统计主流作为初始默认值）；enabled=是否启用判定
  getProjectWatermark(project) {
    try {
      if (!this.root || !project) return { ok: true, main: '', enabled: false, group: 0, groupEnabled: false };
      const pdir = path.resolve(path.join(this.root, project));
      this._loadWatermarkCache();
      const cacheKey = this.root + '\u0000' + project;
      let main = this._wmCache[cacheKey] || '';
      if (!main) main = this._computeMajorityWatermark(pdir); // 保留统计主流作初始默认值
      // 旧版本缓存曾以全小写路径落盘：磁盘上真实存在同名文件时，纠正为原始大小写并回写缓存
      if (main && main === main.toLowerCase() && fs.existsSync(main)) {
        const real = this._realCasePath(main);
        if (real) {
          main = real;
          this._wmCache[cacheKey] = real;
          this._saveWatermarkCache();
        }
      }
      return { ok: true, main, enabled: !!this._wmEnabled[cacheKey], group: parseInt(this._wmGroup[cacheKey], 10) || 0, groupEnabled: !!this._wmGroupEnabled[cacheKey] };
    } catch (e) { return { ok: false, error: String(e), main: '', enabled: false, group: 0, groupEnabled: false }; }
  }

  // 将路径各段替换为磁盘上的真实大小写（逐级向上查找同名目录/文件）
  _realCasePath(p) {
    try {
      const abs = path.resolve(p);
      const parts = abs.split(path.sep);
      let cur = parts[0] + path.sep; // 盘符保持原样
      for (let i = 1; i < parts.length; i++) {
        const seg = parts[i];
        if (!seg) continue;
        let found = '';
        try {
          const entries = fs.readdirSync(cur, { withFileTypes: true });
          const lower = seg.toLowerCase();
          for (const ent of entries) {
            if (ent.name.toLowerCase() === lower) { found = ent.name; break; }
          }
        } catch (e) {}
        cur = path.join(cur, found || seg);
      }
      return cur;
    } catch (e) { return ''; }
  }

  // 保存项目设置：更新主流水印（判定参照文件与启用标记）与默认分组数；applyToAll=true 时把本项目全部 txt（含日志）的水印行改为新水印
  setProjectWatermark(project, watermark, enabled, applyToAll, group, groupEnabled) {
    try {
      const wm = String(watermark || '').trim();
      const pdir = path.resolve(path.join(this.root, project));
      // 存储保留原始大小写的绝对路径（Windows 显示友好）；比较时另做大小写不敏感归一
      const wmStore = wm ? (path.isAbsolute(wm) ? path.resolve(wm) : path.resolve(pdir, wm)) : '';
      this._loadWatermarkCache();
      const cacheKey = this.root + '\u0000' + project;
      if (wmStore) { this._wmCache[cacheKey] = wmStore; this._wmEnabled[cacheKey] = !!enabled; }
      else {
        delete this._wmCache[cacheKey];
        delete this._wmEnabled[cacheKey]; // 未设置水印时视同不启用
      }
      // 默认分组数：启用状态 + 数值（0/非数字视为未启用）
      const g = parseInt(group, 10) || 0;
      const ge = !!groupEnabled && g > 0;
      if (ge) { this._wmGroup[cacheKey] = g; this._wmGroupEnabled[cacheKey] = true; }
      else { delete this._wmGroup[cacheKey]; delete this._wmGroupEnabled[cacheKey]; }
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
      if (curMk !== '' && wmKey === String(curMk).toLowerCase()) {
        if (dirty) this._saveWatermarkCache();
        return { hits: [], inOwn: true };
      }
      const hits = [];
      for (const [pd, proj] of seen) {
        if (proj === REPLICA_PROJECT) continue; // 复刻虚拟项目无配置水印
        const mk = majorityOf(pd, proj);
        if (mk !== '' && wmKey === String(mk).toLowerCase()) hits.push(proj);
      }
      if (dirty) this._saveWatermarkCache();
      return { hits };
    } catch (e) { return { hits: [] }; }
  }

  // 统计本项目主流水印：所有配置使用频次最高的水印
  // 计数用大小写不敏感 key（Windows 路径不区分大小写），但返回保留原始大小写的路径（供前端显示与落盘）
  _computeMajorityWatermark(pdir) {
    const counts = new Map(); // key(lower) -> { n, first 原始路径 }
    for (const t of this._collectAllTxt()) {
      if (path.resolve(t.pdir) !== pdir) continue;
      let cfg;
      try { cfg = this.readConfig(t.full); } catch (e) { continue; }
      const w = String(cfg && cfg.watermark || '').trim();
      if (!w) continue;
      const absPath = path.isAbsolute(w) ? path.resolve(w) : path.resolve(pdir, w);
      const k = absPath.toLowerCase();
      const rec = counts.get(k) || { n: 0, first: absPath };
      rec.n++;
      counts.set(k, rec);
    }
    let majorityKey = '', majorityN = 0;
    for (const [k, rec] of counts) { if (rec.n > majorityN) { majorityN = rec.n; majorityKey = rec.first; } }
    return majorityKey;
  }

  // 刷新配置时预填充水印缓存：扫描当前工作目录下所有项目，缺失归属的项目补算主流，已有条目保持不动
  _warmWatermarkCache() {
    if (!this.root) return;
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

  // ── 批量项目设置（settings.db scope='batch'）：水印主流 / 启用标记 / 默认分组数 / 分组启用 ──
  // 按 root+项目 隔离，保存时只覆盖当前 root 的条目。
  _loadWatermarkCache() {
    if (!this._wmCache) this._wmCache = {};
    if (!this._wmEnabled) this._wmEnabled = {};
    if (!this._wmGroup) this._wmGroup = {};
    if (!this._wmGroupEnabled) this._wmGroupEnabled = {};
    if (this._wmCacheLoadedRoot === this.root) return;
    this._wmCacheLoadedRoot = this.root;
    this._wmCache = {};
    this._wmEnabled = {};
    this._wmGroup = {};
    this._wmGroupEnabled = {};
    if (!this._useSettings()) return;
    const prefix = this.root + '\u0000';
    const want = { watermarks: this._wmCache, enabled: this._wmEnabled, groupCounts: this._wmGroup, groupEnabled: this._wmGroupEnabled };
    try {
      const all = this._settingsStore.all('batch');
      for (const kind of ['watermarks', 'enabled', 'groupCounts', 'groupEnabled']) {
        const src = all[kind];
        if (!src || typeof src !== 'object' || Array.isArray(src)) continue;
        // 只加载当前工作目录下的条目：换 root 后旧条目不再参与，保存时自然被清理
        for (const k in src) {
          if (!Object.prototype.hasOwnProperty.call(src, k) || !k.startsWith(prefix)) continue;
          if (kind === 'groupCounts') want[kind][k] = parseInt(src[k], 10) || 0;
          else if (kind === 'enabled' || kind === 'groupEnabled') want[kind][k] = !!src[k];
          else want[kind][k] = src[k];
        }
      }
    } catch (e) {}
  }

  _saveWatermarkCache() {
    if (!this._useSettings()) return;
    // 合并保存：保留其它工作目录（root）的条目，仅覆盖当前 root 的条目，
    // 避免切换工作目录后旧 root 的设置被覆盖丢失
    const prefix = this.root + '\u0000';
    const mine = {
      watermarks: this._wmCache || {}, enabled: this._wmEnabled || {},
      groupCounts: this._wmGroup || {}, groupEnabled: this._wmGroupEnabled || {},
    };
    const store = this._settingsStore;
    try {
      const all = store.all('batch');
      store.transaction(() => {
        for (const kind of ['watermarks', 'enabled', 'groupCounts', 'groupEnabled']) {
          const merged = {};
          const src = all[kind];
          if (src && typeof src === 'object' && !Array.isArray(src)) {
            for (const k in src) {
              if (Object.prototype.hasOwnProperty.call(src, k) && !k.startsWith(prefix)) merged[k] = src[k];
            }
          }
          Object.assign(merged, mine[kind]);
          store.set('batch', kind, merged);
        }
      });
    } catch (e) {}
  }

  // ══════════════════════════════════════════════════════════════════════
  // 视频处理工具（第 4 个模块）—— 计划 §五、§5.1、§5.2、§5.3
  //
  // 与三个成片模块同构：建任务 → 入同一队列 → 引擎子进程（module=tool）
  // 参数经 TOOL_SPEC（JSON）传入；步骤清单与参数 schema 由引擎侧注册表提供，
  // 前端据此**自动渲染表单**（加能力 = 加一个步骤文件，前端不用改）
  // ══════════════════════════════════════════════════════════════════════
  _toolSteps() {
    try { return require(path.join(this.enginesDir, 'tools', 'index.js')); } catch (e) { return null; }
  }

  /** 步骤清单 + 参数 schema + 输出策略可选项（供前端渲染表单） */
  listTools() {
    const mod = this._toolSteps();
    if (!mod) return { ok: false, error: '程序文件不完整（缺少处理组件），请重新安装或校验程序文件' };
    const steps = mod.stepSchema ? mod.stepSchema() : [];
    return {
      ok: true,
      steps,
      groups: mod.stepSchemaByGroup ? mod.stepSchemaByGroup() : [],
      stepCount: steps.length,
      engine: !!this._engineRunnerPath(),
      root: this.root || '',
      output: {
        modes: [{ v: 'overwrite', t: '覆盖原视频' }, { v: 'directory', t: '输出到指定目录' }],
        nameModes: [{ v: 'keep', t: '原名' }, { v: 'suffix', t: '原名 + 后缀' }],
        conflicts: [{ v: 'index', t: '追加序号' }, { v: 'overwrite', t: '覆盖' }, { v: 'skip', t: '跳过' }],
        // 实际默认备份地址：设置里的默认备份目录 > 数据目录下 backup。
        // 返回前确保存在（应用自己管理的目录，可直接创建）—— 浏览器端「打开/选择」才能直接定位
        defaultBackupDir: (() => {
          const customRoot = String(this.config.backup_dir || '').trim();
          const root = customRoot ? path.join(customRoot, 'Video Lab 备份')
            : path.join(this.storageDir || '', 'backup');
          try { fs.mkdirSync(root, { recursive: true }); } catch (e) {}
          return root;
        })(),
      },
    };
  }

  /**
   * 浏览器端的目录浏览：列出某目录下的子目录与文件名。
   * 供工具窗口的 Web 路径选择器使用 —— 浏览器侧没有本机文件对话框，
   * 系统对话框又依赖本体窗口的前台状态（焦点在浏览器时会被压在后面）。
   * 只读目录名与文件名，不读文件内容。
   */
  listDir(dir) {
    const target = String(dir || '').trim() ? path.resolve(String(dir).trim()) : path.resolve(this.root || '');
    if (!target) return { ok: false, error: '缺少路径' };
    let st = null;
    try { st = fs.statSync(target); } catch (e) { return { ok: false, error: '路径不存在：' + target }; }
    if (!st.isDirectory()) return { ok: false, error: '不是目录：' + target };
    const dirs = [], files = [];
    try {
      for (const e of fs.readdirSync(target, { withFileTypes: true })) {
        if (e.name.startsWith('.')) continue;
        if (e.isDirectory()) dirs.push(e.name);
        else if (e.isFile()) files.push(e.name);
      }
    } catch (e) {
      return { ok: false, error: '无法读取目录：' + ((e && e.message) || e) };
    }
    const zh = (a, b) => a.localeCompare(b, 'zh-Hans-CN');
    const up = path.dirname(target);
    return {
      ok: true,
      path: target,
      parent: up === target ? '' : up,      // 盘符根没有上级
      dirs: dirs.sort(zh),
      files: files.sort(zh).slice(0, 200),  // 只读名字辅助定位，大目录截断
    };
  }

  /**
   * 创建工具任务。
   * @param {{root?:string, recursive?:boolean, files?:string[], stepIds:string[],
   *   params?:Object, output?:Object}} spec
   * @returns {{ok:boolean, taskId?:string, error?:string}}
   */
  runTool(spec) {
    if (!this.shouldUseNodeEngine('tool')) return { ok: false, error: '程序文件不完整（缺少运行组件），请重新安装或校验程序文件' };
    const mod = this._toolSteps();
    if (!mod) return { ok: false, error: '程序文件不完整（缺少处理组件），请重新安装或校验程序文件' };
    const s = spec || {};

    // ① 步骤：逐个校验存在性（前端可能缓存了旧 schema）
    const raw = Array.isArray(s.stepIds) ? s.stepIds.map(String).filter(Boolean) : [];
    const unknown = raw.filter((id) => !mod.getStep(id));
    if (unknown.length) return { ok: false, error: '未知的处理步骤：' + unknown.join('、') };
    const stepIds = mod.listSteps().map((x) => x.id).filter((id) => raw.indexOf(id) >= 0);  // 固定位次
    if (!stepIds.length) return { ok: false, error: '请至少勾选一个处理步骤' };

    // ② 输入：显式文件清单优先，否则扫描目录
    const files = (Array.isArray(s.files) ? s.files : [])
      .map(String)
      .filter((p) => { try { return p && fs.existsSync(p) && fs.statSync(p).isFile(); } catch (e) { return false; } });
    const root = String(s.root || '').trim();
    let rootOk = false;
    try { rootOk = !!root && fs.existsSync(root) && fs.statSync(root).isDirectory(); } catch (e) { rootOk = false; }
    if (!files.length && !rootOk) return { ok: false, error: '请选择要处理的目录或视频文件' };

    // ③ 输出策略
    const out = s.output || {};
    const mode = out.mode === 'directory' ? 'directory' : 'overwrite';
    const dir = String(out.dir || '').trim();
    if (mode === 'directory' && !dir) return { ok: false, error: '请选择输出目录' };
    if (mode === 'directory' && rootOk && path.resolve(dir) === path.resolve(root)) {
      // 允许（outplan 会自动新建子目录，不会静默覆盖），仅此处不做拦截
    }
    const output = {
      mode,
      dir: mode === 'directory' ? path.resolve(dir) : '',
      nameMode: out.nameMode === 'suffix' ? 'suffix' : 'keep',
      suffix: String(out.suffix == null ? '_处理' : out.suffix),
      onConflict: ['overwrite', 'skip'].indexOf(out.onConflict) >= 0 ? out.onConflict : 'index',
      backup: out.backup === true,
      backupDir: String(out.backupDir || '').trim() ? path.resolve(String(out.backupDir).trim()) : '',
      // 设置里的「默认备份目录」：任务未单独指定备份目录时，引擎用它作为备份根
      defaultBackupDir: String(this.config.backup_dir || '').trim() ? path.resolve(String(this.config.backup_dir).trim()) : '',
    };

    // ④ 建任务（env 传参，与三个成片模块同一机制）
    const stepTitles = stepIds.map((id) => (mod.getStep(id) || {}).title || id);
    const scope = files.length ? (files.length + ' 个文件') : path.basename(root);
    const title = '视频处理 · ' + stepTitles.join(' + ') + ' · ' + scope;
    const env = {
      TOOL_SPEC: JSON.stringify({
        stepIds,
        params: s.params || {},
        root,
        recursive: s.recursive !== false,
        files,
        output,
        toolName: '视频处理',
      }),
      VL_STORAGE_DIR: this.storageDir || '',
    };
    const task = this._createTask('tool', title, env, files.length ? files[0] : root);
    task.progress.total = files.length || 0;
    this._enqueueTask(task);
    this._lg('RUN', 'tool.start', '视频处理任务 · ' + title, { id: task.id, stepIds, files: files.length, output });
    return { ok: true, taskId: task.id };
  }

  /**
   * 工具任务「重新执行」：按同样参数重跑一遍 —— **不删除任何文件**。
   * 与 rerunTask 的本质区别：工具任务的产物就是被覆盖的源视频，没有第二份副本，
   * 任何"先删旧产物"的动作都可能删掉唯一的那份视频（计划 §5.3）。
   */
  rerunToolTask(id) {
    const t = this.tasks.get(id);
    if (!t) return { ok: false, error: '任务不存在' };
    if (t.type !== 'tool') return { ok: false, error: '该任务不是视频处理任务' };
    if (t.status === 'running' || t.status === 'queued' || t.status === 'paused') {
      return { ok: false, error: '进行中的任务不能重新执行' };
    }
    const marker = this._loadMarker(t);
    const env = Object.assign({}, (marker && marker.env) || t.env || {});
    if (!env.TOOL_SPEC) return { ok: false, error: '原任务缺少处理参数，无法重新执行' };
    const nt = this._createTask('tool', String(t.title || '视频处理'), env, '');
    nt.progress.total = (t.progress && t.progress.total) || 0;
    this._enqueueTask(nt);
    this._lg('RUN', 'tool.rerun', '视频处理 · 重新执行（不删除任何文件）· ' + String(t.title || '').slice(0, 50),
      { from: id, to: nt.id });
    return { ok: true, taskId: nt.id };
  }

  runBatch(filePath, count, group) {
    if (!this.shouldUseNodeEngine('batch')) return { ok: false, error: '程序文件不完整（缺少运行组件），请重新安装或校验程序文件' };
    const notSet = this._settingsError('batch');
    if (notSet.length) return { ok: false, error: '批量拼接参数未设置：' + notSet.join('、') + '，请到 设置-批量拼接 中配置后再启动' };
    const b = this.config.batch || {};
    const env = Object.assign({ REPLICA_TXT: path.resolve(filePath) }, this._cacheEnvBase());
    Object.assign(env, {
      BATCH_MAX_DURATION: String(b.max_duration),
      BATCH_MAX_RETRY: String(b.max_retry),
      BATCH_SPEED_LIMIT: String(b.speed_limit),
      BATCH_TXT_PREFIX: (Array.isArray(b.txt_prefix) ? b.txt_prefix : String(b.txt_prefix == null ? '' : b.txt_prefix)).map(String).filter((x) => String(x).trim() !== '').join(';'),
      BATCH_PRODUCER: String(b.producer).trim(),
      BATCH_SUFFIX_MARK: String(b.suffix_mark == null ? '' : b.suffix_mark).trim(),
    });
    const countStr = String(count).trim();
    if (/^\d+$/.test(countStr) && parseInt(countStr, 10) > 0) env.BATCH_COUNT = countStr;
    const groupStr = String(group).trim();
    env.BATCH_GROUP = /^\d+$/.test(groupStr) && parseInt(groupStr, 10) > 0 ? groupStr : '0';
    // 任务提交时刻：排队跨天运行时，成片命名/日志/输出目录按提交日期而非运行日期
    env.BATCH_SUBMIT_TS = String(Date.now());
    env.REPLICA_NO_WAIT = '1';
    const task = this._enqueueTask(this._createTask('batch', this._taskTitle(filePath), env, filePath));
    // 排队即预填预计成片数/分组数（配置底部输入），运行后由输出解析覆写 total
    const preTotal = parseInt(String(count), 10) || 0;
    const preGroup = parseInt(String(group), 10) || 0;
    if (preTotal > 0) task.progress.total = preTotal;
    if (preGroup > 0) task.progress.groupCount = preGroup;
    return { ok: true, taskId: task.id };
  }

  runReplica(logPath, mode = 1, entryVideo, opts) {
    if (!this.shouldUseNodeEngine('replica')) return { ok: false, error: '程序文件不完整（缺少运行组件），请重新安装或校验程序文件' };
    const notSet = this._settingsError('replica');
    if (notSet.length) return { ok: false, error: '视频复刻参数未设置：' + notSet.join('、') + '，请到 设置-视频复刻 中配置后再启动' };
    const r = this.config.replica || {};
    const o = opts || {};
    const num = (v, dft) => { const n = parseFloat(v); return Number.isFinite(n) && n > 0 ? n : dft; };
    const boolOn = (v, dft) => (v === undefined || v === null) ? (dft !== false) : (v === true);
    const env = Object.assign({
      REPLICA_TXT: path.resolve(logPath),
      REPLICA_MODE: String(mode) === '2' ? '2' : '1',
      REPLICA_NO_WAIT: '1',
      REPLICA_MAX_DURATION: String(r.max_duration),
      REPLICA_SPEED_LIMIT: String(r.speed_limit),
      // 重复度区间：本次任务弹窗传入优先，未传则用设置里的默认值与默认启用状态
      // （下限=至少替换到的占比；上限=尽量避免超过，超过会被平台判为全新视频）
      REPLICA_DEDUP_RATIO: String(num(o.dedupRatio, r.dedup_ratio)),
      REPLICA_DEDUP_MIN: String(num(o.dedupRatio, r.dedup_ratio)),
      REPLICA_DEDUP_MAX: String(num(o.dedupRatioMax, r.dedup_ratio_max)),
      REPLICA_DEDUP_MIN_ON: boolOn(o.dedupRatioOn, r.dedup_ratio_on) ? '1' : '0',
      REPLICA_DEDUP_MAX_ON: boolOn(o.dedupRatioMaxOn, r.dedup_ratio_max_on) ? '1' : '0',
    }, this._cacheEnvBase());
    // 任务提交时刻：排队跨天运行时，复刻命名/日志/输出目录按提交日期而非运行日期
    env.REPLICA_SUBMIT_TS = String(Date.now());
    // 仅复刻日志中的单个指定成片（右侧「复刻」按钮/批量选择传入成片名）
    if (entryVideo) env.REPLICA_ONLY_NAME = String(entryVideo).trim();
    const modeLabel = String(mode) === '2' ? '去重' : '原片';
    const task = this._enqueueTask(this._createTask('replica', this._replicaTaskTitle(logPath, modeLabel), env, logPath));
    return { ok: true, taskId: task.id };
  }

  // 断点续跑：失败/中断/停止的复刻任务，仅续跑失败/未完成的成片，不删除已成功产物。
  // 从 failedVideos 或日志中提取失败成片名，构造 REPLICA_ONLY_NAMES 新任务。
  continueReplica(id) {
    const t = this.tasks.get(id);
    if (!t) return { ok: false, error: '任务不存在' };
    const softPaused = t._softPaused === true && t.status === 'paused';
    if (!softPaused && t.status !== 'error' && t.status !== 'interrupted' && t.status !== 'stopped') {
      return { ok: false, error: '仅失败/中断/停止的任务可继续制作' };
    }
    // 续跑入口（replica / batch 共用；mask 走 continueMask）：
    // batch 的成片名含日期前缀、输出目录含提交时刻，故续跑必须复用原环境变量（尤其 BATCH_SUBMIT_TS），
    // 否则续跑产物会落到新日期目录、名字前缀也变，无法与首次归为同一批
    if (t.type !== 'replica' && t.type !== 'batch') return { ok: false, error: '仅复刻/批量任务支持继续制作' };
    // 收集失败成片名：优先 failedVideos（运行时逐条记录），回退日志行解析
    const failNames = new Set();
    if (Array.isArray(t.failedVideos)) {
      for (const f of t.failedVideos) if (f && f.name) failNames.add(f.name);
    }
    if (!failNames.size) {
      for (const ln of (t.log || [])) {
        const m = /❌ 失败成片：([^|]+)/.exec(String(ln));
        if (m) failNames.add(String(m[1]).trim());
      }
    }
    // 如果没有失败记录，但已完成条目 < 总数，则尝试从 marker 推断未完成的条目
    if (!failNames.size) {
      const marker = this._loadMarker(t);
      const doneVideos = (marker && Array.isArray(marker.videos) ? marker.videos : []);
      if (doneVideos.length) {
        // 路由 A（复刻）：源 TXT 本身就是成片名清单，减去已完成的即为未完成项
        const srcEnv = t.env || {};
        const srcPath = srcEnv.REPLICA_TXT ? String(srcEnv.REPLICA_TXT).trim() : '';
        if (srcPath && fs.existsSync(srcPath)) {
          try {
            const srcLines = fs.readFileSync(srcPath, 'utf-8').split('\n').filter((l) => (l || '').trim());
            const doneBases = new Set(doneVideos.map((v) => path.basename(v)));
            for (const line of srcLines) {
              const ln = line.trim();
              if (ln.endsWith('.mp4') && !ln.includes('\\') && !ln.includes('/') && !doneBases.has(ln)) failNames.add(ln);
            }
          } catch (e) {}
        }
        // 路由 B（批量）：源 TXT 是素材配置而非成片名清单，路由 A 必然一无所获。
        // 改为「应有 total 片 − 已产出序号」反推缺失序号，再用已产出成片名作模板构造名字 ——
        // 引擎只从名字里反解序号（parseOnlyNameIndex），不比对完整名，故模板 + 目标序号即足够。
        if (!failNames.size && t.type === 'batch') {
          const plannedTotal = (t.progress && t.progress.total) || 0;
          // 序号反解与名字构造须与引擎的 parseOnlyNameIndex 同口径：末段 = 可选后缀标识
          // （不含短横与数字）+ 序号 + 可选组后缀。既兼容「配置了后缀标识」的名字
          // （...-A2A.mp4），也兼容曾经漏掉分隔符产出的名字（...-resume2A.mp4）。
          const idxOf = (n) => { const m = /-([^-\d]*)(\d+)([A-Z]?)\.mp4$/i.exec(String(n)); return m ? parseInt(m[2], 10) : 0; };
          const doneIdx = new Set();
          for (const v of doneVideos) { const i = idxOf(path.basename(String(v))); if (i > 0) doneIdx.add(i); }
          // 成片目录里实际存在的文件也算已完成（标记可能未含最后一刻的产出）
          const markerOutDir = marker && marker.batchOutDir ? String(marker.batchOutDir) : '';
          if (markerOutDir && fs.existsSync(markerOutDir)) {
            try { for (const f of fs.readdirSync(markerOutDir)) { const i = idxOf(f); if (i > 0) doneIdx.add(i); } } catch (e) {}
          }
          if (plannedTotal > 0 && doneIdx.size > 0) {
            const sample = path.basename(String(doneVideos[0]));
            // 捕获组顺序：$1 后缀标识 / $2 原序号 / $3 组后缀 —— 替换串只能用 $1 与 $3，
            // 用 $2 会把「原序号」当成组后缀拼进去（...-21.mp4）
            const mkName = (i) => sample.replace(/-([^-\d]*)(\d+)([A-Z]?)\.mp4$/i, '-$1' + i + '$3.mp4');
            for (let i = 1; i <= plannedTotal; i++) if (!doneIdx.has(i)) failNames.add(mkName(i));
          }
        }
      }
    }
    if (!failNames.size) {
      this._lg('RUN', 'resume.fail',
        '续跑中止 · 既无失败记录也无从标记反推 · ' + t.type + ' · ' + String(t.title || '').slice(0, 50),
        { id: t.id, failedVideos: (t.failedVideos || []).length, logLines: (t.log || []).length });
      return { ok: false, error: '没有发现需要续跑的成片，请检查任务日志' };
    }
    const namesArr = [...failNames].filter(Boolean);
    // 构造续跑环境：复用原任务环境变量，仅追加过滤变量
    const env = Object.assign({}, t.env || {});
    let src = env.REPLICA_TXT ? String(env.REPLICA_TXT) : '';
    if (!src) return { ok: false, error: '原任务缺少 TXT 配置，无法继续制作' };
    this.tasks.delete(id);
    this._removeMarker(t);
    let task;
    if (t.type === 'batch') {
      // 配置 TXT 在首次运行时已被移入成片目录作为正本（引擎与 PS1 同语义），
      // 续跑必须按成片目录重定位，否则旧路径已失效 → 引擎报「未通过环境变量 REPLICA_TXT 提供 TXT 文件」
      const relocated = this._locateBatchConfig(src, t);
      if (relocated) { src = relocated; env.REPLICA_TXT = relocated; }
      // batch：只重做失败成片对应的「序号」，其余逻辑（命名/分组）仍按原始 BATCH_COUNT/BATCH_GROUP 计算；
      // 提交时刻刻意不刷新 → 成片命名前缀、输出目录、拼接日志均与首次一致（续跑即补做同一批的缺片）
      // 命名前的失败只能按序号补做：优先用 failedIndices（BATCH_ONLY_INDEX），
      // 没有序号时才退回按成片名过滤（BATCH_ONLY_NAMES）
      const idxArr = Array.isArray(t.failedIndices) ? t.failedIndices.filter((n) => Number.isInteger(n) && n > 0) : [];
      if (idxArr.length) {
        env.BATCH_ONLY_INDEX = idxArr.join(';');
        delete env.BATCH_ONLY_NAMES;
      } else {
        env.BATCH_ONLY_NAMES = namesArr.join(';');
      }
      task = this._createTask('batch', (t.title || '') + '（续跑）', env, src);
    } else {
      env.REPLICA_ONLY_NAMES = namesArr.join(';');
      env.REPLICA_SUBMIT_TS = String(Date.now()); // 刷新提交时刻，续跑产物按当前日期输出
      task = this._createTask('replica', (t.title || '') + '（续跑）', env, src);
    }
    this._enqueueTask(task);
    this._lg('RUN', 'resume.create',
      '续跑已创建 · ' + t.type + ' · 补做 ' + namesArr.length + ' 片'
      + (t.type === 'batch' ? ' · 沿用原提交时刻（命名与输出目录同首次）' : ' · 刷新提交时刻（按当前日期输出）'),
      { from: t.id, to: task.id,
        onlyVar: t.type === 'batch' ? (env.BATCH_ONLY_INDEX ? 'BATCH_ONLY_INDEX' : 'BATCH_ONLY_NAMES') : 'REPLICA_ONLY_NAMES',
        only: namesArr.slice(0, 40),
        env: this._envBrief(env) });
    return { ok: true, taskId: task.id, count: namesArr.length };
  }

  // 批量任务续跑的配置重定位。
  // 背景：配置正本在首次运行时被移入成片目录归档（引擎与 PS1 同语义），续跑沿用旧路径必然失效。
  // 关键约束：成片名里含「配置所在目录名」（引擎以 baseDir 名作命名基准），若直接改用归档路径，
  // 续跑产物名会多出一段目录名而与首次不一致 → 必须先复制回原路径，再以原路径运行。
  // 复制是幂等的：引擎读到该副本后会再次把它移回归档位置（覆盖同名）。
  _locateBatchConfig(oldPath, t) {
    const cur = String(oldPath || '');
    try { if (cur && fs.existsSync(cur)) return cur; } catch (e) {}
    const found = this._findArchivedConfig(cur, t);
    if (!found) return '';
    if (cur) {
      try {
        fs.mkdirSync(path.dirname(cur), { recursive: true });
        fs.copyFileSync(found, cur);
        return cur; // 命名基准保持不变
      } catch (e) { /* 原位置不可写 → 退回归档路径（名字可能带上目录名，但任务能跑通） */ }
    }
    return found;
  }

  // 归档配置三级查找：成片目录下同名 → 原目录下同名 → 成片目录内唯一非日志 TXT
  _findArchivedConfig(oldPath, t) {
    const cur = String(oldPath || '');
    const base = cur ? path.basename(cur) : '';
    const dirs = [];
    if (t && t.outDir) dirs.push(t.outDir);
    if (cur) dirs.push(path.dirname(cur));
    for (const d of dirs) {
      if (!d) continue;
      if (base) {
        const p = path.join(d, base);
        try { if (fs.existsSync(p)) return p; } catch (e) {}
      }
      try {
        if (!fs.existsSync(d) || !fs.statSync(d).isDirectory()) continue;
        for (const n of fs.readdirSync(d)) {
          if (!n.toLowerCase().endsWith('.txt') || /日志/.test(n)) continue;
          return path.join(d, n);
        }
      } catch (e) {}
    }
    return '';
  }

  // 遮罩叠加任务：payload 来自主窗口遮罩叠加模式（mode/rawDirs/videos/maskDirs/watermark/outputDir），
  // 经环境变量 MASK_* 驱动内置引擎的 mask 模块；无设置页配置组，参数随任务提交
  runMask(p) {
    if (!this.shouldUseNodeEngine('mask')) return { ok: false, error: '程序文件不完整（缺少运行组件），请重新安装或校验程序文件' };
    const errs = [];
    const dirs = Array.isArray(p && p.rawDirs) ? p.rawDirs.filter((d) => String(d).trim()) : [];
    if (!dirs.length) errs.push('原片文件夹');
    if (!String((p && p.outputDir) || '').trim()) errs.push('输出目录');
    const mode = parseInt(p && p.mode, 10);
    const needMask = mode === 1 || mode === 3;
    const needWm = mode === 1 || mode === 2;
    // 遮罩项可能是目录（扫描其下 .mov），也可能是用户添加的单个 .mov 文件（路径即文件本身）——
    // 文件项必须归入 MASK_MASKS（遮罩清单），若混进 MASK_MASK_DIRS 会被引擎当目录判「不存在」
    const maskDirs = [], maskFiles = [];
    if (needMask && Array.isArray(p && p.maskDirs)) {
      for (const d of p.maskDirs) {
        const v = String(d || '').trim();
        if (!v) continue;
        const rp = path.resolve(v);
        let isFile = false;
        try { isFile = fs.statSync(rp).isFile(); } catch (e) {}
        (isFile ? maskFiles : maskDirs).push(rp);
      }
    }
    if (needMask && !maskDirs.length && !maskFiles.length) errs.push('遮罩');
    if (needWm && !String((p && p.watermark) || '').trim()) errs.push('水印文件');
    if (errs.length) return { ok: false, error: '遮罩叠加配置缺失：' + errs.join('、') };
    // 勾选视频序列化：完整路径分号分隔（空=该文件夹全部）
    const pickVids = [];
    const vids = (p && p.videos) || {};
    for (const dir of Object.keys(vids)) {
      // 原片项可能是目录（名称+相对路径）或用户添加的单个视频文件（路径即文件本身）
      let dirIsFile = false;
      try { dirIsFile = fs.statSync(dir).isFile(); } catch (e) {}
      for (const name of (vids[dir] || [])) {
        if (String(name).trim()) pickVids.push(dirIsFile ? path.resolve(dir) : path.resolve(dir, name));
      }
    }
    // 任务列表标题：项目名 / 遮罩名（遮罩名按 mov 前缀去重，与遮罩主题分组口径一致）
    const maskPfx = (name) => String(name || '').replace(/\.[^.]+$/, '').replace(/[-_ ]+\d+$/, '').replace(/\d+$/, '');
    const projName = String((p && p.projectName) || '').trim() || (dirs[0] ? path.basename(dirs[0]) : '');
    const themeNames = [];
    const themeSeen = new Set();
    String((p && p.masks) || '').split(';').forEach((s) => {
      const fp = String(s).trim();
      if (!fp) return;
      const pfx = maskPfx(path.basename(fp));
      if (!themeSeen.has(pfx)) { themeSeen.add(pfx); themeNames.push(pfx); }
    });
    const title = projName + (themeNames.length ? ' / ' + themeNames.join('+') : '');
    const env = {
      MASK_MODE: String(mode || 1),
      MASK_RAW_DIRS: dirs.map((d) => path.resolve(d)).join(';'),
      MASK_VIDEOS: pickVids.join(';'),
      MASK_MASK_DIRS: maskDirs.join(';'),
      MASK_MASKS: [String((p && p.masks) || '').trim(), maskFiles.join(';')].filter((x) => x).join(';'),
      MASK_WATERMARK: needWm ? path.resolve(p.watermark) : '',
      MASK_OUTPUT_DIR: path.resolve(p.outputDir),
      MASK_PROJECT_NAME: String((p && p.projectName) || '').trim(),
      MASK_SUFFIX_MARK: String((p && p.suffix) || '').trim(),
      MASK_LOG_DIR: String((p && p.logDir) || '').trim(),
      MASK_WATERMARK_ALPHA: this._maskWmAlphaString(p && p.watermarkAlpha),
      MASK_SUBMIT_TS: String(Date.now()),
    };
    Object.assign(env, this._cacheEnvBase());
    const task = this._enqueueTask(this._createTask('mask', title, env, dirs[0]));
    return { ok: true, taskId: task.id };
  }

  // 前端异常上报：界面上的报错此前只弹 toast，事后无从回溯 —— 落进错误日志（与引擎失败同一份）。
  // payload: { kind, msg, stack, where, href }
  reportUiError(p) {
    try {
      const o = (p && typeof p === 'object') ? p : {};
      const kind = String(o.kind || 'exception');
      const msg = String(o.msg || o.message || '').slice(0, 300);
      const stack = String(o.stack || '').slice(0, 1500);
      const where = String(o.where || '').slice(0, 80);
      const href = String(o.href || '').slice(0, 240);
      this._lg('UI', kind === 'rejection' ? 'ui.rejection' : 'ui.exception',
        (msg || '前端异常（无错误消息）') + (where ? ' @ ' + where : ''),
        { where, href, stack });
      return { ok: true };
    } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
  }

  // 遮罩水印透明度解析：任务传入值优先，其次设置页配置；留空/非法回退脚本默认 0.3
  _maskWmAlphaString(v) {
    let raw = (v == null || String(v).trim() === '') ? this.config.mask.watermark_alpha : v;
    const n = parseFloat(String(raw == null ? '' : raw));
    if (!(n >= 0.05 && n <= 1)) return '0.3';
    return String(n);
  }

  // 断点续跑：失败/中断/停止的遮罩叠加任务，仅续跑失败成片（MASK_ONLY_NAMES 过滤），不删已成功产物
  continueMask(id) {
    const t = this.tasks.get(id);
    if (!t) return { ok: false, error: '任务不存在' };
    if (t.status !== 'error' && t.status !== 'interrupted' && t.status !== 'stopped') return { ok: false, error: '仅失败/中断/停止的任务可继续制作' };
    if (t.type !== 'mask') return { ok: false, error: '仅遮罩叠加任务支持继续制作' };
    const failNames = new Set();
    if (Array.isArray(t.failedVideos)) {
      for (const f of t.failedVideos) if (f && f.name) failNames.add(f.name);
    }
    if (!failNames.size) {
      for (const ln of (t.log || [])) {
        const m = /❌ 失败成片：([^|]+)/.exec(String(ln));
        if (m) failNames.add(String(m[1]).trim());
      }
    }
    if (!failNames.size) return { ok: false, error: '没有发现需要续跑的成片，请检查任务日志' };
    const namesArr = [...failNames].filter(Boolean);
    const env = Object.assign({}, t.env || {});
    env.MASK_ONLY_NAMES = namesArr.join(';');
    env.MASK_SUBMIT_TS = String(Date.now());
    if (!env.MASK_RAW_DIRS) return { ok: false, error: '原任务缺少原片文件夹信息，无法继续制作' };
    this.tasks.delete(id);
    this._removeMarker(t);
    const task = this._createTask('mask', (t.title || '') + '（续跑）', env, t.srcPath || '');
    this._enqueueTask(task);
    return { ok: true, taskId: task.id, count: namesArr.length };
  }

  // 遮罩叠加项目素材只读扫描：仅扫描遮罩叠加独立工作路径（设置-遮罩叠加 配置）。
  listMaskProjects() {
    // 遮罩主题组前缀：与前端 maskGroupPrefix 一致（去扩展名、去尾部序号），徽章与右栏分组口径统一
    const _maskPrefix = (name) => {
      let s = String(name || '').replace(/\.[^.]+$/, '');
      s = s.replace(/[-_ ]+\d+$/, '').replace(/\d+$/, '');
      return s;
    };
    // 仅使用遮罩叠加独立工作路径（不允许复用批量项目管理路径）
    const root = (this.config && this.config.mask && String(this.config.mask.root || '').trim());
    if (!root) return [];
    const out = [];
    let entries = [];
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch (e) { return []; }
    for (const en of entries) {
      if (!en.isDirectory()) continue;
      const pdir = path.join(root, en.name);
      // 遮罩主题：项目下直接子文件夹中任一含 mov 视频（遮罩素材仅认 .mov，mp4 不算遮罩主题）
let themes = [];
    try {
    themes = fs.readdirSync(pdir, { withFileTypes: true })
    .filter((s) => s.isDirectory())
    .map((s) => s.name)
    .filter((n) => {
    try {
    return fs.readdirSync(path.join(pdir, n)).some((f) => /\.mov$/i.test(f));
    } catch (e) { return false; }
    })
    .sort((a, b) => a.localeCompare(b, 'zh-CN'));
    } catch (e) {}
      // 主题组数：项目内全部 mov（根目录+任意子文件夹）按名称前缀去重，与右栏真实分组一致
      let themeCount = 0;
      const seenPrefix = new Set();
      const walkMasks = (d) => {
        let ents = [];
        try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
        for (const s2 of ents) {
          if (s2.name === '已完成') continue; // 与右栏主题列表同口径：旧脚本产物目录不参与计数
          const full = path.join(d, s2.name);
          if (s2.isDirectory()) walkMasks(full);
          else if (/\.mov$/i.test(s2.name)) seenPrefix.add(_maskPrefix(s2.name));
        }
      };
      walkMasks(pdir);
      themeCount = seenPrefix.size;
      // 纳入条件：项目内有遮罩主题子文件夹，或任意位置（含根目录）存在 .mov 主题素材
      if (themes.length || themeCount > 0) out.push({ name: en.name, path: pdir, themes, themeCount });
    }
    out.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
    return out;
  }

  // 扫描目录下视频/遮罩素材（含子文件夹），返回 { name, sub, dur }；时长异步探测
  _listMaskMedia(dir, exts) {
    const abs = path.resolve(dir);
    if (!fs.existsSync(abs)) return Promise.resolve([]);
    // 单文件（用户通过「添加文件或文件夹」添加的单个视频文件）：扩展名匹配则返回该文件
    try {
      const st = fs.statSync(abs);
      if (st.isFile()) {
        if (!exts.has(path.extname(abs).toLowerCase())) return Promise.resolve([]);
        return this._maskMediaInfo(abs).then((r) => [{ name: path.basename(abs), sub: '', dur: r && r.duration > 0 ? r.duration : 0 }]);
      }
    } catch (e) { return Promise.resolve([]); }
    const items = [];
    const walk = (d, rel) => {
      let ents = [];
      try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
      for (const en of ents) {
        if (en.name === '已完成') continue; // 旧脚本妥协产物目录不参与展示
        const full = path.join(d, en.name);
        if (en.isDirectory()) walk(full, rel ? rel + '/' + en.name : en.name);
        else if (exts.has(path.extname(en.name).toLowerCase())) items.push({ full, name: en.name, sub: rel || '' });
      }
    };
    walk(abs, '');
    items.sort((a, b) => (a.sub === b.sub ? a.name.localeCompare(b.name, 'zh-CN') : a.sub.localeCompare(b.sub, 'zh-CN')));
    return this._runWithLimit(items, (it) => this._maskMediaInfo(it.full).then((r) => ({ name: it.name, sub: it.sub, dur: r && r.duration > 0 ? r.duration : 0 })), 6);
  }

  listMaskVideos(dir) { return this._listMaskMedia(dir, new Set(['.mp4', '.mov', '.avi', '.mkv', '.m4v', '.webm', '.flv'])); }

  listMaskMasks(dir) { return this._listMaskMedia(dir, new Set(['.mov'])); }

  // 解析 .lnk 快捷方式目标（单个）；非快捷方式/解析失败返回空串
  resolveShortcut(p) {
    if (!p || !/\.lnk$/i.test(p)) return '';
    const m = this._resolveShortcutTargets([p]);
    return (m && m[p]) ? String(m[p]) : '';
  }

  // 统一添加入口（原片/遮罩侧「添加文件或文件夹」）：接受 快捷方式 / 视频文件 / 文件夹，
  // 快捷方式先解析目标，再按类型返回；原片=mp4 等视频，遮罩=mov。返回 { type: 'dir'|'file', path } 或 { error }
  maskAddSource(side, p) {
    if (!p) return { error: '空路径' };
    let target = String(p);
    if (/\.lnk$/i.test(target)) {
      target = this.resolveShortcut(target);
      if (!target) return { error: '快捷方式无效（无法解析目标）' };
    }
    try {
      const st = fs.statSync(target);
      if (st.isDirectory()) return { type: 'dir', path: target };
      if (st.isFile()) {
        const ext = path.extname(target).toLowerCase();
        const okExt = side === 'theme' ? ['.mov'] : ['.mp4', '.mov', '.avi', '.mkv', '.m4v', '.webm', '.flv'];
        if (okExt.indexOf(ext) < 0) return { error: side === 'theme' ? '遮罩仅支持 .mov 文件' : '不支持的文件类型' };
        return { type: 'file', path: target };
      }
      return { error: '无法识别该路径' };
    } catch (e) { return { error: '路径不存在' }; }
  }

  // 原片默认扫描：递归收集项目下所有含 mp4 的文件夹（以 mp4 所在文件夹为单位分组，不跳过任何目录；根目录含 mp4 也计入）
  scanMaskRawDirs(dir) {
    const abs = path.resolve(dir);
    const hitDirs = [];
    const hitKeys = {};
    const addHit = (d) => { const k = String(d).replace(/[\\/]+$/, '').toLowerCase(); if (!hitKeys[k]) { hitKeys[k] = 1; hitDirs.push(d); } };
    const hasMp4 = (d) => {
      try { return fs.readdirSync(d).some((f) => /\.mp4$/i.test(f)); } catch (e) { return false; }
    };
    const lnks = [];
    const walk = (d) => {
      let ents = [];
      try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
      for (const en of ents) {
        const full = path.join(d, en.name);
        if (en.isDirectory()) {
          if (hasMp4(full)) addHit(full);
          walk(full);
        } else if (en.isFile() && path.extname(en.name).toLowerCase() === '.lnk') {
          lnks.push(full);
        }
      }
    };
    if (!fs.existsSync(abs)) return [];
    if (hasMp4(abs)) addHit(abs);
    walk(abs);
    // .lnk 快捷方式：解析目标目录并递归扫描其内容；目标路径/文件夹已存在则跳过
    if (lnks.length) {
      const map = this._resolveShortcutTargets(lnks);
      for (const l of lnks) {
        const t = map[l];
        if (!t) continue;
        const target = String(t).trim();
        if (!target) continue;
        try { if (!fs.statSync(target).isDirectory()) continue; } catch (e) { continue; }
        if (hitKeys[String(target).replace(/[\\/]+$/, '').toLowerCase()]) continue; // 目标已存在 → 跳过
        addHit(target);
        walk(target);
      }
    }
    return hitDirs
      .map((d) => ({ path: d, name: path.basename(d) || String(d) }))
      .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
  }

  // 遮罩主题文件指纹（轻量自愈检测用：仅 readdir 收集 .mov 相对路径集，不探测，不落盘）
  maskThemeSig(dir) {
    try {
      if (!dir || !fs.existsSync(dir)) return { count: 0, sig: '' };
      const names = [];
      const walk = (d, rel) => {
        let ents = [];
        try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
        for (const en of ents) {
          if (en.name === '已完成') continue;
          const full = path.join(d, en.name);
          if (en.isDirectory()) walk(full, rel ? rel + '/' + en.name : en.name);
          else if (/\.mov$/i.test(en.name)) names.push(rel ? rel + '/' + en.name : en.name);
        }
      };
      walk(dir, '');
      names.sort();
      return { count: names.length, sig: names.join('|') };
    } catch (e) { return { count: 0, sig: '' }; }
  }

  // 遮罩叠加日志目录约定：项目\遮罩日志
  _maskLogDir(projectPath) { return path.join(projectPath, '遮罩日志'); }

  // 按成片名从视频缓存反查实际文件（用户手动迁移后仍可定位；日志 @out 缺失时兜底）。
  // 查全部作用域：待查成片可能来自任意模式，此处不做来源过滤。
  _findMaskOut(videoName) {
    const target = String(videoName == null ? '' : videoName).toLowerCase();
    if (!target) return '';
    if (this._useDbCache()) {
      try {
        const mask = this._scopes.batch | this._scopes.replica | this._scopes.mask;
        const map = this._cacheStore.loadVideoMap({ scopesMask: mask });
        for (const p of Object.keys(map)) {
          if (!p || path.basename(p).toLowerCase() !== target) continue;
          try { if (fs.existsSync(p)) return p; } catch (e) {}
        }
        return '';
      } catch (e) { /* 库读取失败 → 退回内存缓存 */ }
    }
    try {
      const cache = this._loadVideoCache();
      for (const p of Object.keys(cache)) {
        if (!p || path.basename(p).toLowerCase() !== target) continue;
        try { if (fs.existsSync(p)) return p; } catch (e) {}
      }
    } catch (e) {}
    return '';
  }

  // 从遮罩日志读取成片块中的 @out 路径行（返回候选路径，不要求文件仍存在；
  // 前端据此打开文件夹，并用 check_exists 判定「打开成片」是否可点）
  _maskOutFromLog(logPath, videoName) {
    const text = readText(logPath);
    const lines = text.split(/\r?\n/).map((l) => l.trim());
    for (let i = 0; i < lines.length; i++) {
      if (lines[i] !== videoName) continue;
      // 成片名行向下 8 行内找 @out（块内顺序：成片名/使用片段列表：/素材/@out），
      // 遇 === 分隔线即止；不能因紧邻的「使用片段列表：」提前退出，否则 @out 永远读不到
      for (let j = i + 1; j < Math.min(i + 8, lines.length); j++) {
        const m = /^@out:\s*(.+)$/.exec(lines[j]);
        if (m) { const p = String(m[1]).trim().replace(/^"|"$/g, ''); return p ? p : ''; }
        if (lines[j].startsWith('===')) break;
      }
      break;
    }
    return '';
  }

  // 列出项目的遮罩叠加日志：每个日志文件只读一次，同步解析成片块与 @out 实际路径；
  // 按日志目录内文件 名称+mtime 签名缓存，未变化直接复用（切换项目/进出日志视图不再重复解析）
  listMaskLogs(projectPath) {
    const pdir = String(projectPath || '').trim();
    const logDir = this._maskLogDir(pdir);
    if (!pdir || !fs.existsSync(logDir)) return [];
    let files = [];
    try { files = fs.readdirSync(logDir).filter((n) => n.endsWith('.txt')).sort(); } catch (e) { return []; }
    const sig = logDir + '|' + files.map((n) => { let m = 0; try { m = fs.statSync(path.join(logDir, n)).mtimeMs; } catch (e) {} return n + ':' + m; }).join('|');
    if (this._maskLogCache && this._maskLogCache.key === sig) return JSON.parse(JSON.stringify(this._maskLogCache.logs));
    const logs = [];
    for (const f of files) {
      const fp = path.join(logDir, f);
      let text;
      try { text = readText(fp); } catch (e) { continue; }
      const lines = text.split(/\r?\n/);
      // 一次扫描构建 成片名 → @out 映射：成片名行（其下一行为「使用片段列表：」）块内取 @out
      const outMap = {};
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].trim() !== '使用片段列表：' || i < 1) continue;
        const name = lines[i - 1].trim();
        if (!name || /^[A-Za-z]:[\\/]/.test(name)) continue;
        for (let j = i + 1; j < Math.min(i + 8, lines.length); j++) {
          const tm = /^@out:\s*(.+)$/.exec(lines[j]);
          if (tm) { const p = String(tm[1]).trim().replace(/^"|"$/g, ''); if (p) outMap[name] = p; break; }
          if (lines[j].trim() === '使用片段列表：' || lines[j].trim().startsWith('===')) break;
        }
      }
      const entries = this._parseLog(fp, text).map((e) => Object.assign({}, e, { outPath: outMap[e.video] || this._findMaskOut(e.video) }));
      logs.push({ file: f, path: fp, name: path.basename(f, '.txt'), entries, mtime: fs.existsSync(fp) ? fs.statSync(fp).mtimeMs : 0 });
    }
    logs.sort((a, b) => b.mtime - a.mtime);
    this._maskLogCache = { key: sig, logs };
    return JSON.parse(JSON.stringify(logs));
  }

  // 删除与指定素材（原片/遮罩路径）相关的所有遮罩叠加成片：按日志块片段精确匹配，
  // 删除成片文件并同步从日志移除对应块；返回删除列表

  // 原片/遮罩会话状态（缓存，非设置）：存于 cache_kv（键 mask_session:<项目名>）
  // 不手动清除/移除就会一直在列表里；重建缓存菜单项清空后回退自动扫描
  // 遮罩会话登记的全部素材目录（含手动添加的项目外路径）：统一刷新、作用域落库与认领共用
  _maskSessionDirs() {
    const out = [];
    try {
      const projects = (this.listProjects() || []).map((x) => (x && x.name) || x).filter(Boolean);
      for (const name of projects) {
        let sess = null;
        try { sess = this.getMaskSession(name); } catch (e) { sess = null; }
        if (!sess) continue;
        for (const d of [].concat(sess.rawDirs || [], sess.themes || [])) {
          const p = stripQuotes(String((d && d.path) || '').trim());
          if (p) out.push(p);
        }
      }
    } catch (e) { /* 会话不可读时返回已收集部分 */ }
    return out;
  }
  getMaskSession(projectName) {
    if (!this._useDbCache()) return null;
    try {
      const raw = this._cacheStore.getKv('mask_session:' + String(projectName || ''));
      if (!raw) return null;
      const d = JSON.parse(raw);
      return (d && typeof d === 'object') ? d : null;
    } catch (e) { return null; }
  }
  saveMaskSession(projectName, data) {
    if (!this._useDbCache()) return { ok: false, error: '缓存库不可用' };
    try {
      this._cacheStore.setKv('mask_session:' + String(projectName || ''), JSON.stringify(data || {}));
      return { ok: true };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  }
  // projectName 为空 = 清空全部项目会话缓存
  clearMaskSession(projectName) {
    if (!this._useDbCache()) return { ok: true };
    try {
      if (!projectName) {
        const store = this._cacheStore;
        store.transaction(() => {
          for (const k of Object.keys(store.listKv('mask_session:'))) store.removeKv(k);
        });
        return { ok: true };
      }
      this._cacheStore.removeKv('mask_session:' + String(projectName || ''));
      return { ok: true };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  }

  // —— 项目默认输出目录（项目级设置，独立于会话缓存；供底栏输出目录占位符与选择初始路径）——
  // 存于设置库 scope='mask'，键为项目名
  getMaskDefaultDir(projectName) {
    if (!this._useSettings()) return '';
    try { return String(this._settingsStore.get('mask', String(projectName || ''), '') || '').trim(); } catch (e) { return ''; }
  }
  setMaskDefaultDir(projectName, dir) {
    if (!this._useSettings()) return { ok: false };
    try {
      this._settingsStore.set('mask', String(projectName || ''), String(dir || '').trim());
      return { ok: true };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  }

  // 删除指定遮罩叠加成片（按成片名）：删除文件并同步从日志移除对应块
  deleteMaskVideos(projectPath, videoNames) {
    const pdir = String(projectPath || '').trim();
    const logDir = this._maskLogDir(pdir);
    const names = Array.isArray(videoNames) ? videoNames.map((n) => String(n).trim()).filter(Boolean) : [];
    if (!pdir || !fs.existsSync(logDir)) return { ok: false, error: '项目无遮罩日志' };
    if (!names.length) return { ok: false, error: '未指定成片名' };
    const nset = new Set(names.map((n) => n.toLowerCase()));
    const deleted = [];
    let files = [];
    try { files = fs.readdirSync(logDir).filter((n) => n.endsWith('.txt')); } catch (e) { return { ok: false, error: '读取日志失败' }; }
    for (const f of files) {
      const fp = path.join(logDir, f);
      const text = readText(fp);
      const lines = text.split(/\r?\n/).map((l) => l.replace(/\r$/, ''));
      const keep = [];
      let i = 0;
      let changed = false;
      while (i < lines.length) {
        const line = lines[i];
        const isBlockHead = i + 1 < lines.length && lines[i + 1].trim() === '使用片段列表：';
        if (isBlockHead) {
          let j = i + 2;
          while (j < lines.length) {
            const t = lines[j].trim();
            if (t === '使用片段列表：' || t.startsWith('===')) break;
            j++;
          }
          const block = lines.slice(i, j);
          const vname = (block[0] || '').trim();
          if (vname && nset.has(vname.toLowerCase())) { changed = true; i = j; continue; }
          // 未命中：整块保留（成片名/使用片段列表/素材/@out 原样）
          for (let k = i; k < j; k++) keep.push(lines[k]);
          i = j;
          continue;
        }
        keep.push(line);
        i++;
      }
      if (changed) {
        // 先采集清单留痕，再一律移入回收站
        const outs = [];
        for (const vn of names) {
          const op = this._maskOutFromLog(fp, vn) || this._findMaskOut(vn);
          if (op && fs.existsSync(op)) outs.push(op);
        }
        if (outs.length) {
          const info = this._describeForLog(outs);
          this._lg('DEL', 'mask.videos.remove',
            '删除遮罩成片 · ' + info.count + ' 个文件 · 共 ' + this._humanSize(info.bytes)
            + ' · 日志 ' + path.basename(fp), Object.assign({ project: pdir }, info));
        }
        for (const op of outs) { this._recycleFile(op); deleted.push(op); }
        // 仅剩分隔线/空行时视为已空，移除日志文件（走回收站）；否则原子写回
        const outText = keep.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
        const hasContent = keep.some((l) => (l || '').trim() && !/^=+$/.test((l || '').trim()));
        if (hasContent) atomicWrite(fp, outText);
        else this._recycleFile(fp);
      }
    }
    return { ok: true, deleted };
  }

  // 删除指定遮罩日志文件（整份 TXT，非单块）：限定在「项目遮罩日志目录」内，
  // 不依赖批量工作路径（遮罩项目可位于任意路径，removeBranch 的 this.root 校验会误拒）；
  // 删除后若该日志目录为空则一并清理（以遮罩日志目录为边界，不越界）
  deleteMaskLog(projectPath, logPath) {
    const pdir = String(projectPath || '').trim();
    const logDir = this._maskLogDir(pdir);
    if (!pdir || !logDir || !fs.existsSync(logDir)) return { ok: false, error: '项目无遮罩日志' };
    const lp = String(logPath || '').trim();
    if (!lp) return { ok: false, error: '未指定日志文件' };
    const rl = path.resolve(lp);
    const rdir = path.resolve(logDir);
    if (rl !== rdir && !rl.startsWith(rdir + path.sep)) return { ok: false, error: '日志不在项目遮罩日志目录内' };
    if (!rl.toLowerCase().endsWith('.txt')) return { ok: false, error: '仅支持移除遮罩日志 TXT' };
    try {
      if (!fs.existsSync(rl)) return { ok: false, error: '日志文件不存在：' + lp };
      // 先留痕（路径/大小/原修改时间），再移入回收站
      const info = this._describeForLog([rl]);
      this._lg('DEL', 'mask.log.remove',
        '删除遮罩日志 · ' + path.basename(rl) + ' · ' + this._humanSize(info.bytes),
        Object.assign({ project: pdir }, info));
      this._recycleFile(rl);
      try {
        const rest = fs.readdirSync(rdir);
        if (!rest.length) { try { fs.rmdirSync(rdir); } catch (e) {} }
      } catch (e) {}
    } catch (e) { return { ok: false, error: String(e) }; }
    this._maskLogCache = null; // 日志缓存失效，下次 listMaskLogs 重读
    return { ok: true };
  }

  // 重新定位遮罩成片：成片可能被外部移走（@out 路径失效/不在原输出目录），
  // 用户在列表/分支右键选择新目录后，在本目录（含子目录）按「文件名完全一致」查找同名成片；
  // 找到则把该成片所在日志块 @out 行改写成新路径并返回，前端据此刷新视图
  relocateMaskOut(projectPath, videoName, newDir) {
    const pdir = String(projectPath || '').trim();
    const logDir = this._maskLogDir(pdir);
    const vn = String(videoName || '').trim().replace(/^"|"$/g, '');
    const nd = String(newDir || '').trim().replace(/^"|"$/g, '');
    if (!pdir || !logDir || !fs.existsSync(logDir)) return { ok: false, error: '项目无遮罩日志' };
    if (!vn) return { ok: false, error: '未指定成片名' };
    if (!nd || !fs.existsSync(nd) || !fs.statSync(nd).isDirectory()) return { ok: false, error: '所选目录无效' };
    if (!/\.mp4$/i.test(vn)) vn += '.mp4';
    // 目录递归查找同名文件（与外部手动迁移的「文件名=同一成片」语义一致）
    const found = this._findVideoByName(nd, vn);
    if (!found) return { ok: false, error: '所选目录中未找到同名成片：' + path.basename(vn) };
    // 改写日志块 @out：遍历日志文件，命中该成片名行后在其块内替换 @out
    let written = false;
    let files = [];
    try { files = fs.readdirSync(logDir).filter((n) => n.endsWith('.txt')); } catch (e) { return { ok: false, error: '读取日志失败' }; }
    for (const f of files) {
      const fp = path.join(logDir, f);
      const text = readText(fp);
      const lines = text.split(/\r?\n/);
      let changed = false;
      const vnLow = vn.toLowerCase();
      for (let i = 0; i < lines.length; i++) {
        const nameLine = lines[i].replace(/\r$/, '').trim();
        if (nameLine.toLowerCase() !== vnLow) continue;
        // 块内 8 行内找 @out（遇 === 止；「使用片段列表：」允许越过，与 _maskOutFromLog 同口径）
        for (let j = i + 1; j < Math.min(i + 8, lines.length); j++) {
          const t = lines[j].replace(/\r$/, '');
          if (t.startsWith('===')) break;
          const m = /^@out:\s*(.+)$/.exec(t);
          if (m) { if (String(m[1]).trim().replace(/^"|"$/g, '') !== found) { lines[j] = '@out: ' + found; changed = true; } break; }
        }
        break; // 同名成片只对应一个块
      }
      if (changed) { atomicWrite(fp, lines.join('\n')); written = true; }
    }
    if (!written) {
      // 日志中无该成片记录：仍返回 ok，前端提示已定位但未改写日志
      return { ok: true, path: found, noLog: true };
    }
    this._maskLogCache = null;
    return { ok: true, path: found };
  }

  // 目录内（含子目录）按文件名（含扩展名，大小写不敏感）查找视频；找到返回完整路径，否则空串
  _findVideoByName(dir, fileName) {
    const target = String(fileName || '').toLowerCase();
    const walk = (d) => {
      let ents = [];
      try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return ''; }
      for (const en of ents) {
        const full = path.join(d, en.name);
        if (en.isDirectory()) { const r = walk(full); if (r) return r; }
        else if (en.isFile() && en.name.toLowerCase() === target && /\.(mp4|mov|avi|mkv|m4v)$/i.test(en.name)) return full;
      }
      return '';
    };
    return walk(dir);
  }

  // 迁移指定遮罩叠加成片到新文件夹：移动文件并同步更新遮罩日志块的 @out 路径
  moveMaskOut(projectPath, videoName, newDir) {
    const pdir = String(projectPath || '').trim();
    const logDir = this._maskLogDir(pdir);
    const vn = String(videoName || '').trim();
    const nd = String(newDir || '').trim();
    if (!pdir || !fs.existsSync(logDir)) return { ok: false, error: '项目无遮罩日志' };
    if (!vn || !nd) return { ok: false, error: '缺少成片名或目标目录' };
    if (!fs.existsSync(nd)) { try { fs.mkdirSync(nd, { recursive: true }); } catch (e) { return { ok: false, error: '创建目标目录失败' }; } }
    let files = [];
    try { files = fs.readdirSync(logDir).filter((n) => n.endsWith('.txt')); } catch (e) { return { ok: false, error: '读取日志失败' }; }
    for (const f of files) {
      const fp = path.join(logDir, f);
      const src = this._maskOutFromLog(fp, vn) || this._findMaskOut(vn);
      if (!src || !fs.existsSync(src)) continue;
      const ext = path.extname(vn) || '.mp4';
      let dest = path.join(nd, vn);
      let k = 1;
      while (fs.existsSync(dest)) { dest = path.join(nd, path.basename(vn, ext) + '_' + k + ext); k++; }
      try { fs.renameSync(src, dest); } catch (e) { return { ok: false, error: '移动文件失败：' + String(e) }; }
      // 更新日志块 @out 行
      const text = readText(fp);
      const lines = text.split(/\r?\n/);
      const updated = lines.map((l) => {
        const m = /^@out:\s*(.+)$/.exec(l.replace(/\r$/, ''));
        if (m && path.basename(String(m[1]).trim().replace(/^"|"$/g, '')) === vn) return '@out: ' + dest;
        return l;
      });
      atomicWrite(fp, updated.join('\n'));
      return { ok: true, from: src, to: dest };
    }
    return { ok: false, error: '未找到成片：' + vn };
  }

  // 删除二次拼接产物：扫描项目下所有拼接日志/复刻日志，找出片段引用遮罩叠加成片的成片块，
  // 删除对应二次成片文件并同步从日志移除块（成片与日志同目录）
  deleteSecondaryProducts(projectPath, maskOutPaths) {
    const pdir = String(projectPath || '').trim();
    const refs = new Set((Array.isArray(maskOutPaths) ? maskOutPaths : []).map((p) => path.basename(String(p)).toLowerCase()));
    if (!pdir || !refs.size) return { ok: false, error: '未指定引用成片' };
    const deleted = [];
    const removedVideos = [];
    const logFiles = [];
    const walk = (d) => {
      let ents = [];
      try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
      for (const en of ents) {
        if (en.name === '遮罩日志') continue;
        const full = path.join(d, en.name);
        if (en.isDirectory()) walk(full);
        else if (en.isFile() && en.name.endsWith('.txt') && /(拼接日志|复刻日志)/.test(en.name)) logFiles.push(full);
      }
    };
    walk(pdir);
    for (const fp of logFiles) {
      const text = readText(fp);
      const lines = text.split(/\r?\n/).map((l) => l.replace(/\r$/, ''));
      const keep = [];
      const fileVideos = [];   // 本文件命中的成片（不跨文件累积，避免同一成片被重复定位）
      let i = 0;
      let changed = false;
      while (i < lines.length) {
        const line = lines[i];
        if (line.trim() === '使用片段列表：') {
          const block = [];
          let j = Math.max(0, i - 1);
          while (j < lines.length) {
            const l = lines[j];
            if (l.trim() === '使用片段列表：' && j !== i) break;
            if (l.trim().startsWith('===')) break;
            block.push(l);
            j++;
            if (j < lines.length && lines[j].trim() === '使用片段列表：') break;
            if (j < lines.length && lines[j].trim().startsWith('===')) { block.push(lines[j]); j++; break; }
          }
          const clips = block.slice(2).filter((l) => l.trim() && /^[A-Za-z]:[\\/]|^\\\\/.test(l.trim()));
          const hit = clips.some((c) => refs.has(path.basename(c.trim()).toLowerCase()));
          if (hit) {
            changed = true;
            const vname = (block[0] || '').trim();
            if (vname) { fileVideos.push(vname); removedVideos.push(vname); }
            i = j;
            continue;
          }
          for (let k = Math.max(0, i - 1); k < j; k++) keep.push(lines[k]);
          i = j;
          continue;
        }
        keep.push(line);
        i++;
      }
      if (changed) {
        const logDir = path.dirname(fp);
        // 先采集清单留痕，再一律移入回收站
        const outs = [];
        for (const vn of fileVideos) {
          const op = path.join(logDir, vn);
          if (fs.existsSync(op)) outs.push(op);
        }
        if (outs.length) {
          const info = this._describeForLog(outs);
          this._lg('DEL', 'secondary.products.remove',
            '删除二次拼接产物 · ' + info.count + ' 个文件 · 共 ' + this._humanSize(info.bytes)
            + ' · 日志 ' + path.basename(fp), Object.assign({ project: pdir }, info));
        }
        for (const op of outs) { this._recycleFile(op); deleted.push(op); }
        // 仅剩分隔线/空行时视为已空，移除日志文件（走回收站）；否则原子写回
        const outText = keep.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
        const hasContent = keep.some((l) => (l || '').trim() && !/^=+$/.test((l || '').trim()));
        if (hasContent) atomicWrite(fp, outText);
        else this._recycleFile(fp);
      }
    }
    return { ok: true, deleted, videos: removedVideos };
  }

  resolvePath(filePath) { return path.resolve(filePath); }

  // 检测应用运行所需的外部环境是否可用（ffmpeg / ffprobe / 内置引擎）
  // 项目实际依赖的滤镜清单（三模块 + 视频处理工具的 -filter_complex 全量收集）
  // 精简版/第三方便携构建常缺 colorchannelmixer、signalstats 等 —— 只查存在性拦不住
  // 解析 ffmpeg / ffprobe 实际生效路径：配置目录（自愈下载）优先，回退系统 PATH。
  // 纯同步、极快（existsSync + where），可安全用于启动路径。
  _resolveFfmpegBin() {
    const cfgDir = String((this.config && this.config.ffmpeg_dir) || '').trim();
    const resolveBin = (name, configured) => {
      if (configured) { try { if (fs.existsSync(configured)) return configured; } catch (e0) {} }
      try {
        const r = require('child_process').spawnSync('where', [name], { windowsHide: true, encoding: 'utf8' });
        if (r.status === 0) {
          const first = String(r.stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
          if (first) return first;
        }
      } catch (e) {}
      return '';
    };
    return {
      cfgDir,
      ffmpegPath: resolveBin('ffmpeg', cfgDir ? path.join(cfgDir, 'ffmpeg.exe') : ''),
      ffprobePath: resolveBin('ffprobe', cfgDir ? path.join(cfgDir, 'ffprobe.exe') : ''),
    };
  }

  // 探测缓存：ffmpeg 路径 + 文件 大小/mtime 作指纹，命中即复用，避免每次启动重跑两个 ffmpeg 进程。
  // ⚠ 指纹必须含文件本身的 stat —— 仅用路径会让「重装/升级 ffmpeg 后仍用旧结论」。
  _envProbeFingerprint(ffmpegPath) {
    if (!ffmpegPath) return '';
    try { const st = fs.statSync(ffmpegPath, { bigint: true }); return ffmpegPath + '|' + String(st.size) + '|' + String(st.mtimeMs); }
    catch (e) { return ffmpegPath + '|?'; }
  }

  // 环境检测（异步）：与 checkEnv 同语义，但滤镜/编码器探测走异步 execFile，
  // **不阻塞主进程事件循环**。启动路径必须用这个 —— 同步版在冷启动（首次加载 200MB+ ffmpeg、
  // 安全软件扫描未签名二进制）时会阻塞十几秒到数十秒，直接把窗口显示推迟到分钟级。
  checkEnvAsync() {
    const { cfgDir, ffmpegPath, ffprobePath } = this._resolveFfmpegBin();
    const finish = (missing, missingEncoders) => {
      const filtersOk = !!ffmpegPath && missing.length === 0;
      const encodersOk = !!ffmpegPath && missingEncoders.length === 0;
      return {
        ffmpeg: !!ffmpegPath,
        ffprobe: !!ffprobePath,
        engine: !!this._engineRunnerPath(),
        ffmpegPath, ffprobePath, filtersOk, encodersOk, missing, missingEncoders,
        downloadNeeded: !ffmpegPath || !ffprobePath || !filtersOk || !encodersOk,
        ffmpegDir: cfgDir,
      };
    };
    if (!ffmpegPath) return Promise.resolve(finish([], []));
    const fp = this._envProbeFingerprint(ffmpegPath);
    if (this._envProbeCache && this._envProbeCache.fp === fp) {
      return Promise.resolve(finish(this._envProbeCache.missing.slice(), this._envProbeCache.missingEncoders.slice()));
    }
    if (this._envProbeInflight) return this._envProbeInflight;   // 并发合并：同时多处调用只跑一轮
    const run = (args) => new Promise((resolve) => {
      let done = false;
      const settle = (v) => { if (!done) { done = true; resolve(v); } };
      try {
        const p = require('child_process').execFile(ffmpegPath, args,
          { windowsHide: true, timeout: 20000, maxBuffer: 16 * 1024 * 1024 },
          (err, stdout) => { settle(err ? '' : String(stdout || '')); });
        p.on('error', () => settle(''));
      } catch (e) { settle(''); }
    });
    this._envProbeInflight = (async () => {
      // 两个探测可并行：互不依赖，串行只会让耗时翻倍
      const [outF, outE] = await Promise.all([run(['-hide_banner', '-filters']), run(['-hide_banner', '-encoders'])]);
      const missing = [];
      const missingEncoders = [];
      if (!outF) missing.push(...FFMPEG_REQUIRED_FILTERS);
      else for (const f of FFMPEG_REQUIRED_FILTERS) if (!outF.includes(' ' + f + ' ')) missing.push(f);
      if (!outE) missingEncoders.push(...FFMPEG_REQUIRED_ENCODERS);
      else for (const e3 of FFMPEG_REQUIRED_ENCODERS) if (!outE.includes(' ' + e3 + ' ')) missingEncoders.push(e3);
      this._envProbeCache = { fp, missing: missing.slice(), missingEncoders: missingEncoders.slice(), at: Date.now() };
      this._envProbeInflight = null;
      return finish(missing, missingEncoders);
    })();
    return this._envProbeInflight;
  }

  checkEnv() {
    const { cfgDir, ffmpegPath, ffprobePath } = this._resolveFfmpegBin();
    // 滤镜链完整性：-filters 实跑比对
    const missing = [];
    const missingEncoders = [];
    if (ffmpegPath) {
      const { spawnSync } = require('child_process');
      try {
        const r = spawnSync(ffmpegPath, ['-hide_banner', '-filters'],
          { windowsHide: true, encoding: 'utf8', timeout: 20000, maxBuffer: 16 * 1024 * 1024 });
        if (r.status === 0) {
          const out = String(r.stdout || '');
          for (const f of FFMPEG_REQUIRED_FILTERS) if (!out.includes(' ' + f + ' ')) missing.push(f);
        } else missing.push(...FFMPEG_REQUIRED_FILTERS);
      } catch (e2) { missing.push(...FFMPEG_REQUIRED_FILTERS); }
      // 硬件编码器同样实跑比对（滤镜可用 ≠ 编码器可用）
      try {
        const r2 = spawnSync(ffmpegPath, ['-hide_banner', '-encoders'],
          { windowsHide: true, encoding: 'utf8', timeout: 20000, maxBuffer: 16 * 1024 * 1024 });
        if (r2.status === 0) {
          const out2 = String(r2.stdout || '');
          for (const e3 of FFMPEG_REQUIRED_ENCODERS) if (!out2.includes(' ' + e3 + ' ')) missingEncoders.push(e3);
        } else missingEncoders.push(...FFMPEG_REQUIRED_ENCODERS);
      } catch (e4) { missingEncoders.push(...FFMPEG_REQUIRED_ENCODERS); }
    }
    const filtersOk = !!ffmpegPath && missing.length === 0;
    const encodersOk = !!ffmpegPath && missingEncoders.length === 0;
    return {
      ffmpeg: !!ffmpegPath,
      ffprobe: !!ffprobePath,
      // 引擎入口是否就绪；false 即任务无法执行（前端据此提示重装）
      engine: !!this._engineRunnerPath(),
      ffmpegPath, ffprobePath, filtersOk, encodersOk, missing, missingEncoders,
      downloadNeeded: !ffmpegPath || !ffprobePath || !filtersOk || !encodersOk,
      ffmpegDir: cfgDir,
    };
  }

  // 备份自动清理：删除超过保留天数的处理前备份（走回收站，可还原）；
  // 目录取设置里的「默认备份目录」，未设置时用数据目录下的 backup
  _cleanupBackups() {
    try {
      if (this.config.backup_auto_clean !== true) return;
      const days = parseInt(this.config.backup_keep_days, 10) || 7;
      // 与实际备份根一致：用户自选目录时同样落在其下的「Video Lab 备份」层（清理才清得到）
      const customRoot = String(this.config.backup_dir || '').trim();
      const root = customRoot ? path.join(customRoot, 'Video Lab 备份')
        : path.join(this.storageDir || process.cwd(), 'backup');
      if (!fs.existsSync(root)) return;
      const expire = Date.now() - days * 24 * 60 * 60 * 1000;
      let n = 0;
      const walk = (d) => {
        for (const name of fs.readdirSync(d)) {
          const p2 = path.join(d, name);
          let st = null;
          try { st = fs.statSync(p2); } catch (e) { continue; }
          if (st.isDirectory()) { walk(p2); continue; }
          if (st.mtimeMs < expire) {
            if (shell && typeof shell.trashItem === 'function') shell.trashItem(p2).catch(() => {});
            n++;
          }
        }
      };
      walk(root);
      if (n) this._lg('DEL', 'backup.cleanup', '清理过期备份 · ' + n + ' 个文件 · 保留 ' + days + ' 天');
    } catch (e) {}
  }

  // 过期锁清理：进程被强杀（崩溃 / 任务管理器结束）时 finally 不执行，锁文件会残留下来；
  // 而 .locks 目录只建不删 —— 残留会一直累积，用户也无从清理。
  // 判定与 acquireLock 的过期规则一致：pid 不存活 或 写入时间超过 60 秒
  _cleanupStaleLocks() {
    try {
      const dir = path.join(this.storageDir || process.cwd(), '.locks');
      if (!fs.existsSync(dir)) return;
      for (const name of fs.readdirSync(dir)) {
        if (!/\.lock$/i.test(name)) continue;
        const lockFile = path.join(dir, name);        // 锁文件是进程间同步用的临时控制文件，非业务数据
        let st = null;
        try { st = fs.statSync(lockFile); } catch (e) { continue; }
        if (!st || !st.isFile()) continue;
        let holder = null;
        try { holder = JSON.parse(fs.readFileSync(lockFile, 'utf8')); } catch (e) { holder = null; }
        let alive = false;
        if (holder && holder.pid) {
          try { process.kill(holder.pid, 0); alive = true; } catch (e) { alive = (e && e.code === 'EPERM'); }
        }
        const stale = !alive || (Date.now() - (st.mtimeMs || 0) > 60 * 1000);
        if (stale) { try { fs.unlinkSync(lockFile); } catch (e) {} }
      }
    } catch (e) {}
  }

  // ── 应用级设置（settings.db scope='app'）──
  // 用户定案：设置项能进 settings 就进 settings —— config.json 只留「定位数据目录」的锚点，
  // 其余业务键一律存 settings.db，读取只认 settings、**不读 config.json 回退**。
  // 这样未来简化 config 时不会波及任何设置项（曾经的「回退读 config」正是隐患：config 一旦被
  // 裁掉某键，回退路径就取到 undefined，表现为设置莫名丢失或软件报错）。
  // 白名单仅供 main 端 get_settings 组装默认值时参考；读写本身不限键（任意键均可存取）。
  static APP_SETTING_KEYS = ['notify_task_end', 'show_maintenance',
    'backup_dir', 'backup_auto_clean', 'backup_keep_days'];

  // 启动时把 settings.db 的 app scope 全量载入内存 config（覆盖 DEFAULT_CONFIG 的默认值）。
  // 未落过库的键保持默认值 —— 这就是「不回退 config」后的取值语义：
  // 库里有就用库里的，库里没有就用默认值，绝不回头读 config.json。
  _loadAppSettings() {
    if (!this._useSettings()) return;
    let all = {};
    try { all = this._settingsStore.all('app') || {}; } catch (e) { all = {}; }
    for (const k of Object.keys(all)) {
      if (all[k] === undefined || all[k] === null) continue;
      this.config[k] = all[k];
    }
  }

  // 单个应用级设置的读取 —— 供 main 的 get_settings / 通知开关等使用。
  // fallback 只在「设置库不可用」这一极端情形下使用（此时内存 config 也仅有默认值）。
  getAppSetting(key, fallback) {
    if (this._useSettings()) {
      const v = this._settingsStore.get('app', key);
      if (v !== undefined && v !== null) return v;
    }
    return (this.config && this.config[key] !== undefined) ? this.config[key] : fallback;
  }

  // 全量读取 app scope（供 main 端组装完整配置：settings.db 是唯一来源）
  getAppSettings() {
    if (!this._useSettings()) return {};
    try { return this._settingsStore.all('app') || {}; } catch (e) { return {}; }
  }

  // 写入任意应用级设置（不限键）：main 端保存配置时逐键落库。
  // 显式传对象而非默认取 this.config —— main.config 与 backend.config 是两个对象，
  // 保存时必须由调用方给出要写的键值，避免两边不同步。
  _saveAppSettings(values) {
    if (!this._useSettings()) return;
    const vals = (values && typeof values === 'object') ? values : {};
    for (const k of Object.keys(vals)) {
      if (vals[k] === undefined) continue;
      try { this._settingsStore.set('app', k, vals[k]); } catch (e) {}
    }
  }

  // 删除应用级设置键（供一次性迁移用：旧键搬走后不留残留，保持「单一真相」）
  _removeAppSetting(key) {
    if (!this._useSettings()) return false;
    try { return Number(this._settingsStore.remove('app', String(key))) > 0; } catch (e) { return false; }
  }

  // Windows 系统通知（任务失败 / 本轮跑完）：
  // 走主进程 Notification（app.setAppUserModelId 已在 main 设置，通知才能正常显示）。
  // 通知不可用时静默 —— 提示失败绝不能影响任务流本身
  _notify(title, body) {
    try {
      // 开关：config.json 的 notify_task_end —— 用户侧默认关闭（不打扰）；本机/开发机可置 true
      if (!(this.config && this.config.notify_task_end === true)) return;
      const { Notification } = require('electron');
      if (!Notification || (Notification.isSupported && !Notification.isSupported())) return;
      new Notification({ title: String(title || ''), body: String(body || '') }).show();
      this._lg('RUN', 'notify', '系统通知 · ' + title + ' · ' + String(body || '').slice(0, 60));
    } catch (e) {}
  }

  _ffmpegTargetDir() {
    return path.join(this.storageDir || process.cwd(), 'ffmpeg');
  }

  // 引擎子进程的 FFmpeg 路径注入：自愈下载后的数据目录优先
  _ffmpegBinEnv() {
    const dir = String((this.config && this.config.ffmpeg_dir) || '').trim();
    if (!dir) return {};
    const out = {};
    try {
      const fe = path.join(dir, 'ffmpeg.exe'), pe = path.join(dir, 'ffprobe.exe');
      if (fs.existsSync(fe)) out.VL_FFMPEG_BIN = fe;
      if (fs.existsSync(pe)) out.VL_FFPROBE_BIN = pe;
    } catch (e) {}
    return out;
  }

  // 环境自愈：下载 FFmpeg / FFprobe（npmmirror 国内镜像，gzip 单文件用内置 zlib 解压）
  // 到数据目录 ffmpeg\ 并写回 ffmpeg_dir 配置；失败回滚配置，不留半成品路径
  async ensureFfmpeg(opts) {
    const force = !!(opts && opts.force);
    if (this._ffmpegBusy) return { ok: false, error: '已有 FFmpeg 修复在进行中' };
    const env0 = await this.checkEnvAsync();
    // force：用户显式点「自动下载」——跳过合格检查强制走完整下载（演示/重装数据目录组件）
    if (!force && !env0.downloadNeeded) return { ok: true, skipped: true, env: env0 };
    this._ffmpegBusy = true;
    const emit = (p) => { try { if (typeof this.onFfmpegProgress === 'function') this.onFfmpegProgress(p); } catch (e) {} };
    const dir = this._ffmpegTargetDir();
    const prevDir = String(this.config.ffmpeg_dir || '');
    try {
      fs.mkdirSync(dir, { recursive: true });
      this.config.ffmpeg_dir = dir;   // 校验与后续引擎运行都按新路径；失败回滚
      emit({ phase: 'check' });
      let ver = 'b6.1.1';
      try {
        const list = await this._httpGetJson('https://registry.npmmirror.com/-/binary/ffmpeg-static/');
        const vers = (list || []).map((x) => String(x.name || ''))
          .filter((n) => /^b[\d.]+\/$/.test(n)).map((n) => n.replace(/\/$/, ''))
          .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
        if (vers.length) ver = vers[vers.length - 1];
      } catch (e) {}
      const base = 'https://registry.npmmirror.com/-/binary/ffmpeg-static/' + ver + '/';
      let pctBase = 0;
      for (const pair of [['ffmpeg-win32-x64.gz', 'ffmpeg.exe'], ['ffprobe-win32-x64.gz', 'ffprobe.exe']]) {
        await this._downloadGunzip(base + pair[0], path.join(dir, pair[1]), (pct) => {
          emit({ phase: 'download', file: pair[1], percent: Math.min(99, Math.round(pctBase + pct / 2)) });
        });
        pctBase += 50;
      }
      const env1 = await this.checkEnvAsync();
      if (env1.downloadNeeded) throw new Error('下载完成但校验未通过：' + (env1.missing || []).join('、'));
      emit({ phase: 'done', ok: true, dir: dir, version: ver });
      this._lg('ENV', 'ffmpeg.ensure', 'FFmpeg 环境就绪 · ' + ver + ' · ' + dir, { dir: dir, version: ver });
      return { ok: true, dir: dir, version: ver, env: env1 };
    } catch (e) {
      this.config.ffmpeg_dir = prevDir;
      emit({ phase: 'error', error: String((e && e.message) || e) });
      this._lg('ERR', 'ffmpeg.ensure', 'FFmpeg 自动下载失败 · ' + String((e && e.message) || e), { dir: dir });
      return { ok: false, error: String((e && e.message) || e) };
    } finally { this._ffmpegBusy = false; }
  }

  _httpGetJson(url) {
    return new Promise((resolve, reject) => {
      this._httpGet(url, (buf) => {
        try { resolve(JSON.parse(buf.toString('utf8'))); } catch (e) { reject(e); }
      }, reject);
    });
  }

  _httpGet(url, onOk, onErr) {
    const mod = url.indexOf('https:') === 0 ? require('node:https') : require('node:http');
    const req = mod.get(url, { headers: { 'User-Agent': 'VideoLab' }, timeout: 20000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume(); this._httpGet(res.headers.location, onOk, onErr); return;
      }
      if (res.statusCode !== 200) { res.resume(); onErr(new Error('HTTP ' + res.statusCode)); return; }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => onOk(Buffer.concat(chunks)));
      res.on('error', onErr);
    });
    req.on('timeout', () => req.destroy(new Error('连接超时')));
    req.on('error', onErr);
  }

  // 下载 gz → 流式解压写盘；进度按 5% 步进回调
  _downloadGunzip(url, dest, onPct) {
    return new Promise((resolve, reject) => {
      const get = (u, n) => {
        const mod = u.indexOf('https:') === 0 ? require('node:https') : require('node:http');
        const req = mod.get(u, { headers: { 'User-Agent': 'VideoLab' }, timeout: 30000 }, (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && n < 5) {
            res.resume(); get(res.headers.location, n + 1); return;
          }
          if (res.statusCode !== 200) { res.resume(); reject(new Error('HTTP ' + res.statusCode)); return; }
          const zlib = require('node:zlib');
          const total = parseInt(res.headers['content-length'], 10) || 0;
          const chunks = []; let got = 0, last = 0;
          res.on('data', (c) => {
            got += c.length; chunks.push(c);
            const pct = total ? Math.floor((got / total) * 100) : 0;
            if (pct - last >= 5) { last = pct; if (onPct) onPct(pct); }
          });
          res.on('end', () => {
            try { fs.writeFileSync(dest, zlib.gunzipSync(Buffer.concat(chunks))); resolve(); }
            catch (e) { reject(e); }
          });
          res.on('error', reject);
        });
        req.on('timeout', () => req.destroy(new Error('下载超时')));
        req.on('error', reject);
      };
      get(url, 0);
    });
  }
}

module.exports = { Api, DEFAULT_CONFIG };
