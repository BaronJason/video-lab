// engines/modules/batch/index.js —— 批量拼接（迁移自 video_batch.ps1，行为等价优先）
// 解析 TXT 配置 → 扫描素材（含 .lnk 展开、索引自动修复、1080×1920 合规过滤）→ 选片状态机
// （Round/RoundUsed/SubRound/SubUsedInRound/SubUsageCount）→ 渐进替换重试 → ffmpeg 拼接 → 命名/分组/日志。
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runFfmpeg } = require('../../base/ffmpeg');
const { probe } = require('../../base/probe');
const { acquireLock } = require('../../base/lock');
const { stripQuotes, exists, sortKey } = require('../../base/paths');
const { pickCandidate, pickRandom, failKey, triedPathsFor } = require('../../base/retry');

// 缓存作用域位掩码（与 engines/base/cache.js 的 SCOPES 同源，惰性取用：
// 持久层不可用时不应影响任务执行，故不在模块顶层 require）。
const SCOPES_FALLBACK = { batch: 1, replica: 2, mask: 4 };
let _scopesCache = null;
function scopes() {
  if (!_scopesCache) {
    try { _scopesCache = require('../../base/cache').SCOPES || SCOPES_FALLBACK; }
    catch (e) { _scopesCache = SCOPES_FALLBACK; }
  }
  return _scopesCache;
}

const VIDEO_EXTS = ['.mp4', '.mov', '.avi', '.mkv', '.m4v'];
const VIDEO_EXT_SET = new Set(VIDEO_EXTS);
// PS 的 LastWriteTimeUtc.Ticks 是 .NET DateTime.Ticks（0001-01-01 基准），
// 偏移为 621355968000000000（**不是** FILETIME 的 1601 基准 116444736000000000）
const DOTNET_EPOCH_TICKS = 621355968000000000;
const DOTNET_EPOCH_TICKS_BIG = 621355968000000000n;
// Ticks 在 JS Number 下超出 2^53 会丢精度（ulp≈128 ticks）：容差 1ms（10000 ticks）内视为同一时刻
const TICKS_TOLERANCE = 10000;

const isVideoFile = (p) => VIDEO_EXT_SET.has(path.extname(String(p || '')).toLowerCase());

/** 文件最后写入的 .NET Ticks（对齐 PS 的 $fileInfo.LastWriteTimeUtc.Ticks） */
function ticksOf(stat) {
  return stat.mtimeMs * 10000 + DOTNET_EPOCH_TICKS;
}

/**
 * 精确 .NET Ticks（BigInt）。
 * 缓存写回必须与既有条目的 LastWriteTime 精确相等，Number 精度不够；
 * 实测 statSync(p,{bigint:true}).mtimeNs/100n + 偏移与 .NET DateTime.Ticks 计算值逐 tick 一致（差 0）。
 */
function ticksBigOfFile(videoPath) {
  try {
    const st = fs.statSync(videoPath, { bigint: true });
    return st.mtimeNs / 100n + DOTNET_EPOCH_TICKS_BIG;
  } catch (e) {
    return null;
  }
}

/** video_cache 持久层：VL_CACHE_DB 指向的 cache.db，由主进程注入（backend 的 _spawnEngine）。
 *  库未注入或不可用时返回 null，缓存退化为内存态（不影响出片，只是每次重探）。
 *  收益：全量读为库内全表读（数千条约 3ms），写回只落本次新探测的条目而非重写全量。 */
function openVideoStore() {
  const dbPath = String(process.env.VL_CACHE_DB || '').trim();
  if (!dbPath) return null;
  try {
    if (!fs.existsSync(dbPath)) return null;
    const CacheStore = require('../../base/cache');
    const store = new CacheStore(dbPath, { root: '' });
    store.open();
    return store;
  } catch (e) {
    return null; // 库不可用：静默降级，不影响任务
  }
}

// ────────────────────────── .lnk 解析 ──────────────────────────
// 与 backend 共用同一份实现（engines/base/lnk.js）：纯 Node 读二进制解析，替代 COM（WScript.Shell）
const { parseLnkTarget, resolveBrokenTarget } = require('../../base/lnk');

/** 解析快捷方式目标（对齐 Get-ShortcutTarget；失败返回 null 并告警，不中断） */
function getShortcutTarget(lnkPath, log) {
  try {
    const target = String(parseLnkTarget(lnkPath) || '').trim();
    if (target && exists(target)) return target;
    const fixed = resolveBrokenTarget(target, log);
    if (fixed) { log.info(`🔧 快捷方式已智能修复：${lnkPath} -> ${fixed}`); return fixed; }
    log.warn(`快捷方式失效：${lnkPath} 目标无法解析（${target}）`);
    return null;
  } catch (e) {
    log.warn(`解析快捷方式 ${lnkPath} 失败：${e.message}`);
    return null;
  }
}

// ────────────────────────── env 解析 ──────────────────────────
function readEnv(env = process.env) {
  const s = (k, d = '') => (env[k] == null ? d : String(env[k]));
  const num = (k, d) => {
    const v = parseFloat(s(k));
    return Number.isFinite(v) ? v : d;
  };
  const intOrNull = (k) => {
    const v = s(k).trim();
    return /^\d+$/.test(v) ? parseInt(v, 10) : null;
  };
  // 多值文本项：分号分隔（设置页多值输入框存储为数组，经 env 用分号连接传递）
  const list = (k) => String(env[k] == null ? '' : env[k]).split(';').map((x) => x.trim()).filter(Boolean);
  return {
    txt: s('REPLICA_TXT'),
    maxTotalDuration: num('BATCH_MAX_DURATION', 179),
    maxRetry: num('BATCH_MAX_RETRY', 45),
    speedThreshold: num('BATCH_SPEED_LIMIT', 1.2),
    txtNamePrefix: list('BATCH_TXT_PREFIX'),
    producerName: s('BATCH_PRODUCER', '默认'),
    suffixMark: s('BATCH_SUFFIX_MARK'),
    // 续跑过滤：失败成片名（分号分隔）。据此反解序号只重做这些，其余按原始 totalOutput/groupCount 计算
    onlyNames: s('BATCH_ONLY_NAMES'),
    count: intOrNull('BATCH_COUNT'),
    group: intOrNull('BATCH_GROUP'),
    submitTs: parseInt(s('BATCH_SUBMIT_TS', '0'), 10) || 0,
    outputDirOverride: s('REPLICA_OUTPUT_DIR'),
    noWait: s('REPLICA_NO_WAIT') === '1',
  };
}

/** 任务日期：提交时刻优先（跨天不回退实际运行日期） */
function taskDate(submitTs) {
  return submitTs > 0 ? new Date(submitTs) : new Date();
}
const pad = (n) => String(n).padStart(2, '0');

