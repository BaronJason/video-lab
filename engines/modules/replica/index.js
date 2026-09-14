// engines/modules/replica/index.js —— 日志复刻（迁移自 video_replica.ps1，行为等价优先）
// 模式1=原片复刻 / 模式2=去重复刻（尾部替换 + 渐进压时长）
// 硬约束：片段以「文件名」为身份（同名即同一片段，成片内不得重复）；缺失片段三路修复，
//         任一缺失且修复失败 → 该成片不生成；成片内重复最终校验；GPU 编码 h264_nvenc。
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { runFfmpeg } = require('../../base/ffmpeg');
const { probe } = require('../../base/probe');
const { acquireLock } = require('../../base/lock');
const { stripQuotes, getNumberSuffix, exists } = require('../../base/paths');
const dedupe = require('../../base/dedupe');

const VIDEO_EXT_RE = /\.(mp4|mov|avi|mkv|m4v)$/i;
const PATH_LIKE_RE = /^[A-Za-z]:\\|^\\\\/;
const MAX_ATTEMPT = 45;          // 渐进压时长轮数上限（与 PS1 一致）
// video_cache.json 由 PowerShell 以 $fileInfo.LastWriteTimeUtc.Ticks 写入，
// 即 .NET DateTime.Ticks（0001-01-01 基准），故偏移取 621355968000000000；
// 注意不要与 FILETIME（1601 基准）的 116444736000000000 混淆，否则缓存永不命中。
const DOTNET_TICKS_OFFSET = 621355968000000000;

// ────────────────────────────── env ──────────────────────────────
function readEnv(env = process.env) {
  const n = (k, d = '') => (env[k] == null ? d : String(env[k]));
  const num = (k, d) => { const v = parseFloat(n(k)); return Number.isNaN(v) ? d : v; };
  return {
    txt: n('REPLICA_TXT'),
    mode: n('REPLICA_MODE'),                       // '1' | '2'（由应用注入）
    maxDuration: num('REPLICA_MAX_DURATION', 179),
    speedLimit: num('REPLICA_SPEED_LIMIT', 1.2),
    dedupRatio: num('REPLICA_DEDUP_RATIO', 0.4),
    outputDir: n('REPLICA_OUTPUT_DIR'),
    cacheDir: n('VL_CACHE_DIR'),
    fallbackDir: n('REPLICA_FALLBACK_DIR'),
    onlyNames: n('REPLICA_ONLY_NAMES'),
    onlyName: n('REPLICA_ONLY_NAME'),
    submitTs: parseInt(n('REPLICA_SUBMIT_TS', '0'), 10) || 0,
  };
}

/** 任务日期：提交时刻优先（跨天不回退实际运行日期） */
function taskDate(submitTs) { return submitTs > 0 ? new Date(submitTs) : new Date(); }
function pad(n) { return String(n).padStart(2, '0'); }
/** PS 的 [math]::Round(v, 2) 且去尾随零（164.8 而非 164.80） */
function round2(v) { return Math.round(Number(v) * 100) / 100; }
function round1(v) { return Math.round(Number(v) * 10) / 10; }

// ──────────────────── video_cache（只读；PS 亦为只读不写回） ────────────────────
/** JS 文件时间 → .NET DateTime.Ticks（与 PS 的 $fileInfo.LastWriteTimeUtc.Ticks 同语义）
 *  用 statSync 的 bigint mtimeNs（100ns 精度，与 Ticks 同单位）换算，避免 mtimeMs 的毫秒精度损失。
 *  返回值经 Number() 转换会引入约 ±128 ticks 误差，故比较处使用 TICKS_TOLERANCE 容差。 */
function mtimeToTicks(p) {
  try {
    const st = fs.statSync(p, { bigint: true });
    return Number(st.mtimeNs / 100n) + DOTNET_TICKS_OFFSET;
  } catch (e) {
    try { return Math.floor(fs.statSync(p).mtimeMs * 10000) + DOTNET_TICKS_OFFSET; } catch (e2) { return 0; }
  }
}
/** 缓存时间戳比较容差（1ms = 10000 ticks）：吸收 JSON double 精度（±128）与文件系统精度差异 */
const TICKS_TOLERANCE = 10000;

function loadVideoCache(cacheDir) {
  if (!cacheDir) return {};
  const f = path.join(cacheDir, 'video_cache.json');
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return {}; }
}

