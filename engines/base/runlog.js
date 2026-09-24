// 运行日志（面向排查）：%APPDATA%\Video Lab\log\
//   app-YYYY-MM-DD.log    全量流水，保留 7 天（扫读 + 检索两用）
//   error-YYYY-MM-DD.log  仅失败/异常，保留 30 天 —— 排查时只看这个文件即可定位原因
// 两份都按天切；错误日志保留更久，因为「上周出过一次的问题」往往要回头翻。
//
// 存在意义：任务记录、任务标记、成片产物都可能被用户清除或删除，一旦清除，
// 排查就只剩"反推"。本日志独立于这些数据，任何清除/删除操作都不触碰它 ——
// 它是"事后唯一还在的证据"。
//
// 单行格式（刻意设计成扫读 + 精确检索两用）：
//   2026-09-20 16:23:41.123  DEL  task.artifacts.remove  删 3 个成片 · 共 264.1 MB · {"task":"task_1_x","files":[...]}
//   └─ 时间(毫秒)          └─动词 └─动作(点分)              └─中文摘要（含关键数字）      └─结构化细节(JSON)
//
// 动词表（三字母，便于 grep 与一眼分类）：
//   SYS 启动/退出/环境      RUN 任务执行        DEL 删除（含移入回收站）
//   ADD 新增/创建           MOD 修改/移动       ERR 异常/失败
//   IPC 通道调用（兜底记录"用户点了什么"）      CFG 配置与设置
//
// 约定：写日志永不影响主流程 —— 全部 try/catch 静默；按天切文件；启动时清理 7 天前的。
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const KEEP_DAYS = 7;
const ERROR_KEEP_DAYS = 30;   // 错误日志保留更久：排查滞后性很强，7 天不够

let logDir = '';

/** 指定日志目录（调用方给出 storageDir\log） */
function init(dir) {
  logDir = String(dir || '');
  if (!logDir) return;
  try { fs.mkdirSync(logDir, { recursive: true }); } catch (e) {}
}

function pad(n, w) { return String(n).padStart(w, '0'); }
function dayOf(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1, 2) + '-' + pad(d.getDate(), 2); }
function stampOf(d) {
  return dayOf(d) + ' ' + pad(d.getHours(), 2) + ':' + pad(d.getMinutes(), 2) + ':' + pad(d.getSeconds(), 2)
    + '.' + pad(d.getMilliseconds(), 3);
}
function fileOf(day) { return path.join(logDir, 'app-' + day + '.log'); }
function errFileOf(day) { return path.join(logDir, 'error-' + day + '.log'); }

/** 敏感值脱敏：令牌 / 口令一律不入日志。两道正则 ——
 *  ① 带引号的键（JSON 形态）："http_token":"abc"  → "http_token":"***"
 *  ② 裸键（摘要/文本形态）：  http_token: abc     → http_token: ***        */
function scrub(s) {
  return String(s == null ? '' : s)
    .replace(/("(?:[a-z_]*token[a-z_]*|password|passwd|secret)"\s*:\s*)"[^"]*"/gi, '$1"***"')
    .replace(/\b((?:[a-z_]*token[a-z_]*|password|passwd|secret)\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;}]+)/gi, '$1***');
}

/** 结构化细节尽量压缩成单行，避免超长行影响扫读；顺带脱敏与截断 */
function briefData(data) {
  if (data == null) return '';
  try {
    let s = scrub(typeof data === 'string' ? data : JSON.stringify(data));
    if (s === '{}' || s === 'null' || s === '""') return '';
    if (s.length > 2000) s = s.slice(0, 2000) + '…(截断)';
    return s;
  } catch (e) { return ''; }
}

/** 通道入参/结果摘要：脱敏 + 压缩成单行 + 截断。IPC 与 HTTP 共用。 */
function briefArgs(v, max) {
  try {
    if (v == null) return '';
    const s = scrub(typeof v === 'string' ? v : JSON.stringify(v));
    if (!s || s === '{}' || s === '[]' || s === 'null' || s === '""') return '';
    return s.length > max ? s.slice(0, max) + '…' : s;
  } catch (e) { return ''; }
}

