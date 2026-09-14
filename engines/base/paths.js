// 路径与文本工具：对齐 PS1 版 Remove-Quotes / 编号提取 / 排序键语义
'use strict';

const path = require('node:path');
const fs = require('node:fs');

// 去引号：与 PS1 Remove-Quotes 一致（首尾同对单/双引号则剥除）
function stripQuotes(s) {
  const str = String(s == null ? '' : s).trim();
  if (str.length >= 2) {
    const f = str[0], l = str[str.length - 1];
    if ((f === '"' && l === '"') || (f === "'" && l === "'")) return str.slice(1, -1);
  }
  return str;
}

// 规范化：统一分隔符为 \（与 PS 一致的本地路径形态），去掉尾斜杠
function normalize(p) {
  let s = String(p == null ? '' : p);
  if (!s) return s;
  s = s.replace(/\//g, '\\');
  // 去掉 \\?\ 前缀差异
  if (s.startsWith('\\\\?\\')) s = s.slice(4);
  // 去尾部多余额外斜杠（保留盘符跟的斜杠）
  if (s.length > 3 && /[\\\/]$/.test(s)) s = s.replace(/[\\\/]+$/, '');
  return s;
}

const videoExts = new Set(['.mp4', '.mov', '.avi', '.mkv', '.m4v', '.wmv', '.flv', '.ts', '.webm']);
function isVideoExt(p) {
  return videoExts.has(path.extname(p).toLowerCase());
}

// 提取末尾数字序号：Get-NumberSuffix（无则空串）
function getNumberSuffix(p) {
  const b = path.basename(p);
  const m = /(\d+)(?=\.[^.]+$|$)/.exec(b);
  return m ? m[1] : '';
}

// mask 成片子文件夹名：剥掉末尾所有「-数字」段（后缀不参与剥除）
function getMaskDirName(outName) {
  let b = path.basename(outName, path.extname(outName));
  for (;;) {
    const before = b;
    b = b.replace(/-[0-9]+$/, '');
    if (b === before) break;
  }
  return b;
}

// Get-SortKey 语义：数字段补零前缀使自然排序（10 排在 2 后）
function sortKey(s) {
  return String(s).replace(/\d+/g, (m) => m.padStart(8, '0'));
}

// 存在性检查（不抛异常，兼容中文路径）
function exists(p) {
  try { return fs.existsSync(p); } catch (e) { return false; }
}

module.exports = { stripQuotes, normalize, isVideoExt, getNumberSuffix, getMaskDirName, sortKey, exists, videoExts };