/** Get-CachedVideoInfo（防御版）：命中缓存用缓存，否则 ffprobe */
function makeVideoInfo(cache) {
  const mem = new Map();
  return async function videoInfo(p) {
    if (!p) return { valid: false, duration: 0, width: 0, height: 0, lastWriteTicks: 0 };
    if (mem.has(p)) return mem.get(p);
    let st = null;
    try { st = fs.statSync(p); } catch (e) { st = null; }
    if (!st) {
      const r = { valid: false, duration: 0, width: 0, height: 0, lastWriteTicks: 0 };
      mem.set(p, r);
      return r;
    }
    const ticks = mtimeToTicks(p);
    const cached = cache[p];
    if (cached && Math.abs(Number(cached.LastWriteTime) - ticks) <= TICKS_TOLERANCE) {
      const r = { valid: !!cached.Valid, duration: cached.Duration || 0, width: cached.Width || 0, height: cached.Height || 0, lastWriteTicks: ticks };
      mem.set(p, r);
      return r;
    }
    const info = await probe(p);
    const r = { valid: !!info.valid, duration: info.duration || 0, width: info.width || 0, height: info.height || 0, lastWriteTicks: ticks };
    mem.set(p, r);
    return r;
  };
}

// ───────────────────────── 日志解析（ConvertTo-ReplicaJobs） ─────────────────────────
function parseJobs(allLines) {
  const jobs = [];
  let current = null;
  for (let i = 0; i < allLines.length; i++) {
    const line = String(allLines[i] == null ? '' : allLines[i]).trim();
    if (/使用片段列表：/.test(line)) {
      if (current) jobs.push(current);
      const nameLine = i > 0 ? String(allLines[i - 1] == null ? '' : allLines[i - 1]).trim() : '';
      let name = nameLine;
      const m = /第\s*\d+\s*个成片\s*[：:]\s*(.+?)\s*$/.exec(name);
      if (m) name = m[1].trim().replace(/^=+|=+$/g, '').trim();
      if (PATH_LIKE_RE.test(name)) name = path.basename(name);
      current = { name, videos: [], watermark: '', missingReplacedIndices: [], missingEquivalentIndices: [] };
      continue;
    }
    if (current) {
      const p = stripQuotes(line);
      if (PATH_LIKE_RE.test(p)) {
        if (/\.png$/i.test(p)) current.watermark = p;
        else if (VIDEO_EXT_RE.test(p)) current.videos.push(p);
      }
    }
  }
  if (current) jobs.push(current);
  return jobs;
}

// ───────────────────────── 候选与替换（Select-ReplacementVideo） ─────────────────────────
function sameDirCandidates(videoPath) {
  const dir = path.dirname(videoPath);
  let ok = false; try { ok = fs.statSync(dir).isDirectory(); } catch (e) { ok = false; }
  if (!ok) return [];
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return []; }
  const out = [];
  for (const ent of entries) {
    if (!ent.isFile()) continue;
    const full = path.join(dir, ent.name);
    if (!VIDEO_EXT_RE.test(ent.name)) continue;
    if (full === videoPath) continue;
    if (/\\旧水印\\/i.test(full) || /旧水印/.test(ent.name)) continue;
    out.push(full);
  }
  return out;
}

function recursiveVideos(dir) {
  let ok = false; try { ok = fs.statSync(dir).isDirectory(); } catch (e) { ok = false; }
  if (!ok) return [];
  const out = [];
  const walk = (d) => {
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
    for (const ent of entries) {
      const full = path.join(d, ent.name);
      if (ent.isDirectory()) { walk(full); continue; }
      if (!VIDEO_EXT_RE.test(ent.name)) continue;
      if (/旧水印/.test(ent.name)) continue;
      out.push(full);
    }
  };
  walk(dir);
  return out;
}

/** 排序键：invalid 排后，其次时长升序（对齐 PS 的 Sort-Object {Valid -eq $false}, {Duration}） */
async function sortByValidThenDuration(list, info) {
  const decorated = [];
  for (const p of list) {
    const i = await info(p);
    decorated.push({ p, invalid: i.valid ? 0 : 1, dur: i.duration || 0 });
  }
  decorated.sort((a, b) => (a.invalid - b.invalid) || (a.dur - b.dur));
  return decorated.map((d) => d.p);
}

/**
 * 选替换候选：返回 { path, equivalent } 或 { path: null }
 * - exclude     完整路径排除（triedSubs / 成片内其它位置）
 * - excludeNames 文件名排除（同名即同一片段，成片内不得重复）
 * - shorterThan >0 时只接受严格更短的候选（无更短 → 返回空，由调用方标记该段耗尽）
 */
