// afterPack hook：在 NSIS 安装器生成前，对 win-unpacked 的主程序 exe 应用：
// 1) 应用图标（electron-builder 26 在 signAndEditExecutable:true 下未执行 exe 图标编辑，此处补 rcedit）
// 2) 版本资源（文件版本/产品版本 = package.json 版本）
// 3) 版权（去掉构建器默认的 GitHub/Electron 版权）与清空原始文件名
// 注：不再做版本信息二进制语言替换（曾内联改 en-US -> zh-CN 2052，对 electron 44 exe 会
//     误伤文件内碰巧匹配的字节导致渲染进程崩溃、窗口白屏；语言保持构建默认）
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

  console.log('afterPack: 已应用图标 + 版本 ' + pkg.version + ' + 版权 + 清原始文件名 -> ' + exePath);
};