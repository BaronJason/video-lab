// 缺失片段修复（三路）—— 对齐 video_replica.ps1 Resolve-FromVideoCache 语义：
//   1) 同目录同名候选（含数字后缀微调版本）
//   2) 回退目录 REPLICA_FALLBACK_DIR 内同名
//   3) video_cache 按文件名反查（同名副本均为同一片段，可换另一份路径）
// 硬约束：resolve 无法修复 → 该成片不生成（由调用方整片放弃）
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { exists } = require('./paths');

// candidates: [{ path, dir, base, seq }] 或直接字符串列表；fromCache: (fileName) => [paths]
function restructure({ origPath, fallbackDir, index }) {
  const base = path.basename(origPath);
  const dir = path.dirname(origPath);
  const seqMatch = /(\d+)(?=\.[^.]+$|$)/.exec(base);
  const seq = seqMatch ? seqMatch[1] : '';
  const nameNoExt = path.basename(origPath, path.extname(origPath));
  const nameNoSeq = nameNoExt.replace(/-?\d+$/, '');

  // 路1：同目录同名（目录内过滤：非旧水印、非已用）
  const sameDir = []; try {
    for (const f of fs.readdirSync(dir)) {
      if (!/\.(mp4|mov|avi|mkv)$/i.test(f)) continue;
      if (/旧水印/.test(f)) continue;
      sameDir.push(path.join(dir, f));
    }
  } catch (e) {}

  // 路2：回退目录同名
  const fallback = [];
  if (fallbackDir && exists(fallbackDir)) {
    try {
      for (const f of fs.readdirSync(fallbackDir)) {
        if (path.basename(f) === base || f === base) fallback.push(path.join(fallbackDir, f));
      }
    } catch (e) {}
  }

  // 路3：缓存按文件名反查
  const fromCache = (() => {
    const list = (index && index[base]) || (index && index[nameNoExt]) || [];
    return Array.isArray(list) ? list.filter((p) => fs.existsSync(p)) : [];
  })();

  return {
    sameDir: sameDir.filter((p) => fs.existsSync(p)),
    fallback,
    cache: fromCache,
    // 同目录数字后缀微调（原索引补位语义）：如 -1 → -10/-105
    seqCandidates: sameDir.filter((p) => {
      if (p === origPath) return false;
      const b = path.basename(p);
      const bNameNoSeq = b.replace(/\.[^.]+$/, '').replace(/-?\d+$/, '');
      return bNameNoSeq === nameNoSeq && (b !== base);
    }),
    base, dir, seq, nameNoExt,
  };
}

// 统一入口：返回 [{ path, how }] 的候选顺序；sameDir → fallback → cache → seqCandidates
function resolveMissing(origPath, { fallbackDir, index, used = [] } = {}) {
  const r = restructure({ origPath, fallbackDir, index });
  const usedSet = new Set(used);
  const out = [];
  const pushIf = (p) => { if (p && fs.existsSync(p) && !usedSet.has(p)) out.push(p); };
  for (const p of r.sameDir) pushIf(p);
  for (const p of r.fallback) pushIf(p);
  for (const p of r.cache) pushIf(p);
  for (const p of r.seqCandidates) pushIf(p);
  return out;
}

module.exports = { restructure, resolveMissing };