async function selectReplacementVideo({ originalPath, exclude = [], preferShort = false, shorterThan = 0, excludeNames = [], info }) {
  const excludeSet = new Set(exclude);
  const nameSet = new Set(excludeNames);
  let cands = sameDirCandidates(originalPath).filter((p) => !excludeSet.has(p) && !nameSet.has(path.basename(p)));
  if (shorterThan > 0) {
    const keep = [];
    for (const c of cands) { const i = await info(c); if ((i.duration || 0) < shorterThan) keep.push(c); }
    cands = keep;
  }
  if (!cands.length) return { path: null, equivalent: false };

  const origSuffix = getNumberSuffix(originalPath);
  const sameSuffix = origSuffix ? cands.filter((c) => getNumberSuffix(c) === origSuffix) : [];
  const others = cands.filter((c) => !sameSuffix.includes(c));

  if (preferShort) {
    if (sameSuffix.length) { const s = await sortByValidThenDuration(sameSuffix, info); return { path: s[0], equivalent: true }; }
    if (others.length) { const s = await sortByValidThenDuration(others, info); return { path: s[0], equivalent: false }; }
    return { path: null, equivalent: false };
  }
  if (sameSuffix.length) return { path: sameSuffix[Math.floor(Math.random() * sameSuffix.length)], equivalent: true };
  if (others.length) return { path: others[Math.floor(Math.random() * others.length)], equivalent: false };
  return { path: null, equivalent: false };
}

/** 备用目录候选（Get-VideoFromDirectory：递归、同后缀优先） */
async function videoFromDirectory({ directory, originalPath = '', exclude = [], excludeNames = [] }) {
  let ok = false; try { ok = fs.statSync(directory).isDirectory(); } catch (e) { ok = false; }
  if (!ok) return { path: null, equivalent: false };
  const excludeSet = new Set(exclude);
  const nameSet = new Set(excludeNames);
  const vids = recursiveVideos(directory).filter((p) => !excludeSet.has(p) && !nameSet.has(path.basename(p)));
  if (!vids.length) return { path: null, equivalent: false };
  const origSuffix = originalPath ? getNumberSuffix(originalPath) : '';
  const sameSuffix = origSuffix ? vids.filter((v) => getNumberSuffix(v) === origSuffix) : [];
  const others = vids.filter((v) => !sameSuffix.includes(v));
  if (sameSuffix.length) return { path: sameSuffix[Math.floor(Math.random() * sameSuffix.length)], equivalent: true };
  if (others.length) return { path: others[Math.floor(Math.random() * others.length)], equivalent: false };
  return { path: null, equivalent: false };
}

// ─────────────────── 缺失修复（Resolve-FromVideoCache：缓存按文件名反查） ───────────────────
function buildCacheByNameIndex(cache) {
  const idx = new Map();
  for (const p of Object.keys(cache || {})) {
    if (!p) continue;
    const fn = path.basename(p);
    if (!fn) continue;
    const key = fn.toLowerCase();
    if (!idx.has(key)) idx.set(key, []);
    idx.get(key).push(p);
  }
  return idx;
}

/**
 * 三路修复的第一路（PS 的首选）：缓存按文件名反查。
 * - exclude      完整路径排除（成片内其它位置）
 * - excludeNames 文件名排除：同名副本即同一片段，成片内已用则本位置不可再用
 */
function resolveFromVideoCache(oldPath, { exclude = [], excludeNames = [], index }) {
  let p = stripQuotes(oldPath).replace(/\\\\/g, '\\');
  if (!p) return null;
  const leaf = path.basename(p);
  const fnKey = leaf.toLowerCase();
  const origDir = path.dirname(p);
  const nameSet = new Set(excludeNames);
  if (nameSet.has(leaf)) return null;
  const excludeSet = new Set(exclude);
  const list = index.get(fnKey) || [];
  let cands = Array.from(new Set(list)).filter((c) => exists(c) && !excludeSet.has(c));
  if (cands.length) {
    const sameDir = cands.filter((c) => path.dirname(c).toLowerCase() === origDir.toLowerCase());
    return sameDir.length ? sameDir[0] : cands[0];
  }
  // 无同名：同目录下相同数字后缀（原索引补位逻辑）
  const suffix = getNumberSuffix(p);
  let dirOk = false; try { dirOk = fs.statSync(origDir).isDirectory(); } catch (e) { dirOk = false; }
  if (suffix && dirOk) {
    let entries = [];
    try { entries = fs.readdirSync(origDir, { withFileTypes: true }); } catch (e) { entries = []; }
    const sameSeq = entries
      .filter((e) => e.isFile() && VIDEO_EXT_RE.test(e.name))
      .map((e) => path.join(origDir, e.name))
      .filter((f) => f.toLowerCase() !== p.toLowerCase() && !excludeSet.has(f) && getNumberSuffix(f) === suffix)
      .sort((a, b) => a.localeCompare(b));
    if (sameSeq.length) return sameSeq[0];
  }
  return null;
}

