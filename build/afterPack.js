// afterPack hook：在 NSIS 安装器生成前，对 win-unpacked 的主程序 exe 应用：
// 1) 应用图标（electron-builder 26 在 signAndEditExecutable:true 下未执行 exe 图标编辑，此处补 rcedit）
// 2) 版本资源（文件版本/产品版本 = package.json 版本）
// 3) 版权（去掉构建器默认的 GitHub/Electron 版权）与清空原始文件名
// 4) 版本信息语言改为 中文(简体) 2052（替换 en-US translation 与 StringTable 键，属性页按中文显示）
'use strict';
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function findRcedit() {
  const root = path.join(process.env.LOCALAPPDATA || '', 'electron-builder', 'Cache', 'winCodeSign');
  const candidates = [];
  try {
    for (const d of fs.readdirSync(root)) {
      const exe = path.join(root, d, 'rcedit-x64.exe');
      if (fs.existsSync(exe)) candidates.push(exe);
    }
  } catch (e) {}
  if (!candidates.length) throw new Error('未找到 rcedit-x64.exe（electron-builder winCodeSign 缓存）');
  candidates.sort();
  return candidates[candidates.length - 1];
}

// 把版本信息语言从 en-US(1033) 改为 中文简体(2052)，等长替换不改变 PE 结构
function makeZhCn(exePath) {
  const data = fs.readFileSync(exePath);
  const oldTrans = Buffer.from([0x09, 0x04, 0xb0, 0x04]); // 1033(cp1192) -> 2052
  const newTrans = Buffer.from([0x04, 0x08, 0xb0, 0x04]);
  let changed = 0;

  // translation 数组（langid/codepage）
  let i = data.indexOf(oldTrans);
  while (i >= 0) {
    newTrans.copy(data, i);
    changed++;
    i = data.indexOf(oldTrans, i + 4);
  }

  // StringTable 键 040904b0（小写 UTF-16LE，rcedit 生成格式）
  const oldKey = Buffer.from('040904b0', 'utf16le');
  const newKey = Buffer.from('080404b0', 'utf16le');
  let k = data.indexOf(oldKey);
  while (k >= 0) {
    newKey.copy(data, k);
    changed++;
    k = data.indexOf(oldKey, k + oldKey.length);
  }

  if (changed) fs.writeFileSync(exePath, data);
  return changed;
}

module.exports = async function (context) {
  const appOutDir = context.appOutDir;
  const ico = path.join(context.packager.projectDir, 'icon', 'app-icon.ico');
  if (!fs.existsSync(ico)) throw new Error('应用图标不存在: ' + ico);
  const exePath = path.join(appOutDir, context.packager.appInfo.productFilename + '.exe');
  if (!fs.existsSync(exePath)) return;
  const rcedit = findRcedit();

  // 应用图标
  execFileSync(rcedit, [exePath, '--set-icon', ico], { stdio: 'ignore' });

  // 版本资源：文件/产品版本与 package.json 一致
  const pkg = require(path.join(context.packager.projectDir, 'package.json'));
  execFileSync(rcedit, [exePath, '--set-file-version', pkg.version, '--set-product-version', pkg.version], { stdio: 'ignore' });

  // 版本字符串：版权 + 清空原始文件名
  execFileSync(rcedit, [exePath, '--set-version-string', 'LegalCopyright', 'Copyright (C) Video Lab', '--set-version-string', 'OriginalFilename', ''], { stdio: 'ignore' });

  // 语言：en-US -> 中文简体
  const n = makeZhCn(exePath);
  console.log('afterPack: 已应用图标 + 版本 ' + pkg.version + ' + 版权 + 清原始文件名 + 语言 zh-CN(' + n + ') -> ' + exePath);
};