// engines/modules/mask/index.js —— 遮罩叠加（迁移自 video_mask.ps1，行为等价优先）
// 模式1=遮罩+水印（预处理预合成）/ 模式2=仅水印 / 模式3=仅遮罩；多原片×多遮罩全组合。
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { runFfmpeg } = require('../../base/ffmpeg');
const { probe } = require('../../base/probe');
const { acquireLock } = require('../../base/lock');
const { exists, getMaskDirName } = require('../../base/paths');

const RAW_EXTS = ['*.mp4', '*.mov', '*.avi', '*.mkv', '*.m4v', '*.webm', '*.flv'];
const MASK_EXTS = ['*.mov', '*.mp4'];

const splitList = (s) => String(s == null ? '' : s).split(';').map((x) => x.trim()).filter(Boolean);
const uniq = (arr) => Array.from(new Set(arr)).sort();

function readEnv(env = process.env) {
  const n = (k, d = '') => (env[k] == null ? d : String(env[k]));
  let mode = parseInt(n('MASK_MODE', '1'), 10);
  if (![1, 2, 3].includes(mode)) mode = 1;
  let alpha = 0.3;
  const a = parseFloat(n('MASK_WATERMARK_ALPHA'));
  if (!Number.isNaN(a) && a >= 0.05 && a <= 1.0) alpha = a;
  const ts = parseInt(n('MASK_SUBMIT_TS', '0'), 10) || 0;
  return {
    mode,
    alpha,
    rawDirs: splitList(n('MASK_RAW_DIRS')),
    videos: splitList(n('MASK_VIDEOS')),
    maskDirs: splitList(n('MASK_MASK_DIRS')),
    masks: splitList(n('MASK_MASKS')),
    watermark: n('MASK_WATERMARK'),
    outputDir: n('MASK_OUTPUT_DIR'),
    logDir: n('MASK_LOG_DIR'),
    onlyNames: splitList(n('MASK_ONLY_NAMES')),
    suffixMark: n('MASK_SUFFIX_MARK'),
    submitTs: ts,
    projectName: n('MASK_PROJECT_NAME'),
  };
}

/** 任务日期：提交时刻优先（跨天不回退实际运行日期） */
function taskDate(submitTs) {
  return submitTs > 0 ? new Date(submitTs) : new Date();
}
function pad(n) { return String(n).padStart(2, '0'); }

/** 递归扫描扩展名集合（对齐 PS 的 Get-ChildItem -Filter -Recurse + Sort-Unique） */
function scanByExts(dirs, patterns) {
  const out = [];
  for (const d of dirs) {
    let ok = false;
    try { ok = fs.statSync(d).isDirectory(); } catch (e) { ok = false; }
    if (!ok) continue;
    const walk = (dir) => {
      let entries = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
      for (const ent of entries) {
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) { walk(full); continue; }
        const ext = path.extname(ent.name).toLowerCase();
        if (patterns.some((p) => p.slice(1).toLowerCase() === ext)) out.push(full);
      }
    };
    walk(d);
  }
  return uniq(out);
}