// ─────────────────── 模式2：尾部替换（Select-VariancePaths） ───────────────────
async function selectVariancePaths({
  originalPaths, alreadyChangedIndices = [], alreadyEquivalentIndices = [],
  triedSubs = new Map(), preferShort = false, dedupRatio, info, logger,
}) {
  const origDurations = [];
  let totalOrig = 0;
  for (const p of originalPaths) { const i = await info(p); origDurations.push(i.duration || 0); totalOrig += i.duration || 0; }
  if (totalOrig <= 0 || originalPaths.length === 0) return { paths: originalPaths.slice(), triedSubs };

  const changedSet = new Set(alreadyChangedIndices);
  const equivalentSet = new Set(alreadyEquivalentIndices);
  let alreadyChangedDur = 0;
  for (const idx of alreadyChangedIndices) if (idx >= 0 && idx < origDurations.length) alreadyChangedDur += origDurations[idx];
  if (alreadyChangedDur / totalOrig >= dedupRatio) {
    logger.info(`🔀 模式2：缺失替换片段已占 ${round1(alreadyChangedDur / totalOrig * 100)}%，无需再替换尾部`);
    return { paths: originalPaths.slice(), triedSubs };
  }

  const newPaths = originalPaths.slice();
  let trulyChangedDur = alreadyChangedDur;
  let actuallyReplaced = 0;
  let equivalentReplaced = 0;
  const replaceDetails = [];
  const equivalentDetails = [];

  for (let i = originalPaths.length - 1; i >= 0; i--) {
    if (trulyChangedDur / totalOrig >= dedupRatio) break;
    if (changedSet.has(i) || equivalentSet.has(i)) continue;
    const origKey = String(originalPaths[i]);
    const excludeSubs = [];
    for (const k of triedSubs.keys()) if (k.startsWith(origKey + '|')) excludeSubs.push(k.slice(origKey.length + 1));
    // 成片内不得出现相同片段：按文件名 + 完整路径双重排除该成片其它位置
    const usedNames = [];
    for (let k = 0; k < newPaths.length; k++) if (k !== i && newPaths[k]) usedNames.push(path.basename(newPaths[k]));
    const excludeAll = excludeSubs.concat(newPaths.filter((p) => p && p !== originalPaths[i]));

    const sel = await selectReplacementVideo({
      originalPath: originalPaths[i], exclude: excludeAll, excludeNames: usedNames, preferShort, info,
    });
    if (!sel.path) continue;
    newPaths[i] = sel.path;
    if (sel.equivalent) {
      equivalentReplaced++;
      equivalentDetails.push(`    第 ${i + 1} 段: ${path.basename(originalPaths[i])} -> ${path.basename(sel.path)}（等效，不进入30%）`);
    } else {
      actuallyReplaced++;
      changedSet.add(i);
      trulyChangedDur += origDurations[i];
      replaceDetails.push(`    第 ${i + 1} 段: ${path.basename(originalPaths[i])} -> ${path.basename(sel.path)}`);
    }
  }

  if (actuallyReplaced === 0 && equivalentReplaced === 0 && alreadyChangedDur / totalOrig < dedupRatio) {
    logger.warn('模式2：没有可替换的尾部片段，本次仅保留已随机替换的片段');
    return { paths: newPaths, triedSubs };
  }
  logger.info(`🔀 模式2：尾部新增替换 ${actuallyReplaced} 段（等效替换 ${equivalentReplaced} 段；合计不一致时长占比 ${round1(trulyChangedDur / totalOrig * 100)}%）`);
  for (const d of equivalentDetails) logger.info(d);
  for (const d of replaceDetails) logger.info(d);
  return { paths: newPaths, triedSubs };
}

