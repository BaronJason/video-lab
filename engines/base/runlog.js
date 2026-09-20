// 运行日志（面向排查，保留 7 天）：%APPDATA%\Video Lab\log\app-YYYY-MM-DD.log
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

let logDir = '';
let stream = null;
let streamDay = '';

/** 指定日志目录（调用方给出 storageDir\..\log 或 storageDir\log） */
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

function ensureStream() {
  if (!logDir) return null;
  const day = dayOf(new Date());
  if (stream && streamDay === day) return stream;
  if (stream) { try { stream.end(); } catch (e) {} stream = null; }
  try {
    stream = fs.createWriteStream(fileOf(day), { flags: 'a' });
    stream.on('error', () => { stream = null; });   // 写失败不得影响主流程
    streamDay = day;
  } catch (e) { stream = null; }
  return stream;
}

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

/**
 * 写一条事件。
 * @param {string} verb    SYS/RUN/DEL/ADD/MOD/ERR/IPC/CFG
 * @param {string} action  点分动作名，如 task.artifacts.remove
 * @param {string} summary 中文一句话摘要（含关键数字），可为空
 * @param {object} [data]  结构化细节
 */
function logEvent(verb, action, summary, data) {
  try {
    const ws = ensureStream();
    if (!ws) return;
    const s = scrub(String(summary || '').replace(/\s*\n\s*/g, ' '));
    const d = briefData(data);
    const head = stampOf(new Date()) + '  ' + String(verb || 'SYS').padEnd(3) + '  ' + String(action || '-').padEnd(26);
    ws.write(head + (s ? '  ' + s : '') + (d ? '  · ' + d : '') + '\n');
  } catch (e) { /* 静默 */ }
}

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
function pruneOld(keepDays = KEEP_DAYS) {
  if (!logDir) return { removed: 0 };
  try {
    const cutoff = Date.now() - keepDays * 24 * 3600 * 1000;
    let removed = 0;
    for (const f of fs.readdirSync(logDir)) {
      const m = /^app-(\d{4})-(\d{2})-(\d{2})\.log$/.exec(f);
      if (!m) continue;
      const t = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
      if (t < cutoff) { try { fs.unlinkSync(path.join(logDir, f)); removed++; } catch (e) {} }
    }
    return { removed };
  } catch (e) { return { removed: 0 }; }
}

function close() {
  try { if (stream) stream.end(); } catch (e) {}
  stream = null; streamDay = '';
}

module.exports = { init, logEvent, sys, run, del, add, mod, cfg, ipc, err, humanSize, describeFiles, pruneOld, close, scrub, KEEP_DAYS };