function safeBaseName(p) {
  return path.basename(p, path.extname(p)).replace(/[\\/:*?"<>|]/g, '_');
}

/** 转义正则以做“以 X 开头”判断（PS 的 StartsWith 语义） */
function startsWith(s, prefix) { return s.startsWith(prefix); }

function buildJobs(cfg, allVideos, allMasks, dateStr) {
  const yy = `${String(dateStr.getFullYear()).slice(2)}${pad(dateStr.getMonth() + 1)}${pad(dateStr.getDate())}`;
  const jobs = [];
  if (cfg.mode === 2) {
    for (const vp of allVideos) {
      const base = safeBaseName(vp);
      const outName = `${base}-水印${cfg.suffixMark ? '-' + cfg.suffixMark : ''}.mp4`;
      let dirName = base.replace(/-水印$/, '');
      if (!dirName.trim()) dirName = base;
      if (cfg.suffixMark) dirName += `-${cfg.suffixMark}`;
      jobs.push({ vidPath: vp, maskPath: '', outFile: path.join(cfg.outputDir, dirName, outName), outName, theme: yy });
    }
    return jobs;
  }
  for (const vp of allVideos) {
    for (const mp of allMasks) {
      const maskName = path.basename(mp, path.extname(mp));
      const theme = maskName;
      const vidIdx = allVideos.indexOf(vp) + 1;
      const projName = cfg.projectName && cfg.projectName.trim() ? cfg.projectName : theme;
      // 遮罩名常已带项目名前缀 → 不再重复拼接，避免成片名出现两个项目名
      const dedupName = startsWith(maskName, projName) ? maskName : `${projName}-${maskName}`;
      const baseName = `${yy}-${dedupName}`;
      let dirName = getMaskDirName(`${baseName}-${vidIdx}.mp4`);
      if (cfg.suffixMark) dirName += `-${cfg.suffixMark}`;
      const outName = `${baseName}-${cfg.suffixMark}${vidIdx}.mp4`;
      jobs.push({ vidPath: vp, maskPath: mp, outFile: path.join(cfg.outputDir, dirName, outName), outName, theme });
    }
  }
  return jobs;
}

/** 续跑过滤：成片名或其去扩展名形式命中即保留（PS 的 OutName/BaseName 双匹配） */
function filterOnlyNames(jobs, onlyNames) {
  if (!onlyNames.length) return jobs;
  const bases = onlyNames.map((n) => path.basename(n, path.extname(n)));
  return jobs.filter((j) => {
    const b = path.basename(j.outName, path.extname(j.outName));
    return onlyNames.includes(j.outName) || bases.includes(b);
  });
}

async function durationOf(p) {
  const info = await probe(p);
  return info && info.duration > 0 ? info.duration : 0;
}

function makeFfArgs(args, logger) {
  return runFfmpeg(args, {
    onProgress: (line) => logger.raw(line),
  });
}

async function run(ctx, env = process.env) {
  const { logger } = ctx;
  const cfg = readEnv(env);
  const fail = (msg, step) => { logger.error(step, msg); return 1; };

  // ── 参数校验（与 PS1 顺序、文案一致） ──
  if (!cfg.rawDirs.length || !cfg.outputDir.trim()) {
    return fail('缺少原片文件夹或输出目录环境变量', '参数校验');
  }
  if ((cfg.mode === 1 || cfg.mode === 3) && !cfg.maskDirs.length) {
    return fail(`缺少遮罩目录（模式 ${cfg.mode} 需要）`, '参数校验');
  }
  if ((cfg.mode === 1 || cfg.mode === 2) && !cfg.watermark.trim()) {
    return fail(`缺少水印文件（模式 ${cfg.mode} 需要）`, '参数校验');
  }
  if (cfg.mode !== 2) {
    const existsCount = cfg.maskDirs.filter((d) => { try { return fs.statSync(d).isDirectory(); } catch (e) { return false; } }).length;
    if (existsCount === 0) return fail(`遮罩目录均不存在：${cfg.maskDirs.join(';')}`, '遮罩扫描');
  }
  try { fs.mkdirSync(cfg.outputDir, { recursive: true }); } catch (e) {}
  if (cfg.mode !== 3 && !exists(cfg.watermark)) {
    return fail(`水印文件不存在：${cfg.watermark}`, '参数校验');
  }

  // ── 扫描原片 ──
  let allVideos = scanByExts(cfg.rawDirs, RAW_EXTS);
  for (const rd of cfg.rawDirs) {
    try { if (!fs.statSync(rd).isDirectory()) logger.warn(`原片文件夹不存在，已跳过：${rd}`); } catch (e) { logger.warn(`原片文件夹不存在，已跳过：${rd}`); }
  }
  if (cfg.videos.length) {
    const pick = new Set(cfg.videos);
    allVideos = allVideos.filter((v) => pick.has(v));
  }
  if (!allVideos.length) return fail('未找到任何原片视频', '原片扫描');

  // ── 扫描遮罩 ──
  let allMasks = [];
  if (cfg.mode !== 2) {
    allMasks = scanByExts(cfg.maskDirs, MASK_EXTS);
    if (cfg.masks.length) {
      const pick = new Set(cfg.masks);
      allMasks = allMasks.filter((m) => pick.has(m));
    }
    if (!allMasks.length) return fail(`未找到任何遮罩素材（${cfg.maskDirs.join(';')}）`, '遮罩扫描');
  }

  // ── 构建任务列表 + 续跑过滤 ──
  const dateStr = taskDate(cfg.submitTs);
  let jobs = buildJobs(cfg, allVideos, allMasks, dateStr);
  jobs = filterOnlyNames(jobs, cfg.onlyNames);
  if (cfg.onlyNames.length && !jobs.length) {
    return fail(`未找到指定成片：${cfg.onlyNames.join('、')}`, '续跑过滤');
  }

  // ── 模式1：遮罩+水印预处理（独立临时目录，任务结束清理） ──
  const combinedMap = new Map();
  let combineDir = null;
  if (cfg.mode === 1) {
    combineDir = path.join(os.tmpdir(), 'MaskWatermarkTemp');
    try { fs.mkdirSync(combineDir, { recursive: true }); } catch (e) {}
    for (const j of jobs) {
      if (combinedMap.has(j.maskPath)) continue;
      const maskName = path.basename(j.maskPath, path.extname(j.maskPath));
      let lastWrite = '';
      try { const st = fs.statSync(j.maskPath); lastWrite = st.mtime.toISOString().replace(/[-:TZ.]/g, '').slice(0, 14); } catch (e) {}
      const combinedPath = path.join(combineDir, `combined_${maskName}_${lastWrite}.mov`);
      if (exists(combinedPath)) { combinedMap.set(j.maskPath, combinedPath); continue; }
      logger.info('');
      logger.info(`🔧 预处理合并遮罩与水印：${maskName} ...`);
      let maskDur = await durationOf(j.maskPath);
      if (maskDur <= 0) maskDur = 5.0;
      const filter = `[0:v]trim=duration=${maskDur},setpts=PTS-STARTPTS[mask];[1:v]trim=duration=${maskDur},setpts=PTS-STARTPTS,colorchannelmixer=aa=${cfg.alpha}[wm];[mask][wm]overlay=0:0[outv]`;
      const args = ['-y', '-loglevel', 'error', '-stats',
        '-i', j.maskPath, '-i', cfg.watermark,
        '-filter_complex', filter,
        '-map', '[outv]', '-map', '0:a?',
        '-c:v', 'prores_ks', '-profile:v', '4444', '-pix_fmt', 'yuva444p10le',
        '-c:a', 'aac', '-b:a', '192k',
        combinedPath];
      const { code } = await makeFfArgs(args, logger);
      if (code !== 0 || !exists(combinedPath)) return fail(`遮罩与水印预处理失败：${maskName}`, '预处理');
      logger.info('✅ 预处理完成');
      combinedMap.set(j.maskPath, combinedPath);
    }
  }

  // ── 主流程（锁 + 批量合成） ──
  const lockPath = path.join(cfg.outputDir, '.video-lab-mask.lock');
  logger.lockWaiting();
  const lock = await acquireLock(lockPath);
  logger.lockAcquired('开始遮罩叠加任务');
  let hasError = false;
  try {
    const total = jobs.length;
    const themeLogs = new Map();
    logger.info('');
    logger.info(`开始遮罩叠加，共 ${total} 个成片`);
    for (let i = 0; i < total; i++) {
      const j = jobs[i];
      const idx = i + 1;
      logger.raw('='.repeat(46));
      logger.info('');
      logger.info(`生成第 ${idx} / ${total} 个成片：${j.outName}`);

      // 跳过检测：输出已存在且时长一致（±1s）
      let skip = false;
      if (exists(j.outFile)) {
        let srcPath = cfg.mode === 2 ? j.vidPath : j.maskPath;
        if (combinedMap.has(j.maskPath)) srcPath = combinedMap.get(j.maskPath);
        const expected = await durationOf(srcPath);
        const existing = await durationOf(j.outFile);
        if (expected > 0 && existing > 0 && Math.abs(expected - existing) <= 1.0) skip = true;
      }
      if (skip) { logger.info('   ⏭️ 跳过（已存在且时长一致）'); continue; }
      if (exists(j.outFile)) logger.info('   🔄 覆盖现有文件');

      const subDir = path.dirname(j.outFile);
      if (subDir) { try { fs.mkdirSync(subDir, { recursive: true }); } catch (e) {} }

      let targetDur;
      let ffArgs;
      if (cfg.mode === 2) {
        let vidDur = await durationOf(j.vidPath);
        if (vidDur <= 0) vidDur = 5.0;
        targetDur = vidDur;
        const filter = `[0:v]trim=duration=${vidDur},setpts=PTS-STARTPTS[base];[1:v]trim=duration=${vidDur},setpts=PTS-STARTPTS,colorchannelmixer=aa=${cfg.alpha}[wm];[base][wm]overlay=0:0[outv]`;
        ffArgs = ['-y', '-loglevel', 'error', '-stats',
          '-i', j.vidPath, '-i', cfg.watermark,
          '-filter_complex', filter,
          '-map', '[outv]', '-map', '0:a',
          '-c:v', 'h264_nvenc', '-preset', 'p4', '-rc', 'vbr', '-cq', '25',
          '-c:a', 'aac', '-b:a', '192k', '-shortest',
          j.outFile];
      } else {
        const srcForDur = cfg.mode === 1 ? combinedMap.get(j.maskPath) : j.maskPath;
        let vidDur = await durationOf(j.vidPath);
        if (vidDur <= 0) vidDur = 5.0;
        let maskDur = await durationOf(srcForDur);
        if (maskDur <= 0) maskDur = 5.0;
        targetDur = Math.min(vidDur, maskDur);
        if (vidDur < maskDur && (maskDur - vidDur) > 1.0) {
          logger.warn(`原片时长（${Math.round(vidDur * 100) / 100} s）比遮罩时长（${Math.round(maskDur * 100) / 100} s）短超过1秒，将按原片时长输出`);
        }
        ffArgs = ['-y', '-loglevel', 'error', '-stats', '-t', String(targetDur),
          '-i', j.vidPath, '-i', srcForDur,
          '-filter_complex', '[1:v]setpts=PTS-STARTPTS[ov];[0:v][ov]overlay=0:0[outv]',
          '-map', '[outv]', '-map', '1:a?',
          '-c:v', 'h264_nvenc', '-preset', 'p4', '-rc', 'vbr', '-cq', '25',
          '-c:a', 'aac', '-b:a', '192k',
          j.outFile];
      }
      logger.clipDuration(targetDur);
      const { code } = await makeFfArgs(ffArgs, logger);
      if (code === 0 && exists(j.outFile)) {
        logger.info(`   ✅ 成片完成：${j.outFile}`);
        if (cfg.logDir) {
          const cfgName = cfg.mode === 2 ? '水印叠加' : j.theme;
          const d = taskDate(cfg.submitTs);
          const timeTag = `${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}时${pad(d.getMinutes())}分`;
          const logFile = path.join(cfg.logDir, `${timeTag}-${cfgName}-遮罩日志.txt`);
          if (!themeLogs.has(logFile)) {
            try { fs.mkdirSync(cfg.logDir, { recursive: true }); } catch (e) {}
            fs.writeFileSync(logFile, '', 'utf8');
            themeLogs.set(logFile, true);
          }
          const lines = [j.outName, '使用片段列表：', j.vidPath];
          if (cfg.mode !== 2) lines.push(j.maskPath);
          lines.push('', `@out: ${j.outFile}`, '', '='.repeat(46));
          fs.appendFileSync(logFile, lines.join('\r\n') + '\r\n', 'utf8');
        }
      } else {
        logger.fail(j.outName, `ffmpeg 退出码 ${code}`);
        hasError = true;
      }
    }
  } finally {
    if (cfg.mode === 1 && combineDir) {
      try { fs.rmSync(combineDir, { recursive: true, force: true }); } catch (e) {}
    }
    try { lock.release(); } catch (e) {}
    logger.lockReleased();
  }

  if (hasError) { logger.info(''); logger.info('脚本执行完成（有错误）'); return 1; }
  logger.info(''); logger.info('脚本完成');
  return 0;
}

module.exports = {
  id: 'mask',
  title: '遮罩叠加',
  envVars: ['MASK_*', 'VL_CACHE_DIR'],
  legacyScript: 'video_mask.ps1',
  run,
  // 供测试复用
  _internals: { readEnv, buildJobs, filterOnlyNames, scanByExts, getMaskDirName },
};