// ────────────────────────────── 主流程 ──────────────────────────────
async function run(ctx, env = process.env) {
  const { logger } = ctx;
  const cfg = readEnv(env);
  const fail = (msg, step) => { logger.error(step, msg); return 1; };

  // ── 输入 TXT ──
  if (!cfg.txt) return fail('未通过环境变量 REPLICA_TXT 提供日志 TXT 文件（脚本由 Video Lab 驱动，不再支持手动输入）', '日志TXT输入');
  let txtPath = stripQuotes(cfg.txt);
  if (!exists(txtPath)) return fail('未通过环境变量 REPLICA_TXT 提供日志 TXT 文件（脚本由 Video Lab 驱动，不再支持手动输入）', '日志TXT输入');
  logger.info(`✅ 已通过 REPLICA_TXT 指定TXT文件: ${path.basename(txtPath)}`);

  // ── 输出根目录：REPLICA_OUTPUT_DIR 优先，否则由 TXT 路径推导 ──
  const txtDir = path.dirname(txtPath);
  const parts = txtDir.split('\\');
  let dateDirIndex = -1;
  for (let i = 0; i < parts.length; i++) {
    if (/^\d+月$/.test(parts[i]) || /^\d{4}$/.test(parts[i])) { dateDirIndex = i; break; }
  }
  let baseDir;
  if (dateDirIndex > 0) baseDir = parts.slice(0, dateDirIndex).join('\\');
  else if (dateDirIndex === 0) baseDir = parts[0];
  else baseDir = txtDir;

  const d0 = taskDate(cfg.submitTs);
  // 打印的是「由 TXT 路径推导」的输出目录（与 PS1 主入口一致）；
  // REPLICA_OUTPUT_DIR 的覆盖只作用于实际写入，见下方 outRootBase（PS1 在 Invoke-ReplicaFromLog 内覆盖）
  const derivedRoot = path.join(baseDir, `${d0.getMonth() + 1}月`, `${pad(d0.getMonth() + 1)}${pad(d0.getDate())}`);
  logger.info('');
  logger.info(`✅ 输出目录：${derivedRoot}`);

  // ── 读日志并解析 ──
  let allLines = [];
  try {
    allLines = fs.readFileSync(txtPath, 'utf8').split(/\r?\n/).map((s) => s.trim()).filter((s) => /\S/.test(s));
  } catch (e) {
    return fail(`读取日志 TXT 失败：${e.message}`, '日志TXT输入');
  }
  if (!/使用片段列表：/.test(allLines.join('\n'))) return fail('不是日志格式TXT，请使用视频复刻日志文件', '日志TXT输入');

  let jobs = parseJobs(allLines);
  if (jobs.length === 0) return fail('未从日志中解析出任何成片', '日志复刻-解析');

  // ── 仅复刻指定成片 ──
  const onlyRaw = cfg.onlyNames || cfg.onlyName || '';
  if (onlyRaw.trim()) {
    const onlyNames = onlyRaw.split(';').map((s) => s.trim()).filter(Boolean);
    jobs = jobs.filter((j) => onlyNames.some((o) => j.name === o || j.name === o + '.mp4' || path.basename(j.name, path.extname(j.name)) === path.basename(o, path.extname(o))));
    if (jobs.length === 0) return fail(`未找到指定成片：${onlyNames.join('、')}`, '日志复刻-单成片');
  }

  // ── 重复成片名检测 ──
  const nameCount = new Map();
  for (const j of jobs) nameCount.set(j.name, (nameCount.get(j.name) || 0) + 1);
  const dupJobNames = [...nameCount.entries()].filter(([, c]) => c > 1);
  if (dupJobNames.length) {
    logger.info('❌ 检测到重复成片名：');
    for (const [n, c] of dupJobNames) logger.info(`   ${n} 出现 ${c} 次`);
    return fail('存在重复成片名，已停止', '日志复刻-重复检测');
  }

  // ── 视频信息缓存（只读 video_cache.json） ──
  const cache = loadVideoCache(cfg.cacheDir);
  const cacheByName = buildCacheByNameIndex(cache);
  const info = makeVideoInfo(cache);

  // ── 缺失片段修复（三路） ──
  const missingAll = [];
  for (const job of jobs) {
    for (let i = 0; i < job.videos.length; i++) {
      if (!exists(job.videos[i])) missingAll.push({ job, index: i, p: job.videos[i] });
    }
  }
  if (missingAll.length > 0) {
    logger.info('');
    logger.info(`⚠️  检测到 ${missingAll.length} 个片段不存在，需要修复：`);
    for (const m of missingAll) logger.info(`   [${m.job.name}] ${path.basename(m.p)}`);
    const unfixable = new Map();

    for (const m of missingAll) {
      const job = m.job;
      const orig = m.p;
      let newPath = null;
      let isEquivalent = false;
      const otherInJob = job.videos.filter((v) => v && v !== orig);
      const otherNames = otherInJob.map((v) => path.basename(v));

      // 首选：缓存按文件名反查
      newPath = resolveFromVideoCache(orig, { exclude: otherInJob, excludeNames: otherNames, index: cacheByName });
      if (newPath && otherInJob.includes(newPath)) {
        logger.info(`   ⚠️ 缓存命中与本成片其它片段重复，改用其它候选：${path.basename(newPath)}`);
        newPath = null;
      }
      if (newPath) {
        isEquivalent = true;
        logger.info(`   🔎 缓存命中：${path.basename(orig)} -> ${path.basename(newPath)}（等效，不进入30%）`);
      }
      // 其次：同目录优先相同数字后缀，否则随机
      if (!newPath) {
        const sel = await selectReplacementVideo({ originalPath: orig, exclude: otherInJob, excludeNames: otherNames, info });
        newPath = sel.path; isEquivalent = sel.equivalent;
      }
      // 再试：全局备用目录
      if (!newPath && cfg.fallbackDir) {
        const sel = await videoFromDirectory({ directory: cfg.fallbackDir, originalPath: orig, exclude: otherInJob, excludeNames: otherNames });
        newPath = sel.path; isEquivalent = sel.equivalent;
      }

      if (!newPath || !exists(newPath)) {
        if (!newPath) {
          logger.info(`   ❌ 无法自动修复：${orig}`);
          logger.info('      索引/同目录/备用目录均无可替换视频，请将对应视频放回原路径，或设置 REPLICA_FALLBACK_DIR 备用目录后重跑');
        } else {
          logger.info(`   ❌ 替换候选已失效：${orig} -> ${newPath}`);
          newPath = null;
        }
        unfixable.set(job.name, `片段缺失且无法自动修复：${path.basename(orig)}`);
        continue;
      }
      job.videos[m.index] = newPath;
      if (isEquivalent) job.missingEquivalentIndices.push(m.index);
      else job.missingReplacedIndices.push(m.index);
      if (newPath !== orig) logger.info(`   ✅ [${job.name}] ${path.basename(orig)} -> ${path.basename(newPath)}`);
    }

    if (unfixable.size > 0) {
      jobs = jobs.filter((j) => !unfixable.has(j.name));
      for (const [badName, reason] of unfixable) {
        logger.info(`   ⏭️  跳过无法复刻的成片：${badName}（${reason}）`);
        logger.fail(badName, reason);
      }
      if (jobs.length === 0) return fail('所有成片均因片段缺失无法复刻', '日志复刻-缺失片段处理');
    }
  }

  // ── 模式与输出目录 ──
  let mode = 0;
  if (cfg.mode === '1') mode = 1;
  else if (cfg.mode === '2') mode = 2;
  else return fail('未通过环境变量 REPLICA_MODE 指定复刻模式（脚本由 Video Lab 驱动）', '复刻模式');
  const modeName = mode === 1 ? '原片复刻' : '去重复刻';
  const outRoot = path.join(cfg.outputDir || derivedRoot, modeName);
  try { fs.mkdirSync(outRoot, { recursive: true }); } catch (e) {}

  // ── 复刻日志（同日同模式复用同一文件，续写时补分隔线） ──
  const timeTag0 = `${pad(d0.getMonth() + 1)}${pad(d0.getDate())}`;
  const logFilePath = path.join(outRoot, `${timeTag0}-${modeName}日志.txt`);
  try {
    if (!exists(logFilePath)) fs.writeFileSync(logFilePath, '', 'utf8');
    else fs.appendFileSync(logFilePath, '='.repeat(46) + '\r\n', 'utf8');
  } catch (e) {}

  // ── 互斥锁（PS 用 Global\VideoBatchMutex；Node 用文件锁，协议行保持一致） ──
  // 顺序对齐 PS1：先输出锁行，再输出总数行（video_replica.ps1 为「已获取互斥锁」→「开始日志复刻，共 N 个成片」）
  const lock = await acquireLock(path.join(outRoot, '.video-lab-replica.lock'));
  logger.lockAcquired('开始复刻任务');

  logger.info('');
  logger.info(`开始日志复刻，共 ${jobs.length} 个成片`);
  let hasError = false;
  try {
    for (let jobIndex = 0; jobIndex < jobs.length; jobIndex++) {
      const job = jobs[jobIndex];
      logger.info('');
      logger.info('------------------------------------------------');
      logger.info(`复刻第 ${jobIndex + 1} / ${jobs.length} 个成片：${job.name}`);

      let videos = job.videos.slice();
      if (videos.length === 0) {
        logger.error('日志复刻-片段检查', `成片 ${job.name} 没有视频片段`);
        logger.fail(job.name, '没有视频片段');
        hasError = true;
        continue;
      }
      const stillMissing = videos.filter((v) => !exists(v));
      if (stillMissing.length > 0) {
        logger.info(`   ❌ [${job.name}] 仍有 ${stillMissing.length} 个片段无法读取，不生成该成片：${path.basename(stillMissing[0])}`);
        logger.fail(job.name, `片段缺失且无法自动修复：${path.basename(stillMissing[0])}`);
        hasError = true;
        continue;
      }
      if (!job.watermark || !exists(job.watermark)) {
        logger.error('日志复刻-水印检查', `成片 ${job.name} 水印无效：${job.watermark}`);
        logger.fail(job.name, '水印无效');
        hasError = true;
        continue;
      }

      let totalDuration = 0;
      const maxDuration = cfg.maxDuration;
      const speedThreshold = cfg.speedLimit;

      if (mode === 2) {
        // ── 模式2：尾部替换 + 渐进压时长 ──
        let workVideos = job.videos.slice();
        const triedSubs = new Map();
        const exhaustedIdx = new Set();
        let attempt = 0;
        let durOk = false;
        while (attempt === 0 || (!durOk && attempt < MAX_ATTEMPT && exhaustedIdx.size < workVideos.length)) {
          let newVideos = [];
          if (attempt === 0) {
            const r = await selectVariancePaths({
              originalPaths: job.videos,
              alreadyChangedIndices: job.missingReplacedIndices,
              alreadyEquivalentIndices: job.missingEquivalentIndices,
              triedSubs, preferShort: true, dedupRatio: cfg.dedupRatio, info, logger,
            });
            newVideos = r.paths;
          } else {
            let longestIdx = -1;
            let longestDur = -1;
            for (let i = 0; i < workVideos.length; i++) {
              if (exhaustedIdx.has(i)) continue;
              const d = (await info(workVideos[i])).duration || 0;
              if (d > longestDur) { longestDur = d; longestIdx = i; }
            }
            if (longestIdx < 0) { durOk = false; break; }
            const workKey = String(workVideos[longestIdx]);
            const exclude = [];
            for (const k of triedSubs.keys()) if (k.startsWith(workKey + '|')) exclude.push(k.slice(workKey.length + 1));
            const sel = await selectReplacementVideo({
              originalPath: workVideos[longestIdx], exclude, preferShort: true, shorterThan: longestDur, info,
            });
            if (!sel.path) { exhaustedIdx.add(longestIdx); continue; }
            newVideos = workVideos.slice();
            newVideos[longestIdx] = sel.path;
            triedSubs.set(workKey + '|' + sel.path, true);
          }
          totalDuration = 0;
          for (const p of newVideos) totalDuration += (await info(p)).duration || 0;
          if (attempt === 0) {
            for (let i = 0; i < job.videos.length; i++) {
              if (job.videos[i] !== newVideos[i]) triedSubs.set(String(job.videos[i]) + '|' + newVideos[i], true);
            }
          }
          workVideos = newVideos.slice();
          if (totalDuration <= maxDuration * speedThreshold) { durOk = true; break; }
          attempt++;
        }
        videos = workVideos.slice();
        if (!durOk) {
          logger.error('日志复刻-时长检查', `总时长 ${round1(totalDuration)} 秒超过允许阈值（重试45次后仍不达标），请重选片段或调整日志`);
          logger.fail(job.name, `总时长超阈值：${round1(totalDuration)} 秒`);
          hasError = true;
          continue;
        }
        if (attempt > 0) logger.warn(`该成片经 ${attempt} 轮渐进压时长后达标（总时长 ${round1(totalDuration)} 秒）`);
      } else {
        totalDuration = 0;
        for (const p of videos) totalDuration += (await info(p)).duration || 0;
      }

      // ── 成片内重复最终校验（按文件名） ──
      let dupGroups = dedupe.findDuplicates('nameKey', videos);
      if (dupGroups.length > 0) {
        const dupFixed = dupGroups.length;
        logger.warn(`检测到成片内重复片段 ${dupFixed} 组，尝试替换消除…`);
        const seenName = new Set();
        for (let vi = 0; vi < videos.length; vi++) {
          if (!videos[vi]) continue;
          const viName = path.basename(videos[vi]);
          if (!seenName.has(viName)) { seenName.add(viName); continue; }
          const viOthers = [];
          for (let k = 0; k < videos.length; k++) if (k !== vi && videos[k]) viOthers.push(path.basename(videos[k]));
          const excludeDup = videos.filter((v) => v && v !== videos[vi]);
          const selDup = await selectReplacementVideo({ originalPath: videos[vi], exclude: excludeDup, excludeNames: viOthers, info });
          if (selDup.path && exists(selDup.path)) {
            logger.info(`     第 ${vi + 1} 段: ${viName} -> ${path.basename(selDup.path)}`);
            videos[vi] = selDup.path;
          }
        }
        dupGroups = dedupe.findDuplicates('nameKey', videos);
        if (dupGroups.length > 0) {
          const dupNames = dupGroups.map((g) => path.basename(g[0])).join('、');
          logger.error('日志复刻-重复片段检查', `成片内存在重复片段：${dupNames}`);
          logger.fail(job.name, `成片内存在重复片段：${dupNames}`);
          hasError = true;
          continue;
        }
        logger.info(`   ✅ 已替换消除 ${dupFixed} 组重复片段`);
        totalDuration = 0;
        for (const p of videos) totalDuration += (await info(p)).duration || 0;
      }

      // ── 时长与加速 ──
      let needSpeed = false;
      let speedRatio = 1.0;
      if (totalDuration > maxDuration && totalDuration <= maxDuration * speedThreshold) {
        needSpeed = true;
        speedRatio = totalDuration / maxDuration;
        if (speedRatio > 2.0) speedRatio = 2.0;
        logger.warn(`总时长 ${totalDuration} 秒超设定，将加速 ${Math.round(speedRatio * 1000) / 1000}x`);
      } else if (totalDuration > maxDuration * speedThreshold) {
        logger.error('日志复刻-时长检查', `总时长 ${totalDuration} 秒超过允许阈值，请重选片段或调整日志`);
        logger.fail(job.name, `总时长超阈值：${round1(totalDuration)} 秒`);
        hasError = true;
        continue;
      }

      // ── 命名（模式2：yyMMdd改- + 同日序号化） ──
      let outName = job.name;
      if (mode === 2) {
        const dayPrefix = `${String(d0.getFullYear()).slice(2)}${pad(d0.getMonth() + 1)}${pad(d0.getDate())}改`;
        const baseStem = job.name.replace(/\.mp4$/, '');
        const re = new RegExp('^' + escapeRegExp(dayPrefix) + '(\\d*)-' + escapeRegExp(baseStem) + '$');
        let hits = [];
        try {
          hits = fs.readdirSync(outRoot).filter((f) => f.toLowerCase().endsWith('.mp4'))
            .map((f) => path.basename(f, path.extname(f)))
            .filter((b) => re.test(b));
        } catch (e) { hits = []; }
        if (hits.length === 0) {
          outName = dayPrefix + '-' + outName;
        } else {
          let maxN = 0;
          for (const h of hits) {
            const m = re.exec(h);
            if (m && m[1] !== '') { const n = parseInt(m[1], 10); if (n > maxN) maxN = n; }
          }
          outName = dayPrefix + (maxN + 1) + '-' + outName;
        }
      }
      let finalOut = path.join(outRoot, outName);
      if (path.extname(finalOut) === '') finalOut += '.mp4';

      // ── 拼接 + 水印 + 编码（GPU 硬约束） ──
      const n = videos.length;
      if (n === 0) {
        logger.error('日志复刻-片段数检查', '无有效视频片段');
        logger.fail(job.name, '无有效视频片段');
        hasError = true;
        continue;
      }
      const inputArgs = [];
      for (const p of videos) inputArgs.push('-i', p);
      inputArgs.push('-i', job.watermark);

      let concatInputs = '';
      for (let i = 0; i < n; i++) concatInputs += `[${i}:v][${i}:a]`;
      let filterComplex = `${concatInputs}concat=n=${n}:v=1:a=1[outv][outa];[outv]overlay=0:0[wateredv]`;
      let mapV, mapA;
      if (needSpeed) {
        filterComplex += `;[wateredv]setpts=PTS/(${speedRatio})[v];[outa]atempo=${speedRatio}[a]`;
        mapV = '[v]'; mapA = '[a]';
      } else {
        mapV = '[wateredv]'; mapA = '[outa]';
      }
      const encArgs = [
        '-filter_complex', filterComplex,
        '-map', mapV, '-map', mapA,
        '-c:v', 'h264_nvenc', '-preset', 'p4', '-rc', 'vbr', '-cq', '27',
        '-profile:v', 'high', '-level', '4.1',
        '-c:a', 'aac', '-b:a', '192k',
        '-y', finalOut,
      ];
      const targetDur = totalDuration > maxDuration ? maxDuration : totalDuration;
      logger.clipDuration(round2(targetDur));
      const { code } = await runFfmpeg(inputArgs.concat(encArgs), { onProgress: (line) => logger.raw(line) });
      if (code !== 0) {
        logger.error('日志复刻-编码', `编码失败：${job.name}`);
        logger.fail(job.name, 'ffmpeg 编码失败');
        hasError = true;
        continue;
      }
      logger.clipDone(finalOut);

      // ── 写复刻日志 ──
      try {
        const lines = [path.basename(finalOut), '使用片段列表：', ...videos, '', job.watermark];
        if (jobIndex < jobs.length - 1) lines.push('='.repeat(46));
        fs.appendFileSync(logFilePath, lines.join('\r\n') + '\r\n', 'utf8');
      } catch (e) {}
    }
  } finally {
    try { lock.release(); } catch (e) {}
    logger.lockReleased();
  }

  if (hasError) { logger.info(''); logger.info('脚本执行完成（有错误）'); return 1; }
  logger.info('');
  logger.info('脚本完成');
  return 0;
}

function escapeRegExp(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

module.exports = {
  id: 'replica',
  title: '复刻',
  envVars: ['REPLICA_*', 'VL_CACHE_DIR'],
  legacyScript: 'video_replica.ps1',
  run,
  // 供测试与 P4 复用
  _internals: {
    readEnv, taskDate, parseJobs, sameDirCandidates, selectReplacementVideo, videoFromDirectory,
    buildCacheByNameIndex, resolveFromVideoCache, selectVariancePaths, mtimeToTicks, round1, round2,
  },
};
