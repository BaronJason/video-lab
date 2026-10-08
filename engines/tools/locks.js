// 工具类任务的互斥锁路径计算（后处理与画布合成共用）
//
// 为什么要独立成文件：两个执行器（steps 链 / 画布合成）都要按「本次运行实际会写入的目录」加锁，
// 而把这段放在任一方都会造成循环依赖（module ↔ canvasbatch）。
// 语义与三模块一致：**同一目录 → 同一把锁**，不同目录互不阻塞。
'use strict';

const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

/**
 * 本次运行的加锁目录：输出到指定目录时锁该目录，覆盖原文件时锁源文件所在目录
 * （文件可能分散在多个目录，取最上层公共目录；取不到则退回第一个文件所在目录）
 */
function lockDirFor(spec, files) {
  const mode = String((spec.output && spec.output.mode) || '');
  const outDir = String((spec.output && spec.output.dir) || '').trim();
  if (mode === 'directory' && outDir) return outDir;
  const dirs = files.map((f) => path.dirname(path.resolve(f)));
  if (!dirs.length) return '';
  if (dirs.length === 1) return dirs[0];
  let common = dirs[0].split(path.sep);
  for (const d of dirs.slice(1)) {
    const parts = d.split(path.sep);
    let i = 0;
    while (i < common.length && i < parts.length && common[i] === parts[i]) i++;
    common = common.slice(0, i);
  }
  const joined = common.join(path.sep);
  return joined || dirs[0];
}

/**
 * 锁文件路径 —— 必须落在**被处理目录之外**，两条原因：
 *   ① 锁文件落在输出目录里会把它变成"非空"，直接破坏「空目录 → 直接输出」规则
 *      （实测踩到：本该输出到空目录，结果被判定为非空而新建了子目录）
 *   ② 不在用户的视频目录里留下与业务无关的残留文件
 * 因此按目标目录路径生成稳定的锁名，锁文件统一放在数据目录的 `.locks` 下。
 */
function lockPathFor(dir) {
  const base = String(process.env.VL_STORAGE_DIR || '').trim() || os.tmpdir();
  const h = crypto.createHash('sha1').update(path.resolve(dir).toLowerCase()).digest('hex').slice(0, 16);
  return path.join(base, '.locks', 'tool-' + h + '.lock');
}

module.exports = { lockDirFor, lockPathFor };