// 只读/展示类通道不记 —— 否则轮询会把日志淹成噪音。
// 覆盖：列表、读取、打开、窗口、检测、解析、搜索、定位、预检测、扫描、应答、事件推送。
const SILENT_CHANNEL = /^(list_|get_|read_|open_|window_|check_|resolve_|search_|find_|locate_|precheck|scan_|respond_|ack_|on_|task_replica_outdir)/;
function isSilentChannel(ch) { return SILENT_CHANNEL.test(String(ch == null ? '' : ch)); }

// 配置保存类通道只记「变更了的键」：全量配置一次数百字符，改几次皮肤就把日志刷满了。
// 快照放在本模块，IPC 与 HTTP 共用一份，避免两边互相误报差异。
const SETTINGS_DELTA_CHANNEL = /^save_(settings|mask_session)$/;
let _lastSettingsSnap = '';
function deltaArgs(channel, args) {
  if (!SETTINGS_DELTA_CHANNEL.test(String(channel == null ? '' : channel))) return args;
  const cur = args && args[0];
  if (!cur || typeof cur !== 'object') return args;
  let prev = {};
  try { prev = JSON.parse(_lastSettingsSnap || '{}'); } catch (e) { prev = {}; }
  const keys = new Set(Object.keys(prev).concat(Object.keys(cur)));
  const delta = {};
  let n = 0;
  for (const k of keys) {
    if (JSON.stringify(prev[k]) === JSON.stringify(cur[k])) continue;
    delta[k] = cur[k];
    n++;
  }
  try { _lastSettingsSnap = JSON.stringify(cur); } catch (e) {}
  return n ? [delta] : [];
}

/**
 * 通道调用留痕（IPC 与 HTTP 共用）。回答"用户到底点了什么"——
 * 任务窗口、主窗口、浏览器端的写操作都会留下这条。只读通道跳过。
 * @param {string} transport 'ipc' | 'http'
 * @param {string} channel   通道名
 * @param {*} args           入参
 * @param {*} result         返回值（用于判断 ok / 失败）
 * @param {number} ms        耗时
 */
function chEvent(transport, channel, args, result, ms) {
  try {
    if (isSilentChannel(channel)) return;
    const failed = !!(result && typeof result === 'object' && result.ok === false);
    const payload = briefArgs(deltaArgs(channel, args), 700);
    const res = briefArgs(result, 300);
    logEvent('IPC', String(channel),
      String(transport) + ' · ' + (failed ? '失败' : 'ok') + ' · ' + (Number(ms) || 0) + 'ms'
      + (failed && result && result.error ? ' · ' + String(result.error).slice(0, 160) : '')
      + (payload ? ' · 入参 ' + payload : ''),
      res ? { result: res } : null);
  } catch (e) { /* 静默 */ }
}

/** 单行格式化：时间 · 动词 · 动作 · 摘要 · 细节（脱敏与换行折叠都在这里） */
function formatLine(verb, action, summary, data) {
  const s = scrub(String(summary || '').replace(/\s*\n\s*/g, ' '));
  const d = briefData(data);
  const head = stampOf(new Date()) + '  ' + String(verb || 'SYS').padEnd(3) + '  ' + String(action || '-').padEnd(26);
  return head + (s ? '  ' + s : '') + (d ? '  · ' + d : '') + '\n';
}

/** 是否属于「失败/异常」类事件 —— 这类额外写一份进 error 日志（保留 30 天）。
 *  判定口径：动词 ERR / UI，或动作名里带 error/fail/失败/异常。 */
function isErrorish(verb, action) {
  const v = String(verb == null ? '' : verb).toUpperCase();
  if (v === 'ERR' || v === 'UI' || v === 'DIAG') return true;
  return /(error|fail|失败|异常|崩溃)/i.test(String(action == null ? '' : action));
}