/** MMdd-HH时mm分 */
function timeTag(d) {
  return `${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}时${pad(d.getMinutes())}分`;
}
/** yyMMdd */
function datePrefix(d) {
  return `${String(d.getFullYear()).slice(2)}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
}

// ────────────────────────── 扫描与合规过滤 ──────────────────────────
/** 递归收集视频文件（跳过 .lnk，对齐 Get-VideoFile） */
function collectVideoFiles(rootPath, log) {
  const out = [];
  const walk = (dir) => {
    let items = [];
    try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) {
      log.warn(`遍历文件夹 ${dir} 失败：${e.message}`);
      return;
    }
    for (const it of items) {
      const full = path.join(dir, it.name);
      if (it.isDirectory()) { walk(full); continue; }
      if (isVideoFile(full)) out.push(full);
    }
  };
  walk(rootPath);
  return out;
}

/** 排除规则命中（对齐 Test-ExcludePath：子串、忽略大小写、去尾斜杠） */
function isExcluded(videoFullPath, excludePaths) {
  if (!excludePaths || excludePaths.length === 0) return false;
  const hay = String(videoFullPath).toLowerCase();
  for (const ex of excludePaths) {
    const clean = String(ex == null ? '' : ex).trim().replace(/\\+$/, '');
    if (!clean) continue;
    if (hay.includes(clean.toLowerCase())) return true;
  }
  return false;
}

// ────────────────────────── 索引辅助（批量路径自动修复） ──────────────────────────
function findIndexInTree(startPath) {
  if (!startPath) return '';
  let dir = startPath;
  try { if (!fs.statSync(dir).isDirectory()) dir = path.dirname(dir); } catch (e) { dir = path.dirname(dir); }
  while (dir && dir !== path.dirname(dir)) {
    let cands = [];
    try {
      cands = fs.readdirSync(dir, { withFileTypes: true })
        .filter((e) => !e.isDirectory())
        .filter((e) => /\.tsv$/i.test(e.name) || (/\.txt$/i.test(e.name) && /索引|index/i.test(e.name)))
        .map((e) => {
          const full = path.join(dir, e.name);
          let mt = 0; try { mt = fs.statSync(full).mtimeMs; } catch (e2) { mt = 0; }
          return { full, mt };
        });
    } catch (e) { cands = []; }
    if (cands.length > 0) { cands.sort((a, b) => b.mt - a.mt); return cands[0].full; }
    dir = path.dirname(dir);
  }
  return '';
}

function findIndexFile(hintPath, hintPaths, pscriptRoot) {
  const votes = new Map();
  const all = [hintPath, ...(hintPaths || [])].filter(Boolean);
  for (const hp of all) {
    const found = findIndexInTree(hp);
    if (found) {
      const dir = path.dirname(found);
      votes.set(dir, (votes.get(dir) || 0) + 1);
    }
  }
  if (votes.size > 0) {
    let maxCount = 0;
    for (const v of votes.values()) if (v > maxCount) maxCount = v;
    const topDirs = [...votes.entries()].filter(([, c]) => c === maxCount).map(([d]) => d);
    if (topDirs.length === 1) {
      let best = null;
      try {
        const cands = fs.readdirSync(topDirs[0], { withFileTypes: true })
          .filter((e) => !e.isDirectory())
          .filter((e) => /\.tsv$/i.test(e.name) || (/\.txt$/i.test(e.name) && /索引|index/i.test(e.name)))
          .map((e) => {
            const full = path.join(topDirs[0], e.name);
            let mt = 0; try { mt = fs.statSync(full).mtimeMs; } catch (e2) { mt = 0; }
            return { full, mt };
          });
        cands.sort((a, b) => b.mt - a.mt);
        if (cands.length) best = cands[0].full;
      } catch (e) { best = null; }
      if (best) return best;
    }
  }
  const roots = [...new Set([...all, pscriptRoot].filter(Boolean))];
  for (const r of roots) {
    const found = findIndexInTree(r);
    if (found) return found;
  }
  return '';
}

/** 取文件夹名最后一个 '-' 之后的后缀（无 '-' 返回整名） */
function folderSuffix(folderPath) {
  const name = path.basename(folderPath);
  const idx = name.lastIndexOf('-');
  if (idx >= 0 && idx < name.length - 1) return name.slice(idx + 1);
  return name;
}

/** 载入索引（TSV：跳过首行，取第 3 列作为目录） */
function loadBatchIndex(indexPath) {
  const byDirLeaf = new Map();
  const byDirSuffix = new Map();
  if (!exists(indexPath)) return { byDirLeaf, byDirSuffix, loaded: false };
  let lines = [];
  try { lines = fs.readFileSync(indexPath, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/); } catch (e) { lines = []; }
  for (const line of lines.slice(1)) {
    if (!line) continue;
    const cols = line.split('\t');
    if (cols.length < 3) continue;
    const dir = cols[2];
    const leafKey = path.basename(dir).toLowerCase();
    if (!byDirLeaf.has(leafKey)) byDirLeaf.set(leafKey, []);
    byDirLeaf.get(leafKey).push(dir);
    const sKey = folderSuffix(dir).toLowerCase();
    if (!byDirSuffix.has(sKey)) byDirSuffix.set(sKey, []);
    byDirSuffix.get(sKey).push(dir);
  }
  return { byDirLeaf, byDirSuffix, loaded: true };
}

function resolveFolderFromIndex(index, missingPath) {
  const leaf = path.basename(missingPath);
  if (!leaf) return null;
  const dirs = index.byDirLeaf.get(leaf.toLowerCase());
  if (!dirs) return null;
  for (const d of [...new Set(dirs)]) if (exists(d)) return d;
  return null;
}

function resolveFolderBySuffix(index, missingPath) {
  const suffix = folderSuffix(missingPath);
  if (!suffix) return [];
  const dirs = index.byDirSuffix.get(suffix.toLowerCase());
  if (!dirs) return [];
  return [...new Set(dirs)].filter((d) => exists(d));
}

// ────────────────────────── 选片状态机 ──────────────────────────
// 记录某位置本轮已选片段/子组：配置允许同一路径重复出现，同一成片内相同路径的多个位置
// 必须共用本轮排除集合，否则（沿用片段未登记时）后续位置会选到与前面相同的片段
function registerPickedClip(sourceExcludedPaths, sourceExcludedSubGroups, srcPath, video, plan) {
  if (!video) return;
  if (!sourceExcludedPaths.has(srcPath)) sourceExcludedPaths.set(srcPath, []);
  sourceExcludedPaths.get(srcPath).push(video.fullName);
  if (plan && plan.selectedGroup) {
    if (!sourceExcludedSubGroups.has(srcPath)) sourceExcludedSubGroups.set(srcPath, []);
    sourceExcludedSubGroups.get(srcPath).push(plan.selectedGroup);
  }
}

/**
 * 候选选择（对齐 Select-VideoCandidate）：本轮未用 + 未排除 → 可选「只保留更短」→
 * 使用次数最少的一批 → PreferShort 时取最短的一批随机，否则随机。
 */
function selectVideoCandidate({ fileList, usedCount, roundUsed, exclude, preferShort, shorterThan, getInfo, rng }) {
  const excludeSet = new Set(exclude || []);
  let candidates = fileList.filter((f) => !roundUsed.has(f.fullName) && !excludeSet.has(f.fullName));
  if (shorterThan > 0) {
    candidates = candidates.filter((f) => getInfo(f.fullName).duration < shorterThan);
  }
  if (candidates.length === 0) return null;
  return pickCandidate(candidates, {
    usedCount: (f) => {
      const v = usedCount.get(f.fullName);
      return v == null ? 0 : v;
    },
    preferShort: !!preferShort,
    shorterThan: 0,   // 更短过滤已在上方完成
    durationOf: (f) => getInfo(f.fullName).duration,
    rng,
  });
}

/**
 * 选片（对齐 Select-Video）：返回 { video, plan } 或 null。
 * plan 携带本轮状态推进信息：newRound/newRoundUsed/newSubRound/newSubUsedInRound/selectedGroup/incrementSubUsage
 */
function selectVideo({ srcPath, track, folderData, excludedPaths, excludedSubGroups, preferShort, shorterThan, getInfo, rng }) {
  const plan = {
    folder: srcPath,
    newRound: track.round,
    newRoundUsed: [...track.roundUsed],
    newSubRound: folderData.subRound,
    newSubUsedInRound: [...folderData.subUsedInRound],
    selectedGroup: null,
    incrementSubUsage: null,
  };
  const roundUsedSet = new Set(track.roundUsed);
  const common = { usedCount: track.usedCount, roundUsed: roundUsedSet, exclude: excludedPaths, preferShort, shorterThan, getInfo, rng };

  // ── 单组分支 ──
  if (folderData.subGroupList.length <= 1) {
    let video = selectVideoCandidate({ ...common, fileList: folderData.allVideos });
    if (video) return { video, plan };
    // 候选耗尽：忽略 RoundUsed 重选（状态推进到新轮）
    plan.newRound = track.round + 1;
    plan.newRoundUsed = [];
    video = selectVideoCandidate({ ...common, fileList: folderData.allVideos, roundUsed: new Set() });
    if (video) return { video, plan };
    return null;
  }

  // ── 多子组分支 ──
  let globalUsed = folderData.subUsedInRound;
  const globalUsedSet = new Set(globalUsed);
  const zeroGroups = [];
  for (const group of folderData.subGroupList) {
    if (globalUsedSet.has(group)) continue;
    const files = folderData.subGroups.get(group) || [];
    let hasZeroLeft = false;
    for (const f of files) {
      if (!roundUsedSet.has(f.fullName) && (track.usedCount.get(f.fullName) || 0) === 0) { hasZeroLeft = true; break; }
    }
    if (hasZeroLeft) zeroGroups.push(group);
  }

  let candidateGroups;
  if (zeroGroups.length > 0) candidateGroups = zeroGroups;
  else candidateGroups = folderData.subGroupList.filter((g) => !globalUsedSet.has(g));

  if (candidateGroups.length === 0) {
    plan.newSubRound = folderData.subRound + 1;
    plan.newSubUsedInRound = [];
    candidateGroups = [...folderData.subGroupList];
    globalUsed = [];
  } else {
    plan.newSubRound = folderData.subRound;
    plan.newSubUsedInRound = [...globalUsed];
  }

  const excludedSubSet = new Set(excludedSubGroups || []);
  candidateGroups = candidateGroups.filter((g) => !excludedSubSet.has(g));
  if (candidateGroups.length === 0) {
    candidateGroups = folderData.subGroupList.filter((g) => !globalUsedSet.has(g));
    if (candidateGroups.length === 0) {
      plan.newSubRound = folderData.subRound + 1;
      plan.newSubUsedInRound = [];
      candidateGroups = [...folderData.subGroupList];
    }
  }

  const remaining = [...candidateGroups];
  while (remaining.length > 0) {
    // 取子组使用次数最少的一批，随机选一个子组
    let minCount = Infinity;
    for (const g of remaining) {
      const c = folderData.subUsageCount.get(g) || 0;
      if (c < minCount) minCount = c;
    }
    const bestGroups = remaining.filter((g) => (folderData.subUsageCount.get(g) || 0) === minCount);
    const selectedGroup = pickRandom(bestGroups, rng);
    const files = folderData.subGroups.get(selectedGroup) || [];
    const video = selectVideoCandidate({ ...common, fileList: files });
    if (video) {
      plan.selectedGroup = selectedGroup;
      plan.incrementSubUsage = selectedGroup;
      plan.newSubUsedInRound.push(selectedGroup);
      return { video, plan };
    }
    const idx = remaining.indexOf(selectedGroup);
    if (idx >= 0) remaining.splice(idx, 1);
  }

  // 所有子组都没有候选：仅当本轮已用满全部素材时才推进轮次重选
  if (track.roundUsed.length === folderData.allVideos.length) {
    plan.newRound = track.round + 1;
    plan.newRoundUsed = [];
    plan.newSubRound = folderData.subRound + 1;
    plan.newSubUsedInRound = [];
    const video = selectVideoCandidate({ ...common, fileList: folderData.allVideos, roundUsed: new Set() });
    if (video) return { video, plan };
  }
  return null;
}

// ────────────────────────── 分组重命名 ──────────────────────────
/** 从成片名反解序号（续跑过滤 BATCH_ONLY_NAMES 用）：容忍分组后缀 A/B/C 与序号标识后缀。
 *  分组任务的成片名形如 <配置名>-<序号><组后缀>.mp4（如 ...-2A.mp4）；配置了后缀标识时形如
 *  <配置名>-<后缀><序号><组后缀>.mp4（如 ...-A2A.mp4）。若只用 -(\d+)$ 匹配，
 *  这类名字全部解析失败 → 分组 / 带后缀任务的续跑永不命中。 */
function parseOnlyNameIndex(name) {
  const s = String(name || '');
  const base = path.basename(s, path.extname(s));
  // 末段 = 可选后缀标识（不含短横与数字）+ 序号 + 可选组后缀。
  // `[^-\d]*` 同时兼容历史上漏掉分隔符的名字（...-resume2A.mp4），已产出的成片仍可续跑。
  const m = /-([^-\d]*)(\d+)([A-Z]?)$/.exec(base);
  return m ? parseInt(m[2], 10) : 0;
}

/** 组后缀：第 idx（1 起）个成片属于第几组 → A/B/C…（对齐 PS 的分桶公式） */
function groupSuffixFor(idx, total, groupCount) {
  if (groupCount <= 1) return '';
  const groupSize = Math.floor(total / groupCount);
  const remainder = total % groupCount;
  let start = 1;
  for (let g = 0; g < groupCount; g++) {
    const size = groupSize + (g < remainder ? 1 : 0);
    if (idx >= start && idx < start + size) return String.fromCharCode(65 + g);
    start += size;
  }
  return '';
}

// ────────────────────────── 主流程 ──────────────────────────
async function run(ctx, env = process.env) {
  const { logger } = ctx;
  const cfg = readEnv(env);
  const scriptRoot = __dirname;
  // 缓存库缺失时的兜底目录：仅用于放互斥锁，绝不写模块目录（那会污染源码仓并随打包进入发布物）
  const cacheDir = path.join(os.tmpdir(), 'video-lab-engine-cache');
  try { fs.mkdirSync(cacheDir, { recursive: true }); } catch (e) {}
  const fail = (msg, step) => { logger.error(step, msg); return 1; };

  // ── 缓存载入：缓存库只读复用（避免 Ticks 精度回写风险），计数语义在库内维护 ──
  const videoStore = openVideoStore();
  // 读取范围收紧为「批量 + 复刻」：遮罩素材的探测条目不得进入批量候选
  const diskVideoCache = videoStore
    ? videoStore.loadVideoMap({ scopesMask: scopes().batch | scopes().replica })
    : {};
  const memInfo = new Map();          // 本次任务内的探测结果缓存
  // 本次真正探测过的条目 → 任务结束后合并写回（只增/更新，不删；GC 仍归 backend）
  // 目的：让执行期现场探测的新文件沉淀进缓存库，供预检测复用，避免重复 ffprobe
  const probedForWriteBack = new Map();
  // 本任务内的使用计数（文件名 → { UsageCount, LastWriteTime }）：
  // 由缓存库认领结果填充，出片后再按增量累加，仅作本次调度依据（持久化在库内）
  const usageCacheMap = {};

  /** 视频信息（对齐 Get-CachedVideoInfo：Ticks 命中则复用，否则探测并记内存） */
  const getInfo = (videoPath) => {
    if (memInfo.has(videoPath)) return memInfo.get(videoPath);
    let stat = null;
    try { stat = fs.statSync(videoPath); } catch (e) { stat = null; }
    if (!stat) {
      const invalid = { valid: false, duration: 0, width: 0, height: 0, ticks: 0 };
      memInfo.set(videoPath, invalid);
      return invalid;
    }
    const ticks = ticksOf(stat);
    const cached = diskVideoCache[videoPath];
    if (cached && Math.abs(Number(cached.LastWriteTime) - ticks) < TICKS_TOLERANCE) {
      const info = {
        valid: !!cached.Valid,
        duration: Number(cached.Duration) || 0,
        width: Number(cached.Width) || 0,
        height: Number(cached.Height) || 0,
        ticks,
      };
      memInfo.set(videoPath, info);
      return info;
    }
    return null; // 需异步探测，见下方 getInfoAsync
  };

  /** 异步版（需要真正探测时使用） */
  const getInfoAsync = async (videoPath) => {
    const hit = getInfo(videoPath);
    if (hit) return hit;
    let stat = null;
    try { stat = fs.statSync(videoPath); } catch (e) { stat = null; }
    if (!stat) {
      const invalid = { valid: false, duration: 0, width: 0, height: 0, ticks: 0 };
      memInfo.set(videoPath, invalid);
      return invalid;
    }
    const r = await probe(videoPath);
    const info = { valid: !!r.valid, duration: r.duration || 0, width: r.width || 0, height: r.height || 0, ticks: ticksOf(stat) };
    memInfo.set(videoPath, info);
    // 精确 Ticks（BigInt）用于写回：PS 侧 `-eq` 是精确比较，Number 精度不足会永不命中
    const bigTicks = ticksBigOfFile(videoPath);
    if (bigTicks !== null) {
      probedForWriteBack.set(videoPath, {
        LastWriteTime: bigTicks,
        Duration: info.duration,
        Width: info.width,
        Height: info.height,
        Valid: info.valid,
        FileSize: Number(stat.size) || 0,
      });
    }
    return info;
  };

  const durationOf = (videoPath) => {
    const hit = memInfo.get(videoPath);
    return hit ? hit.duration : 0;
  };

  // ── TXT 输入校验 ──
  const txtCandidate = stripQuotes(cfg.txt).replace(/^"|"$/g, '');
  let txtFilePath = '';
  try {
    if (txtCandidate && fs.statSync(txtCandidate).isFile() && path.extname(txtCandidate).toLowerCase() === '.txt') {
      txtFilePath = txtCandidate;
      logger.info(`✅ 已通过 REPLICA_TXT 指定TXT文件: ${path.basename(txtFilePath)}`);
    }
  } catch (e) { txtFilePath = ''; }
  if (!txtFilePath) {
    return fail('未通过环境变量 REPLICA_TXT 提供 TXT 文件（脚本由 Video Lab 驱动，不再支持手动输入）', 'TXT输入');
  }

  const txtDir = path.dirname(txtFilePath);
  const txtName = path.basename(txtFilePath, path.extname(txtFilePath));
  let txtNamePrefixPart = '';
  let txtNameSuffix = txtName;
  // 多前缀：取首个命中 TXT 名的作剥离，其余在成片命名时按设置顺序继续命中追加（见命名段）
  for (const p of cfg.txtNamePrefix) {
    if (txtName.startsWith(p)) {
      txtNamePrefixPart = p;
      txtNameSuffix = txtName.slice(p.length);
      break;
    }
  }

  // ── baseDir：向上找「N月」或四位年份目录 ──
  const pathParts = txtDir.split(/[\\/]+/);
  let dateDirIndex = -1;
  for (let i = 0; i < pathParts.length; i++) {
    if (/^\d+月$/.test(pathParts[i]) || /^\d{4}$/.test(pathParts[i])) { dateDirIndex = i; break; }
  }
  let baseDir;
  if (dateDirIndex > 0) baseDir = pathParts.slice(0, dateDirIndex).join('\\');
  else if (dateDirIndex === 0) baseDir = pathParts[0];
  else baseDir = txtDir;
  if (!baseDir) baseDir = txtDir;

  const now = taskDate(cfg.submitTs);
  const monthName = `${now.getMonth() + 1}月`;
  const dayName = `${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  let outputRootDir = path.join(baseDir, monthName, dayName);
  if (cfg.outputDirOverride) outputRootDir = cfg.outputDirOverride;
  logger.info('');
  logger.info(`✅ 输出目录：${outputRootDir}`);

  // ── 解析 TXT ──
  let allLines = [];
  try {
    allLines = fs.readFileSync(txtFilePath, 'utf8').replace(/^\uFEFF/, '')
      .split(/\r?\n/).map((l) => l.trim()).filter((l) => /\S/.test(l));
  } catch (e) {
    return fail(`读取 TXT 失败：${e.message}`, 'TXT输入');
  }
  if (allLines.length < 2) return fail('TXT至少需要1个文件夹+1个水印', 'TXT输入');

  const watermark = stripQuotes(allLines[allLines.length - 1]);
  const excludePaths = [];
  const folderLines = [];
  const noSubRoundFolders = new Set();
  for (const raw of allLines.slice(0, allLines.length - 1)) {
    const line = raw.trim();
    if (line.includes('=')) {
      const folderPath = line.replace(/=/g, '').trim();
      if (folderPath) { folderLines.push(folderPath); noSubRoundFolders.add(folderPath); }
    } else if (line.startsWith('-')) {
      const ex = stripQuotes(line.slice(1).trim());
      if (ex) excludePaths.push(ex);
    } else {
      const folderPath = stripQuotes(line);
      folderLines.push(folderPath);
    }
  }

  // ── 索引自动修复不存在的目录 ──
  const invalidInput = async (msg) => {
    if (msg) { logger.info(''); logger.info(msg); }
    logger.info('请手动修改TXT后重新拖入。');
    return 1;
  };
  const missingPaths = folderLines.filter((p) => !exists(p));
  if (missingPaths.length > 0) {
    const idxFile = findIndexFile(txtFilePath, folderLines, scriptRoot);
    let index = { byDirLeaf: new Map(), byDirSuffix: new Map(), loaded: false };
    if (idxFile) {
      index = loadBatchIndex(idxFile);
      logger.info(`📇 已加载索引：${idxFile}`);
    }
    const replacements = new Map();
    for (const mp of missingPaths) {
      let newDir = index.loaded ? resolveFolderFromIndex(index, mp) : null;
      if (newDir && newDir !== mp) {
        logger.info(`🔎 索引自动修正（相同文件夹名）：${mp} -> ${newDir}`);
      } else {
        const cands = index.loaded ? resolveFolderBySuffix(index, mp) : [];
        if (cands.length > 0) {
          let selected = null;
          if (cands.length === 1) {
            selected = cands[0];
            logger.info(`🔎 索引自动修正（相同后缀）：${mp} -> ${selected}`);
          } else {
            logger.info('');
            logger.info(`🔎 路径 ${mp} 未找到同名文件夹，但找到以下相同后缀候选：`);
            cands.forEach((c, i) => logger.info(`  ${i + 1}. ${c}`));
            selected = cands[0];
            logger.info('（由 Video Lab 驱动，自动选择第 1 项）');
          }
          if (selected && selected !== mp) {
            logger.info(`🔎 索引自动修正：${mp} -> ${selected}`);
            newDir = selected;
          }
        }
      }
      if (newDir) {
        replacements.set(mp, newDir);
        for (let i = 0; i < folderLines.length; i++) {
          if (folderLines[i].toLowerCase() === mp.toLowerCase()) {
            folderLines[i] = newDir;
            if (noSubRoundFolders.has(mp)) { noSubRoundFolders.delete(mp); noSubRoundFolders.add(newDir); }
          }
        }
      }
    }
    if (replacements.size > 0) {
      try {
        const txtLines = fs.readFileSync(txtFilePath, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/);
        for (let i = 0; i < txtLines.length; i++) {
          const trim = txtLines[i].trim();
          let key = trim;
          if (key.startsWith('=')) key = key.slice(1).trim();
          if (replacements.has(key)) {
            txtLines[i] = trim.startsWith('=') ? '=' + replacements.get(key) : replacements.get(key);
          }
        }
        fs.writeFileSync(txtFilePath, txtLines.join('\r\n'), 'utf8');
        logger.info(`✅ TXT文件已同步更新：${txtFilePath}`);
      } catch (e) {
        logger.warn(`TXT 回写失败：${e.message}`);
      }
    }
  }

  // ── 路径 / 水印 / 文件夹校验 ──
  const stillInvalid = folderLines.filter((p) => !exists(p));
  if (stillInvalid.length > 0) {
    logger.info('');
    logger.info('❌ 以下路径无法通过索引自动修复：');
    stillInvalid.forEach((p) => logger.info(`   ${p}`));
    return invalidInput('');
  }
  if (!/\.png$/i.test(watermark) || !exists(watermark)) {
    logger.info('');
    logger.info(`❌ 水印必须是有效PNG文件：${watermark}`);
    return invalidInput('');
  }
  if (folderLines.length === 0) {
    logger.info('');
    logger.info('❌ 无有效视频文件夹');
    return invalidInput('');
  }

  // ── 重复路径提示 ──
  const sourceRequests = folderLines;
  const uniqueFolders = [...new Set(sourceRequests)];
  const pathCounts = new Map();
  for (const p of sourceRequests) pathCounts.set(p, (pathCounts.get(p) || 0) + 1);
  const repeatPaths = new Set([...pathCounts.entries()].filter(([, c]) => c > 1).map(([p]) => p));
  if (repeatPaths.size > 0) {
    logger.info('🔁 检测到重复路径，将在拼接时输出这些路径的详细选取信息');
    for (const rp of repeatPaths) logger.info(`   📂 ${rp} (出现 ${pathCounts.get(rp)} 次)`);
  }

  // ── 扫描每个源目录，构建 folderVideos / usageTracker ──
  logger.info('');
  logger.info('预检测视频文件');
  const folderVideos = new Map();
  const usageTracker = new Map();

  // 计数认领：路径发生变化（改名 / 移位）的素材先尝试继承既有条目的使用计数，
  // 避免被当作全新素材重新计数。与 app 侧预检测共用持久层的同一实现，保证两条路径行为一致。
  // 继承的计数沿用既有语义「≥1 归为 1」（脚本只关心「是否用过」）。
  // 未认领到计数的素材在本次任务内按 0 起算，其计数由出片时的增量写入库。
  const claimUsageFor = (vPath) => {
    if (!videoStore) return null;
    try {
      const tb = ticksBigOfFile(vPath);
      if (tb === null) return null;
      const r = videoStore.claimUsage(vPath, String(tb), {
        fileSize: Number(fs.statSync(vPath).size) || 0,
        scopesMask: scopes().batch | scopes().replica,
        scopes: scopes().batch,
      });
      if (!r || !(Number(r.usageCount) > 0)) return null;
      return { usageCount: Number(r.usageCount), ticks: tb };
    } catch (e) { return null; }
  };

  const pushValid = (target, fullName, name, info) => {
    target.push({ fullName, name, duration: info.duration });
    if (Object.prototype.hasOwnProperty.call(usageCacheMap, fullName)) return;
    const claimed = claimUsageFor(fullName);
    if (claimed) usageCacheMap[fullName] = { UsageCount: claimed.usageCount >= 1 ? 1 : claimed.usageCount, LastWriteTime: claimed.ticks };
  };

  for (const f of uniqueFolders) {
    let stat = null;
    try { stat = fs.statSync(f); } catch (e) { stat = null; }
    if (!stat) return fail(`路径不存在：${f}`, '预检测');

    const subGroups = new Map();
    if (stat.isDirectory()) {
      let rootItems = [];
      try { rootItems = fs.readdirSync(f, { withFileTypes: true }); } catch (e) { rootItems = []; }
      const subDirPaths = [];
      const lnkFiles = [];
      const rootVideoItems = [];
      for (const it of rootItems) {
        const full = path.join(f, it.name);
        if (it.isDirectory()) subDirPaths.push(full);
        else if (path.extname(it.name).toLowerCase() === '.lnk') lnkFiles.push(full);
        else if (isVideoFile(full)) rootVideoItems.push(full);
      }

      // 根目录视频
      const validRoot = [];
      for (const vp of rootVideoItems) {
        if (isExcluded(vp, excludePaths)) continue;
        const info = await getInfoAsync(vp);
        if (info.valid) pushValid(validRoot, vp, path.basename(vp), info);
      }
      if (validRoot.length) subGroups.set('(根目录)', validRoot);

      // 子目录
      for (const subDir of subDirPaths) {
        const files = collectVideoFiles(subDir, logger);
        if (!files.length) continue;
        const validSub = [];
        for (const vp of files) {
          if (isExcluded(vp, excludePaths)) continue;
          const info = await getInfoAsync(vp);
          if (info.valid) pushValid(validSub, vp, path.basename(vp), info);
        }
        if (validSub.length) subGroups.set(subDir, validSub);
      }

      // 快捷方式
      for (const lnk of lnkFiles) {
        const target = getShortcutTarget(lnk, logger);
        if (!target) continue;
        let tstat = null;
        try { tstat = fs.statSync(target); } catch (e) { tstat = null; }
        if (!tstat) continue;
        if (tstat.isDirectory()) {
          const files = collectVideoFiles(target, logger);
          if (!files.length) continue;
          const validT = [];
          for (const vp of files) {
            if (isExcluded(vp, excludePaths)) continue;
            const info = await getInfoAsync(vp);
            if (info.valid) pushValid(validT, vp, path.basename(vp), info);
          }
          if (validT.length) subGroups.set(`[快捷方式] ${path.basename(lnk)}`, validT);
        } else if (isVideoFile(target) && !isExcluded(target, excludePaths)) {
          const info = await getInfoAsync(target);
          if (info.valid) {
            if (!subGroups.has('(根目录)')) subGroups.set('(根目录)', []);
            pushValid(subGroups.get('(根目录)'), target, path.basename(target), info);
          }
        }
      }
    } else if (isVideoFile(f)) {
      if (isExcluded(f, excludePaths)) {
        logger.warn(`文件被排除规则命中：${f}`);
      } else {
        const info = await getInfoAsync(f);
        if (info.valid) {
          const arr = [];
          pushValid(arr, f, path.basename(f), info);
          subGroups.set('(根目录)', arr);
        }
      }
    } else {
      logger.warn(`指定的文件不是视频格式：${f}`);
      continue;
    }

    // 汇总：AllVideos 去重排序；子组列表
    let allVideos = [];
    let subGroupList = [];
    for (const [key, arr] of subGroups.entries()) { allVideos = allVideos.concat(arr); subGroupList.push(key); }
    const seen = new Set();
    allVideos = allVideos
      .filter((v) => (seen.has(v.fullName) ? false : (seen.add(v.fullName), true)))
      .sort((a, b) => (a.fullName < b.fullName ? -1 : a.fullName > b.fullName ? 1 : 0));

    if (allVideos.length === 0) {
      logger.info('');
      logger.info(`❌ 路径 ${f} 过滤后无任何合规视频（分辨率/时长不符合）`);
      return invalidInput('');
    }

    if (noSubRoundFolders.has(f)) {
      subGroups.clear();
      subGroups.set('全部', allVideos);
      subGroupList = ['全部'];
    }

    if (subGroupList.length <= 1) logger.info(`${f} ：${allVideos.length} 个视频`);
    else logger.info(`${f} ：${allVideos.length} 个视频，分为 ${subGroupList.length} 个子组`);

    const subUsageCount = new Map();
    for (const g of subGroupList) subUsageCount.set(g, 0);
    folderVideos.set(f, {
      allVideos,
      subGroups,
      subGroupList,
      subRound: 1,
      subUsedInRound: [],
      subUsageCount,
    });

    const usedCount = new Map();
    for (const v of allVideos) {
      const entry = usageCacheMap[v.fullName];
      usedCount.set(v.fullName, entry ? Number(entry.UsageCount) || 0 : 0);
    }
    usageTracker.set(f, { folder: f, usedCount, roundUsed: [], round: 1 });
  }

  // ── 生成数量 / 分组数 ──
  logger.info('');
  logger.info('设置生成数量');
  if (cfg.count == null || cfg.count <= 0) {
    return fail('未通过环境变量 BATCH_COUNT 指定生成数量（脚本由 Video Lab 驱动）', '生成数量');
  }
  const totalOutput = cfg.count;
  logger.info(`已通过 BATCH_COUNT 指定生成数量: ${totalOutput}`);

  let groupCount = 0;
  if (totalOutput > 1) {
    logger.info('');
    logger.info('设置分组数');
    if (cfg.group == null) {
      return fail('未通过环境变量 BATCH_GROUP 指定分组数（脚本由 Video Lab 驱动）', '分组数');
    }
    groupCount = cfg.group;
    logger.info(`已通过 BATCH_GROUP 指定分组数: ${groupCount}`);
  }

  // ── 互斥锁（backend 已串行；此处为兜底）──
  // 位置固定：与缓存库同级（跨进程稳定的同一把锁），库未注入时退回系统临时目录
  logger.info('');
  logger.lockWaiting('准备拼接...');
  const lockDir = path.dirname(String(process.env.VL_CACHE_DB || '').trim() || cacheDir);
  try { fs.mkdirSync(lockDir, { recursive: true }); } catch (e) {}
  const lockPath = path.join(lockDir, '.video-lab-batch.lock');
  let lock = null;
  try {
    lock = await acquireLock(lockPath);
  } catch (e) {
    return fail(`获取互斥锁失败：${e.message}`, '互斥锁');
  }
  logger.lockAcquired('开始执行拼接任务');

  let hasError = false;
  try {
    // ── 创建输出目录 ──
    logger.info('');
    logger.info('创建输出目录');
    const monthDir = path.dirname(outputRootDir);
    fs.mkdirSync(monthDir, { recursive: true });
    fs.mkdirSync(outputRootDir, { recursive: true });
    const tag = timeTag(taskDate(cfg.submitTs));
    const outDir = path.join(outputRootDir, `${tag}-${txtName}-成片`);
    if (!exists(outDir)) {
      fs.mkdirSync(outDir, { recursive: true });
      logger.outDir(outDir);
    }
    // 配置移入成片文件夹作为正本（移动而非复制）
    const txtDest = path.join(outDir, path.basename(txtFilePath));
    try {
      fs.renameSync(txtFilePath, txtDest);
    } catch (e) {
      fs.copyFileSync(txtFilePath, txtDest);
      try { fs.unlinkSync(txtFilePath); } catch (e2) { /* 忽略 */ }
    }

    const logFilePath = path.join(outDir, `${tag}-${txtName}-拼接日志.txt`);
    // 续跑时日志已存在 → 保留并追加，不清空（否则会抹掉首次记录）
    if (!exists(logFilePath)) fs.writeFileSync(logFilePath, '', 'utf8');

    logger.info('');

    // 续跑：仅重做 BATCH_ONLY_NAMES 指定的序号；totalOutput / groupCount 保持原始值不动，
    // 使成片命名（-序号）与分组后缀（A/B/C）与首次运行完全一致
    let indexList = [];
    for (let i = 1; i <= totalOutput; i++) indexList.push(i);
    let resumeMode = false;
    if (cfg.onlyNames) {
      const onlyIdx = [];
      for (const nm of String(cfg.onlyNames).split(';').map((x) => x.trim()).filter(Boolean)) {
        const idx = parseOnlyNameIndex(nm);
        if (idx > 0) onlyIdx.push(idx);
      }
      if (onlyIdx.length === 0) {
        return fail(`续跑过滤未从成片名解析出序号：${cfg.onlyNames}（应为 <成片名>-<序号>.mp4）`, '续跑过滤');
      }
      indexList = Array.from(new Set(onlyIdx)).sort((a, b) => a - b);
      resumeMode = true;
    }
    // 先声明模式与范围、再报总数：否则续跑时那句「开始批量生成（共 N 个）」
    // 会被误读成「要重做 N 个」，看上去像重新开始
    logger.info(resumeMode
      ? `🔁 续跑模式：仅重做 ${indexList.length} 个成片（序号 ${indexList.join(', ')}）—— 本批共 ${totalOutput} 个，其余保留既有产物`
      : `开始批量生成（共 ${totalOutput} 个）`);

    const dPrefix = datePrefix(taskDate(cfg.submitTs));
    const parentFolder = path.basename(baseDir);
    const maxAllowedEstimate = cfg.maxTotalDuration * cfg.speedThreshold;

    for (const outIndex of indexList) {
      logger.info('');
      logger.info('-'.repeat(48));
      logger.progress('生成', outIndex, totalOutput);

      let selectedParts = null;
      let updatePlans = [];
      let foundCombination = false;
      let failReason = null;
      let totalDuration = 0;

      let firstPickVideo = null;              // 首段固定
      const retryExcluded = new Set();        // 跨轮失败记忆：键 =「位置索引|视频路径」
      let retryTargetSrc = -1;
      const staleParts = new Map();           // [srcIdx] 上轮片段（沿用基础）
      const stalePlans = new Map();
      const exhaustedSrcs = new Set();
      let retryCount = 0;

      for (retryCount = 0; retryCount < cfg.maxRetry; retryCount++) {
        const tempParts = [];
        const tempPlans = [];
        totalDuration = 0;
        let allValid = true;
        let failSrcIdx = -1;

        const sourceExcludedSubGroups = new Map();
        const sourceExcludedPaths = new Map();
        const repeatPickCount = new Map();
        let srcIdx = 0;

        for (const srcPath of sourceRequests) {
          const track = usageTracker.get(srcPath);
          const folderData = folderVideos.get(srcPath);

          // 首段固定：重试轮复用首轮选定片段（含其 plan）
          if (retryCount > 0 && srcIdx === 0 && firstPickVideo) {
            tempParts.push(firstPickVideo.video);
            totalDuration += firstPickVideo.video.duration;
            tempPlans.push(firstPickVideo.plan);
            registerPickedClip(sourceExcludedPaths, sourceExcludedSubGroups, srcPath, firstPickVideo.video, firstPickVideo.plan);
            srcIdx++;
            continue;
          }

          // 渐进沿用：非目标源且上轮有选择 → 直接复用（已耗尽源也沿用，仅不再作为替换目标）
          if (retryCount > 0 && retryTargetSrc !== srcIdx && staleParts.has(srcIdx)) {
            tempParts.push(staleParts.get(srcIdx));
            totalDuration += staleParts.get(srcIdx).duration;
            tempPlans.push(stalePlans.get(srcIdx));
            registerPickedClip(sourceExcludedPaths, sourceExcludedSubGroups, srcPath, staleParts.get(srcIdx), stalePlans.get(srcIdx));
            srcIdx++;
            continue;
          }

          const excludedSubs = sourceExcludedSubGroups.get(srcPath) || [];
          let excludedFiles = [...(sourceExcludedPaths.get(srcPath) || [])];
          // 跨轮失败记忆：按「位置索引」隔离（配置允许同一路径重复出现）
          if (srcIdx > 0) {
            excludedFiles = excludedFiles.concat(triedPathsFor(retryExcluded, srcIdx));
          }

          const isRepeat = repeatPaths.has(srcPath);
          let pickSeq = 0;
          if (isRepeat) {
            if (!repeatPickCount.has(srcPath)) repeatPickCount.set(srcPath, 0);
            pickSeq = repeatPickCount.get(srcPath) + 1;
          }

          const preferShort = srcIdx > 0 && retryCount > 0;
          // 替换目标源只接受更短片段：该源无更短候选时换片段不会降低总时长 → 判耗尽、改试其它源
          let shorterThan = 0;
          if (preferShort && retryTargetSrc === srcIdx && staleParts.has(srcIdx)) {
            shorterThan = staleParts.get(srcIdx).duration;
          }

          const result = selectVideo({
            srcPath, track, folderData,
            excludedPaths: excludedFiles,
            excludedSubGroups: excludedSubs,
            preferShort, shorterThan, getInfo: durationOf,
          });
          if (!result) { allValid = false; failSrcIdx = srcIdx; break; }

          if (srcIdx === 0 && !firstPickVideo) firstPickVideo = result;

          tempParts.push(result.video);
          totalDuration += result.video.duration;
          tempPlans.push(result.plan);

          if (isRepeat) {
            const groupName = result.plan.selectedGroup || '(根目录)';
            logger.info(`🔁 [重复源] 第 ${pickSeq} 次选取: ${groupName}\\${result.video.name}`);
            repeatPickCount.set(srcPath, pickSeq);
          }

          registerPickedClip(sourceExcludedPaths, sourceExcludedSubGroups, srcPath, result.video, result.plan);
          staleParts.set(srcIdx, result.video);
          stalePlans.set(srcIdx, result.plan);
          srcIdx++;
        }

        if (!allValid) {
          if (retryCount > 0) {
            // 无沿用基础 → 该源确实无素材，替换其它源也补不齐，直接失败
            if (!staleParts.has(failSrcIdx)) {
              failReason = `源「${path.basename(sourceRequests[failSrcIdx])}」无可用片段（无合规视频或候选已被排除）`;
              break;
            }
            exhaustedSrcs.add(failSrcIdx);
            retryTargetSrc = -1;
            let maxDur = -1;
            for (let pi = 1; pi < sourceRequests.length; pi++) {
              if (exhaustedSrcs.has(pi)) continue;
              // 本轮在此处中断时 tempParts 不完整 → 回退用沿用基础评估时长
              const dur = tempParts[pi] ? tempParts[pi].duration : (staleParts.has(pi) ? staleParts.get(pi).duration : 0);
              if (dur > maxDur) { maxDur = dur; retryTargetSrc = pi; }
            }
            if (retryTargetSrc < 0) { failReason = '所有源的可替换片段均已用尽（首段固定不参与替换）'; break; }
            continue;
          }
          continue; // 首轮失败：静默进入渐进替换
        }

        if (totalDuration <= maxAllowedEstimate) {
          if (totalDuration > cfg.maxTotalDuration) {
            logger.warn(`预估时长 ${totalDuration} 秒 超过设定值但未超过阈值 ${Math.round((cfg.speedThreshold - 1) * 100)}%，后续将加速处理`);
          }
          if (retryCount > 0) {
            logger.warn(`该成片经 ${retryCount} 轮渐进替换后达标（总时长 ${totalDuration} 秒）`);
          }
          selectedParts = tempParts;
          updatePlans = tempPlans;
          foundCombination = true;
          break;
        }

        // 时长超限：记录失败记忆 + 存沿用基础 + 定下一轮目标源（非首段中最长、未耗尽）
        for (let pi = 1; pi < sourceRequests.length; pi++) {
          if (pi < tempParts.length) retryExcluded.add(failKey(pi, tempParts[pi].fullName));
          if (tempParts[pi]) { staleParts.set(pi, tempParts[pi]); stalePlans.set(pi, tempPlans[pi]); }
        }
        retryTargetSrc = -1;
        let maxDur = -1;
        for (let pi = 1; pi < sourceRequests.length; pi++) {
          if (exhaustedSrcs.has(pi)) continue;
          if (tempParts[pi] && tempParts[pi].duration > maxDur) { maxDur = tempParts[pi].duration; retryTargetSrc = pi; }
        }
        if (retryTargetSrc < 0) {
          failReason = `非首段源的可替换片段均已用尽，仍超出时长上限 ${cfg.maxTotalDuration} 秒`;
          break;
        }
      }

      if (!foundCombination) {
        const rounds = Math.min(retryCount + 1, Math.round(cfg.maxRetry));
        const msg = failReason || `重试 ${rounds} 轮仍无法找到满足时长的组合（时长上限 ${cfg.maxTotalDuration} 秒）`;
        logger.error(`第 ${outIndex} 个成片`, msg);
        hasError = true;
        continue;
      }

      const currentParts = selectedParts.map((v) => v.fullName);

      // ── 成片命名 ──
      const nameItems = [dPrefix, cfg.producerName];
      // 多前缀：全部命中（TXT 名剥离命中 或 任一素材路径包含）的前缀按设置顺序全部写入，`-` 分隔
      const hitPrefixes = [];
      const partsLow = selectedParts.map((v) => String(v.fullName).toLowerCase());
      const checkHit = (p) => {
        if (p && partsLow.some((f) => f.includes(String(p).toLowerCase()))) return true;
        return false;
      };
      for (const p of cfg.txtNamePrefix) {
        if (p === txtNamePrefixPart || checkHit(p)) hitPrefixes.push(p);
      }
      if (txtNamePrefixPart && !hitPrefixes.includes(txtNamePrefixPart)) hitPrefixes.unshift(txtNamePrefixPart);
      for (const p of hitPrefixes) nameItems.push(String(p).replace(/-+$/, ''));
      nameItems.push(parentFolder);
      nameItems.push(txtNameSuffix.replace(/^-+/, ''));
      // 后缀：单值字符串（多值已回滚），兼容数组形态；为空则不加内容
      const mk = cfg.suffixMark;
      const suffixStr = (Array.isArray(mk) ? mk.join('-') : String(mk == null ? '' : mk)).trim();
      // 序号前的 `-` 分隔必须保留 —— 续跑要按 `-<序号>` 反解成片名（parseOnlyNameIndex）；
      // 整串再合并连续 `--`，消除 txtNameSuffix 为空时出现的 `--序号`
      let finalOutName = `${nameItems.join('-')}-${suffixStr}${outIndex}.mp4`.replace(/-{2,}/g, '-');
      let finalOut = path.join(outDir, finalOutName);

      // ── 输入文件存在性 ──
      let allExist = true;
      for (const p of currentParts) {
        if (!exists(p)) { logger.info(`⚠️  文件不存在：${p}`); allExist = false; }
      }
      if (!allExist) {
        logger.error(`第 ${outIndex} 个成片-文件检查`, '部分输入文件不存在');
        logger.fail(finalOutName, '部分输入文件不存在');
        hasError = true;
        continue;
      }

      // ── 加速判定 ──
      let needSpeed = false;
      let speedRatio = 1.0;
      if (totalDuration > cfg.maxTotalDuration && totalDuration <= maxAllowedEstimate) {
        needSpeed = true;
        speedRatio = totalDuration / cfg.maxTotalDuration;
        if (speedRatio > 2.0) speedRatio = 2.0;
      }

      const n = currentParts.length;
      if (n === 0) {
        logger.error(`第 ${outIndex} 个成片-片段数检查`, '无有效视频片段');
        logger.fail(finalOutName, '无有效视频片段');
        hasError = true;
        continue;
      }

      // ── 拼接参数 ──
      const inputArgs = [];
      for (const p of currentParts) { inputArgs.push('-i', p); }
      inputArgs.push('-i', watermark);

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
      const targetDur = totalDuration > cfg.maxTotalDuration ? cfg.maxTotalDuration : totalDuration;
      logger.clipDuration(targetDur);
      const { code } = await runFfmpeg(inputArgs.concat(encArgs), { onProgress: (line) => logger.raw(line) });
      if (code !== 0) {
        logger.error(`第 ${outIndex} 个成片`, '一次性编码失败');
        logger.fail(finalOutName, 'ffmpeg 编码失败');
        hasError = true;
        continue;
      }

      // ── 状态更新 ──
      const planGroups = new Map();
      for (const plan of updatePlans) {
        if (!planGroups.has(plan.folder)) planGroups.set(plan.folder, []);
        planGroups.get(plan.folder).push(plan);
      }
      for (const [f, plans] of planGroups.entries()) {
        const track = usageTracker.get(f);
        const folderData = folderVideos.get(f);
        let maxRound = track.round;
        let maxSubRound = folderData.subRound;
        const mergedRoundUsed = [...track.roundUsed];
        const mergedSubUsed = [...folderData.subUsedInRound];
        const subUsageIncrements = new Map();
        for (const plan of plans) {
          if (plan.newRound > maxRound) maxRound = plan.newRound;
          if (plan.newSubRound > maxSubRound) maxSubRound = plan.newSubRound;
          for (const p of plan.newRoundUsed) if (!mergedRoundUsed.includes(p)) mergedRoundUsed.push(p);
          for (const g of plan.newSubUsedInRound) if (!mergedSubUsed.includes(g)) mergedSubUsed.push(g);
          if (plan.incrementSubUsage) {
            subUsageIncrements.set(plan.incrementSubUsage, (subUsageIncrements.get(plan.incrementSubUsage) || 0) + 1);
          }
        }
        track.round = maxRound;
        track.roundUsed = mergedRoundUsed;
        folderData.subRound = maxSubRound;
        folderData.subUsedInRound = mergedSubUsed;
        for (const [g, inc] of subUsageIncrements.entries()) {
          folderData.subUsageCount.set(g, (folderData.subUsageCount.get(g) || 0) + inc);
        }
      }
      for (let i = 0; i < selectedParts.length; i++) {
        const video = selectedParts[i];
        const plan = updatePlans[i];
        const track = usageTracker.get(plan.folder);
        track.usedCount.set(video.fullName, (track.usedCount.get(video.fullName) || 0) + 1);
        if (!track.roundUsed.includes(video.fullName)) track.roundUsed.push(video.fullName);
      }

      // 计数增量：随出片即时累加进缓存库（唯一持久层）
      const increments = new Map();
      for (const video of selectedParts) increments.set(video.fullName, (increments.get(video.fullName) || 0) + 1);
      for (const [p, inc] of increments.entries()) {
        try { videoStore.addVideoUsage(p, inc); } catch (e) { /* 计数写库失败不影响出片 */ }
      }

      // ── 最终时长 + 完成行 ──
      const finalInfo = await probe(finalOut);
      const finalDuration = finalInfo.duration || 0;
      logger.clipDoneBatch(finalDuration, needSpeed ? speedRatio : 1);

      // ── 即时分组重命名 ──
      if (groupCount > 0 && totalOutput > 1) {
        const gs = groupSuffixFor(outIndex, totalOutput, groupCount);
        if (gs && exists(finalOut)) {
          const base = path.basename(finalOut, path.extname(finalOut));
          const ext = path.extname(finalOut);
          const renamed = path.join(outDir, base + gs + ext);
          if (!exists(renamed)) {
            try { fs.renameSync(finalOut, renamed); finalOut = renamed; } catch (e) { /* 静默 */ }
          }
        }
      }

      // ── 写拼接日志 ──
      const logLines = [path.basename(finalOut), '使用片段列表：', ...currentParts, '', watermark];
      if (outIndex < totalOutput) logLines.push('='.repeat(46));
      fs.appendFileSync(logFilePath, logLines.join('\r\n') + '\r\n', 'utf8');
    }

    logger.info('');
    logger.info('================================================');
  } finally {
    // video_cache 写回：把本次现场探测到的条目合并进缓存库（只增/更新，不删；GC 仍归 backend）。
    // 目的：让执行期新扫描到的素材沉淀下来，供预检测复用，避免每次重探。
    // 写失败不影响任务结果，保持静默（不额外输出）。
    if (probedForWriteBack.size > 0 && videoStore) {
      try {
        // 只写本次新探测的条目（增量事务），无需读全量再整份重写
        const rows = {};
        for (const [p, v] of probedForWriteBack) {
          rows[p] = { LastWriteTime: String(v.LastWriteTime), Duration: v.Duration, Valid: v.Valid, Width: v.Width, Height: v.Height, FileSize: v.FileSize };
        }
        videoStore.applyVideoDelta(rows, null);
      } catch (e) { /* 忽略：缓存写回失败不应影响成片产出 */ }
    }
    if (videoStore) { try { videoStore.close(); } catch (e) { /* 忽略 */ } }
    if (lock) { try { lock.release(); } catch (e) { /* 忽略 */ } }
    logger.lockReleased();
  }

  if (hasError) {
    logger.info('');
    logger.info('任务完成（有错误）');
    return 1;
  }
  logger.info('');
  logger.info('任务全部完成');
  return 0;
}

module.exports = {
  id: 'batch',
  title: '批量拼接',
  envVars: ['BATCH_*', 'VL_CACHE_DB'],
  run,
  // 供测试复用
  _internals: {
    readEnv, taskDate, timeTag, datePrefix, ticksOf,
    parseLnkTarget, resolveBrokenTarget, collectVideoFiles, isExcluded,
    findIndexInTree, findIndexFile, folderSuffix, loadBatchIndex,
    resolveFolderFromIndex, resolveFolderBySuffix,
    selectVideo, selectVideoCandidate, registerPickedClip, groupSuffixFor,
    openVideoStore, parseOnlyNameIndex,
  },
};
