// afterPack hook：在 NSIS 安装器生成前，对 win-unpacked 的主程序 exe 应用应用图标
// （electron-builder 26 在 signAndEditExecutable:true 下未执行 exe 图标编辑，此处补 rcedit）
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
  execFileSync(rcedit, [exePath, '--set-icon', ico], { stdio: 'ignore' });
  console.log('afterPack: 已应用 exe 图标 -> ' + exePath);
};