/**
 * 写一条事件。刻意用同步追加 —— 本日志是"事后唯一证据"，可靠性优先于性能：
 * 流式写入的缓冲在进程退出（尤其是崩溃）时等不到 flush，最后几条恰好最可能是关键线索。
 * 写入失败一律静默，绝不影响主流程。
 * @param {string} verb    SYS/RUN/DEL/ADD/MOD/ERR/IPC/CFG
 * @param {string} action  点分动作名，如 task.artifacts.remove
 * @param {string} summary 中文一句话摘要（含关键数字），可为空
 * @param {object} [data]  结构化细节
 */
function logEvent(verb, action, summary, data) {
  try {
    if (!logDir) return;
    const day = dayOf(new Date());
    const line = formatLine(verb, action, summary, data);
    fs.appendFileSync(fileOf(day), line, 'utf8');
    // 失败/异常再写一份到错误日志：排查时只需看这一个文件
    if (isErrorish(verb, action)) {
      try { fs.appendFileSync(errFileOf(day), line, 'utf8'); } catch (e2) {}
    }
  } catch (e) { /* 静默 */ }
}

/** 同 logEvent（保留别名：退出/崩溃路径用它表达"必须落盘"的语义） */
const logEventSync = logEvent;

// 便捷包装
const sys = (action, summary, data) => logEvent('SYS', action, summary, data);
const run = (action, summary, data) => logEvent('RUN', action, summary, data);
const del = (action, summary, data) => logEvent('DEL', action, summary, data);
const add = (action, summary, data) => logEvent('ADD', action, summary, data);
const mod = (action, summary, data) => logEvent('MOD', action, summary, data);
const cfg = (action, summary, data) => logEvent('CFG', action, summary, data);
const ipc = (action, summary, data) => logEvent('IPC', action, summary, data);
function err(action, e, data) {
  const msg = (e && (e.message || e.stack)) ? String(e.message || e.stack) : String(e == null ? '' : e);
  logEvent('ERR', action, msg.split('\n')[0].slice(0, 300), data);
}

/** 前端异常上报（动词 UI）：界面上的报错此前只弹 toast，事后无从回溯 —— 现在一并落错误日志。
 *  @param {string} action  点分动作名，如 ui.exception / ui.rejection
 *  @param {string} msg     错误消息
 *  @param {object} [data]  { stack, where, href } */
function ui(action, msg, data) {
  logEvent('UI', String(action || 'ui.exception'), String(msg || '').slice(0, 300), data);
}

/** 文件大小可读化：供摘要里写「共 264.1 MB」 */
function humanSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

/**
 * 把一批文件路径整理成「可事后复盘的清单」：路径 + 大小 + 修改时间。
 * 删除类操作必须在删之前调用它 —— 这正是日志存在的头号理由。
 */
function describeFiles(paths, { max = 60 } = {}) {
  const list = Array.isArray(paths) ? paths : (paths ? [paths] : []);
  const out = [];
  let total = 0;
  for (const p of list) {
    if (out.length >= max) break;
    let size = 0, mtime = '';
    try { const st = fs.statSync(p); size = st.size; mtime = stampOf(st.mtime); } catch (e) { /* 不存在也记 */ }
    total += size;
    out.push({ p: String(p), size, mtime: mtime ? mtime.slice(5) : '' });
  }
  return { files: out, count: list.length, bytes: total, truncated: list.length > out.length };
}

/** 启动时清理超过 KEEP_DAYS 天的日志。日志属应用自管缓存，直接删除（不进回收站，避免长期堆积）。 */
function pruneOld(keepDays = KEEP_DAYS, keepErrorDays = ERROR_KEEP_DAYS) {
  if (!logDir) return { removed: 0 };
  try {
    let removed = 0;
    const cutoffApp = Date.now() - keepDays * 24 * 3600 * 1000;
    const cutoffErr = Date.now() - keepErrorDays * 24 * 3600 * 1000;
    for (const f of fs.readdirSync(logDir)) {
      const mA = /^app-(\d{4})-(\d{2})-(\d{2})\.log$/.exec(f);
      const mE = /^error-(\d{4})-(\d{2})-(\d{2})\.log$/.exec(f);
      const m = mA || mE;
      if (!m) continue;
      const t = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
      const cutoff = mA ? cutoffApp : cutoffErr;
      if (t < cutoff) { try { fs.unlinkSync(path.join(logDir, f)); removed++; } catch (e) {} }
    }
    return { removed };
  } catch (e) { return { removed: 0 }; }
}

/** 每条都是同步追加，没有待 flush 的缓冲；保留此函数供退出路径表达「日志收尾」语义 */
function close() {}

/** 当前日志目录（供设置页展示与打开） */
function getDir() { return logDir; }

/** 列出保留期内的日志文件（新的在前） */
function listDays() {
  if (!logDir) return [];
  const out = [];
  try {
    for (const f of fs.readdirSync(logDir)) {
      const m = /^app-(\d{4}-\d{2}-\d{2})\.log$/.exec(f);
      if (!m) continue;
      const full = path.join(logDir, f);
      let size = 0, mtime = 0;
      try { const st = fs.statSync(full); size = st.size; mtime = st.mtimeMs; } catch (e) {}
      out.push({ day: m[1], file: f, size, mtime });
    }
  } catch (e) { return []; }
  return out.sort((a, b) => (a.day < b.day ? 1 : -1));
}

/** 列出保留期内的错误日志文件（新的在前）—— 排查入口，优先于全量日志 */
function listErrorDays() {
  if (!logDir) return [];
  const out = [];
  try {
    for (const f of fs.readdirSync(logDir)) {
      const m = /^error-(\d{4}-\d{2}-\d{2})\.log$/.exec(f);
      if (!m) continue;
      const full = path.join(logDir, f);
      let size = 0, mtime = 0;
      try { const st = fs.statSync(full); size = st.size; mtime = st.mtimeMs; } catch (e) {}
      out.push({ day: m[1], file: f, size, mtime });
    }
  } catch (e) { return []; }
  return out.sort((a, b) => (a.day < b.day ? 1 : -1));
}

/**
 * 读取某日运行日志（排查用；缺省今天）。
 * 文件可能很大，只保留末尾的窗口：超过 MAX_READ 时从文件尾部读。
 * @param {string} day `YYYY-MM-DD`，留空取今天
 * @param {{tail?:number, grep?:string, maxBytes?:number}} opts tail 取末尾若干行；grep 为子串过滤（先过滤再取尾）
 * @returns {{ok:boolean, day:string, path:string, exists:boolean, size:number, total:number, lines:string[], text:string}}
 */
function readDay(day, opts) {
  const o = opts || {};
  const d = /^\d{4}-\d{2}-\d{2}$/.test(String(day || '')) ? String(day) : dayOf(new Date());
  const full = fileOf(d);
  const base = { ok: true, day: d, path: full, exists: false, size: 0, total: 0, lines: [], text: '' };
  if (!logDir) return Object.assign(base, { ok: false, error: '日志目录不可用' });
  let size = 0;
  try { if (!fs.existsSync(full)) return base; size = fs.statSync(full).size; } catch (e) { return base; }
  const maxRead = Math.max(64 * 1024, Number(o.maxBytes) || 4 * 1024 * 1024);
  let text = '';
  try {
    const fd = fs.openSync(full, 'r');
    const start = size > maxRead ? size - maxRead : 0;
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    text = buf.toString('utf8');
    if (start > 0) text = text.slice(text.indexOf('\n') + 1);   // 丢掉被截断的首行
  } catch (e) { return Object.assign(base, { ok: false, error: String(e && e.message || e) }); }
  let lines = text.split(/\r?\n/).filter(Boolean);
  const total = lines.length;
  const grep = String(o.grep || '').trim();
  if (grep) lines = lines.filter((l) => l.indexOf(grep) >= 0);
  const tail = parseInt(o.tail, 10);
  if (tail > 0 && lines.length > tail) lines = lines.slice(lines.length - tail);
  return { ok: true, day: d, path: full, exists: true, size, total, lines, text: lines.join('\n') };
}

module.exports = { init, getDir, listDays, listErrorDays, readDay, logEvent, logEventSync, sys, run, del, add, mod, cfg, ipc, err, ui, humanSize, describeFiles,
  pruneOld, close, scrub, briefArgs, chEvent, isSilentChannel, isErrorish, KEEP_DAYS, ERROR_KEEP_DAYS };
