// -*- coding: utf-8 -*-
// Video Lab — Electron 主进程
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { app, BrowserWindow, ipcMain, dialog, shell, Menu, Tray, nativeImage, net, screen } = require('electron');
const { Api, DEFAULT_CONFIG } = require('./backend');

// 单实例锁：统一 userData 到固定全局路径（跨盘 / 开发版与打包版共享同一把锁），
// 使"同一时刻仅允许一个主进程实例"真正生效；重复打开时唤出现有实例主窗口
app.setPath('userData', path.join(os.homedir(), '.video-lab'));
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => showMainWindow());
}

// 版本形态判定：electron-builder portable 运行时注入 PORTABLE_EXECUTABLE_FILE；
// setup(NSIS) 安装版无该环境变量，且 resources 下存在 app-update.yml（第二重保险）——两者更新方式不同，据此分叉。
// 开发版（electron . / run.js）无上述特征，按便携形态处理。
const IS_PORTABLE = (() => {
  try {
    if (process.env.PORTABLE_EXECUTABLE_FILE) return true;
    return !fs.existsSync(path.join(process.resourcesPath, 'app-update.yml'));
  } catch (e) {
    return true;
  }
})();

// 开机自启动形态：由登录项以 --autostart 启动时静默到托盘并在后台预热工作目录，不打扰用户
const IS_AUTOSTART = process.argv.includes('--autostart');

function projectDir() {
  if (!app.isPackaged) return __dirname;
  // 便携版：取 electron-builder portable 注入的 exe 所在目录，不依赖文件夹名（目录可在任意层级）
  if (IS_PORTABLE) {
    const portableDir = process.env.PORTABLE_EXECUTABLE_DIR;
    if (portableDir && fs.existsSync(portableDir)) return path.resolve(portableDir);
    const portableFile = process.env.PORTABLE_EXECUTABLE_FILE;
    if (portableFile) return path.dirname(portableFile);
  }
  // setup 安装版：exe 所在目录即程序根（config/Cache/Scripts 同级定位）
  return path.dirname(process.execPath);
}
function configFilePath() { return configFile; }
function programConfigPath() { return path.join(projectDir(), 'config.json'); }
function appdataConfigPath() { return path.join(app.getPath('appData'), 'Video Lab', 'config.json'); }
// 启动时自动仲裁「配置和数据」的保存位置：
//  1) 两侧都无配置 → 默认程序目录（随后由 ensureConfig 打开启动引导窗口）
//  2) 两侧各有一份 → 取修改时间较新的一份生效，并删除旧的一份（防双份残留复发）
//  3) 配置在一侧、缓存在对侧 → 由 alignCacheToConfig 把缓存迁移回配置侧
function resolveConfigLocation() {
  const prog = programConfigPath();
  const appd = appdataConfigPath();
  const hasProg = (() => { try { return fs.existsSync(prog); } catch (e) { return false; } })();
  const hasAppd = (() => { try { return fs.existsSync(appd); } catch (e) { return false; } })();
  if (hasProg && hasAppd) {
    let progNewer = false;
    try { progNewer = fs.statSync(prog).mtimeMs >= fs.statSync(appd).mtimeMs; } catch (e) {}
    const chosen = progNewer ? prog : appd;
    const stale = progNewer ? appd : prog;
    try { fs.unlinkSync(stale); } catch (e) {} // 以新的一份为准并清理旧的
    pruneEmptyDirs();
    return chosen;
  }
  return hasAppd ? appd : prog;
}
let configFile = resolveConfigLocation();
// 切换配置保存位置：复制到目标位置并删除旧位置文件（迁移式，不留两份）
function moveConfigFile(target) {
  const src = configFile;
  if (path.resolve(target) === path.resolve(src)) return { ok: true, moved: false };
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (fs.existsSync(src)) fs.copyFileSync(src, target);
    try { if (fs.existsSync(src) && path.resolve(target) !== path.resolve(src)) fs.unlinkSync(src); } catch (e) {}
    configFile = target;
    pruneEmptyDirs();
    return { ok: true, moved: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
// 迁移 Cache：随「配置和数据保存位置」切换一并移动 Cache 文件夹，并同步缓存路径与 Api 引用
function moveCaches() {
  const newCache = path.dirname(configFilePath()) === path.dirname(appdataConfigPath()) ? appdataCacheDir() : cacheRootDir();
  if (path.resolve(newCache) === path.resolve(cacheDir)) return;
  try {
    if (fs.existsSync(cacheDir)) {
      fs.mkdirSync(newCache, { recursive: true });
      fs.cpSync(cacheDir, newCache, { recursive: true });
      fs.rmSync(cacheDir, { recursive: true, force: true });
    }
  } catch (e) {}
  cacheDir = newCache;
  scanCachePath = path.join(cacheDir, app.isPackaged ? 'scan_cache.json' : 'video_lab_scan_cache.json');
  videoCachePath = path.join(cacheDir, 'video_cache.json');
  logCachePath = path.join(cacheDir, app.isPackaged ? 'log_cache.json' : 'video_lab_log_cache.json');
  clipCachePath = path.join(cacheDir, app.isPackaged ? 'clip_cache.json' : 'video_lab_clip_cache.json');
  taskStatePath = path.join(cacheDir, app.isPackaged ? 'task_cache.json' : 'video_lab_task_cache.json');
  watermarkCachePath = path.join(cacheDir, app.isPackaged ? 'watermark_cache.json' : 'video_lab_watermark_cache.json');
  api.cachePath = scanCachePath;
  api.videoCachePath = videoCachePath;
  api.logCachePath = logCachePath;
  api.clipIndexCachePath = clipCachePath;
  api.taskStatePath = taskStatePath;
  api.watermarkCachePath = watermarkCachePath;
  // 清空内存缓存与扫描标记，避免旧路径数据残留重新落盘
  api._videoCache = null;
  api._logCache = null;
  api._logCacheRoot = '';
  api._videoInfoCache = new Map();
  api._scanCache = new Map();
  api._versionsCache = new Map();
  api._projectsCache = null;
  api._wmCache = null;
  api._wmCacheLoadedRoot = null;
  try { api._invalidateCaches(); } catch (e) {}
  pruneEmptyDirs();
}
function defaultRoot() { return path.dirname(projectDir()); }
function loadConfig() {
  const cfg = Object.assign({}, DEFAULT_CONFIG);
  try {
    const p = configFilePath();
    // 清理上次中断遗留的未完成临时配置（原文件不受影响）
    try { if (fs.existsSync(p + '.tmp')) fs.unlinkSync(p + '.tmp'); } catch (e2) {}
    if (fs.existsSync(p)) {
      const data = JSON.parse(fs.readFileSync(p, 'utf-8'));
      if (data && typeof data === 'object' && !Array.isArray(data)) Object.assign(cfg, data);
    }
  } catch (e) {}
  return cfg;
}
function saveConfig(config) {
  try {
    const dir = path.dirname(configFilePath());
    fs.mkdirSync(dir, { recursive: true });
    // 原子写：主配置写坏会丢设置与工作路径，先写临时文件再 rename 覆盖
    fs.writeFileSync(configFilePath() + '.tmp', JSON.stringify(config, null, 2), 'utf-8');
    fs.renameSync(configFilePath() + '.tmp', configFilePath());
  } catch (e) {
    try { if (fs.existsSync(configFilePath() + '.tmp')) fs.unlinkSync(configFilePath() + '.tmp'); } catch (e2) {}
  }
}
function resolveRoot(config) {
  const env = (process.env.TXT_MANAGER_ROOT || '').trim().replace(/^"|"$/g, '');
  if (env && fs.existsSync(env) && fs.statSync(env).isDirectory()) return env;
  if (config.root && fs.existsSync(config.root) && fs.statSync(config.root).isDirectory()) return config.root;
  return defaultRoot();
}

const config = loadConfig();
const root = resolveRoot(config);
// 缓存统一放「配置和数据的保存位置」下 Cache 子文件夹（打包版）；开发版放临时目录避免污染源码：
//   配置在程序目录 → Cache 在程序目录；配置在 AppData → Cache 也在 AppData（切换存储位置时一并迁移）
const cacheRootDir = () => (app.isPackaged ? path.join(projectDir(), 'Cache') : os.tmpdir());
const appdataCacheDir = () => path.join(app.getPath('appData'), 'Video Lab', 'Cache');
// 清理被搬空的空壳目录：仅当目录下无任何文件时才删除（用户手放的内容则保留）
function pruneEmptyDirs() {
  const appdataBase = path.join(app.getPath('appData'), 'Video Lab');
  for (const dir of [appdataBase, path.join(appdataBase, 'Cache')]) {
    try {
      if (!fs.existsSync(dir)) continue;
      if (fs.readdirSync(dir).length === 0) fs.rmSync(dir, { recursive: true, force: true });
    } catch (e) {}
  }
}
let cacheDir = (() => {
  const dir = path.dirname(configFilePath()) === path.dirname(appdataConfigPath()) ? appdataCacheDir() : cacheRootDir();
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
  return dir;
})();
// 启动时对齐「数据和配置」：配置在一侧、缓存在对侧时，把缓存整个迁回配置侧
//   （对侧无缓存或配置侧已有缓存则不动；api 尚未创建，迁移后路径 let 即为配置侧，后续 Api 直接用新路径）
function alignCacheToConfig() {
  if (!app.isPackaged) return;
  const target = cacheDir; // 配置侧
  const other = (path.resolve(cacheRootDir()) === path.resolve(target) ? appdataCacheDir() : cacheRootDir());
  if (path.resolve(other) === path.resolve(target)) return;
  const has = (p) => { try { return fs.readdirSync(p).length > 0; } catch (e) { return false; } };
  if (has(other) && !has(target)) {
    try {
      fs.mkdirSync(target, { recursive: true });
      fs.cpSync(other, target, { recursive: true });
      fs.rmSync(other, { recursive: true, force: true });
    } catch (e) {}
    pruneEmptyDirs();
  }
}
alignCacheToConfig();
// 三个缓存统一命名(下划线)且统一存放于 Cache 子文件夹：
//   scan_cache.json   —— TXT 指纹缓存
//   video_cache.json  —— 预检测(ffprobe)缓存
//   log_cache.json    —— 日志 txt 缓存（刷新配置时一并收集）
let scanCachePath = path.join(cacheDir, app.isPackaged ? 'scan_cache.json' : 'video_lab_scan_cache.json');
let videoCachePath = path.join(cacheDir, 'video_cache.json');
let logCachePath = path.join(cacheDir, app.isPackaged ? 'log_cache.json' : 'video_lab_log_cache.json');
// 成片名搜索缓存（仅存成片条目精简字段，目录 mtime 变化自动失效重建）
let clipCachePath = path.join(cacheDir, app.isPackaged ? 'clip_cache.json' : 'video_lab_clip_cache.json');
let taskStatePath = path.join(cacheDir, app.isPackaged ? 'task_cache.json' : 'video_lab_task_cache.json');
let watermarkCachePath = path.join(cacheDir, app.isPackaged ? 'watermark_cache.json' : 'video_lab_watermark_cache.json');
// 迁移旧任务快照命名（task_snapshot.json → task_cache.json）
(function migrateTaskCache() {
  const old = path.join(cacheDir, app.isPackaged ? 'task_snapshot.json' : 'video_lab_task_snapshot.json');
  if (old === taskStatePath || !fs.existsSync(old) || fs.existsSync(taskStatePath)) return;
  try { fs.copyFileSync(old, taskStatePath); fs.unlinkSync(old); } catch (e) {}
})();
// 迁移旧 scan 缓存命名（同目录内把旧的连字符命名改为下划线）；不含脚本目录缓存——脚本目录属用户个人数据，应用绝不读写
(function migrateOldScanCache() {
  const oldScan = path.join(cacheDir, app.isPackaged ? 'scan-cache.json' : 'video-lab-scan-cache.json');
  if (oldScan === scanCachePath || !fs.existsSync(oldScan) || fs.existsSync(scanCachePath)) return;
  try { fs.copyFileSync(oldScan, scanCachePath); fs.unlinkSync(oldScan); } catch (e) {}
})();
const api = new Api(root, config, scanCachePath, videoCachePath, logCachePath, path.join(projectDir(), 'resources', 'Scripts'), clipCachePath, taskStatePath, watermarkCachePath);
// 扫描/重建环节进度：推送主窗口渲染层实时状态（walk/收集日志/重建成片索引/水印统计 一一对应）
api.onScanProgress = (p) => {
  try {
    const w = (mainWin && !mainWin.isDestroyed()) ? mainWin : (BrowserWindow.getAllWindows()[0] || null);
    if (w && !w.isDestroyed()) w.webContents.send('scan_progress', p);
  } catch (e) {}
};

// 主窗口与任务窗口：主窗口仅在原生模态对话框/载入遮罩时被禁用；任务列表窗口不随父窗口禁用
let mainWin = null;
// 系统托盘：关闭主窗口仅最小化到托盘，右键托盘图标菜单可退出或显示主窗口
let tray = null;
let isQuitting = false;
let quitConfirmed = false; // 有运行中任务退出时，经主窗口确认后才真正退出
let settingsForceClose = false; // 应用退出路径：允许带未保存修改强制关闭设置窗口
let closeAskOpen = false; // 关闭主窗口行为引导弹窗打开中：避免重复弹窗/重复触发
// 配置未保存确认：关闭/退出前询问主窗口（覆盖当前配置/保存为当日配置/取消），避免修改丢失
let discardAskOpen = false;      // 「配置未保存确认」弹窗进行中，避免重复询问
let discardCloseHandled = false; // close 路径：未保存已确认（一次性，本次关闭不再询问）
let discardQuitHandled = false;  // quit 路径：未保存已确认（本次退出不再询问）
// 图标源文件（resources/app/icon/），托盘图标使用多分辨率适配不同缩放的任务栏
const ICON_DIR = path.join(__dirname, 'icon');
function trayIcon() {
  const img = nativeImage.createFromPath(path.join(ICON_DIR, 'tray-icon.png'));
  for (const rep of ['tray-icon@1.25x.png', 'tray-icon@1.5x.png', 'tray-icon@2x.png']) {
    img.addRepresentation(nativeImage.createFromPath(path.join(ICON_DIR, rep)));
  }
  return img.isEmpty() ? nativeImage.createEmpty() : img;
}
function showMainWindow() {
  if (!mainWin || mainWin.isDestroyed()) createWindow();
  mainWin.show();
  mainWin.focus();
}
function createTray() {
  if (!tray) {
    tray = new Tray(trayIcon());
    tray.setToolTip('Video Lab');
  }
  // 托盘菜单为自绘 HTML 窗口（跟随皮肤），左/右键均唤出；双击恢复主窗口
  tray.on('click', () => showTrayMenu());
  tray.on('right-click', () => showTrayMenu());
  tray.on('double-click', () => { hideTrayMenu(); showMainWindow(); });
}
// 自绘托盘菜单窗口：皮肤变量从主窗口实时读取注入（单一来源，避免皮肤定义重复漂移）；
// 高度按内容自适应，锚定托盘图标上方弹出，失去焦点自动收起
let trayMenuWin = null;
const TRAY_MENU_W = 200;
function hideTrayMenu() { if (trayMenuWin && !trayMenuWin.isDestroyed()) trayMenuWin.hide(); }
async function showTrayMenu() {
  const fresh = !trayMenuWin || trayMenuWin.isDestroyed();
  if (fresh) {
    trayMenuWin = new BrowserWindow({ width: TRAY_MENU_W, height: 60, show: false, frame: false, transparent: true, backgroundColor: '#00000000', resizable: false, movable: false, skipTaskbar: true, alwaysOnTop: true, fullscreenable: false, webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false } });
    trayMenuWin.setMenu(null);
    trayMenuWin.loadFile(path.join(__dirname, 'frontend', 'trayMenu.html'));
    trayMenuWin.on('blur', () => { if (trayMenuWin && !trayMenuWin.isDestroyed()) trayMenuWin.hide(); });
    trayMenuWin.on('closed', () => { trayMenuWin = null; });
    await new Promise((res) => { const t = setTimeout(res, 3000); trayMenuWin.webContents.once('did-finish-load', () => { clearTimeout(t); res(); }); });
  }
  // 注入当前皮肤变量（从主窗口 computed style 读取，与界面完全一致）
  try {
    const cssText = await mainWin.webContents.executeJavaScript(`(function(){
      var s=getComputedStyle(document.documentElement);
      var names=['--bg-base-default','--text-default','--text-secondary','--border-neutral-l1','--bg-overlay-l2','--radius-6','--radius-8','--body-base-font-size'];
      var p=names.map(function(n){var v=s.getPropertyValue(n).trim();return v?(n+':'+v):null;}).filter(Boolean).join(';');
      return p;
    })()`);
    if (cssText) await trayMenuWin.webContents.executeJavaScript("document.getElementById('skinVars').textContent=':root{" + cssText + "}';");
  } catch (e) {}
  // 检查更新项仅 UPDATE_ENABLED 时显示
  const updJs = "(function(){var on=" + (UPDATE_ENABLED ? 'true' : 'false') + ";var b=document.getElementById('btnUpdate'),s=document.getElementById('sepUpdate');if(b)b.style.display=on?'':'none';if(s)s.style.display=on?'':'none';})();";
  try { await trayMenuWin.webContents.executeJavaScript(updJs); } catch (e) {}
  // 高度按内容自适应（避免固定高裁切/留白）
  try {
    const h = await trayMenuWin.webContents.executeJavaScript("document.getElementById('trayMenu').offsetHeight");
    trayMenuWin.setContentSize(TRAY_MENU_W, Math.max(50, Number(h) || 50));
  } catch (e) {}
  // 定位：以鼠标指针为锚点，菜单从鼠标右上紧贴弹出（右边界贴 x、下边界贴 y）；
  // 钳制按整屏 bounds（允许覆盖任务栏区域），越界时再就近收拢
  let mx = 0, my = 0;
  try { const c = screen.getCursorScreenPoint(); mx = c.x; my = c.y; } catch (e) {}
  const disp = screen.getDisplayNearestPoint({ x: mx, y: my });
  const bd = disp.bounds;
  const [w, h] = trayMenuWin.getSize();
  let x = mx;                 // 默认从鼠标向右展开
  let y = my - h;             // 菜单底部贴住鼠标（弹出在鼠标上方）
  if (x + w > bd.x + bd.width) x = bd.x + bd.width - w; // 右侧越界改向左收拢
  if (x < bd.x) x = bd.x;
  if (y < bd.y) y = bd.y;
  trayMenuWin.setPosition(Math.round(x), Math.round(y));
  trayMenuWin.show();
  trayMenuWin.focus();
}
// 任务窗口：显示所有生成任务的状态与实时日志
let taskWin = null;
function createTaskWindow() {
  if (taskWin && !taskWin.isDestroyed()) { taskWin.focus(); return taskWin; }
  taskWin = new BrowserWindow({ title: 'Video Lab - 任务', width: 760, height: 620, resizable: false, maximizable: false, minimizable: false, frame: false, webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false } });
  taskWin.loadFile(path.join(__dirname, 'frontend', 'task.html'));
  taskWin.on('closed', () => { taskWin = null; });
  return taskWin;
}
// 设置窗口：独立的设置页（通用设置 / 批量拼接 / 视频复刻）
let settingsWin = null;
function openSettingsWindow() {
  if (settingsWin && !settingsWin.isDestroyed()) { settingsWin.focus(); return settingsWin; }
  // 点击设置按钮时立即让主窗口显示模糊遮罩，与设置窗口出现同步，避免突兀
  if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('settings_window_opened');
  settingsWin = new BrowserWindow({ title: 'Video Lab - 设置', width: 680, height: 640, resizable: false, maximizable: false, minimizable: false, parent: mainWin, frame: false, webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false } });
  settingsWin.loadFile(path.join(__dirname, 'frontend', 'settings.html'));
  settingsWin.on('blur', handleSettingsBlur);
  // 关闭按钮/X：有未保存修改时拦截，通知设置页在关闭按钮上方弹「取消/确认退出」二级菜单（应用退出路径不受此限制）
  settingsWin.on('close', (e) => {
    if (settingsForceClose || !settingsDirty) return;
    e.preventDefault();
    try {
      if (!settingsWin.isDestroyed() && settingsWin.webContents && !settingsWin.webContents.isDestroyed()) {
        settingsWin.webContents.send('confirm_discard_request');
      }
    } catch (err) {}
  });
  settingsWin.on('closed', () => {
    settingsWin = null; settingsDirty = false; settingsPickingDir = false;
    try {
      if (mainWin && !mainWin.isDestroyed() && mainWin.webContents && !mainWin.webContents.isDestroyed()) {
        mainWin.webContents.send('settings_window_closed');
      }
    } catch (e) {}
  });
  return settingsWin;
}
// 设置窗口失焦处理：alt+Tab 切到其他应用时不关闭；
// 仅当用户点击了主窗口区域（失焦后主窗口重新获得焦点）时，未修改才关闭、有修改则报错音+闪红提醒
let settingsDirty = false;
let settingsPickingDir = false;
function sysBeep() {
  try {
    const { spawn } = require('child_process');
    const p = spawn('pwsh', ['-NoProfile', '-Command', '[System.Media.SystemSounds]::Exclamation.Play()'], { stdio: 'ignore', detached: true });
    p.unref();
  } catch (e) {}
}
function handleSettingsBlur() {
  if (!settingsWin || settingsWin.isDestroyed() || settingsPickingDir || settingsForceClose) return;
  setTimeout(function () {
    if (!settingsWin || settingsWin.isDestroyed() || settingsForceClose) return;
    // 焦点未落在主窗口（切到了其他应用/任务窗口等场景）→ 设置窗口保持打开
    if (!mainWin || mainWin.isDestroyed() || !mainWin.isFocused()) return;
    if (settingsDirty) {
      sysBeep();
      try { settingsWin.webContents.send('settings_flash_close'); } catch (e) {}
    } else {
      settingsWin.close();
    }
  }, 160);
}
// 任务快照变化时推送给所有窗口（主窗口按钮计数 + 任务窗口列表）
function sendTasksToAll() {
  const tasks = api.snapshotTasks();
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send('task_update', tasks);
}
api.onTasksChanged = sendTasksToAll;
// 配置文件写操作（保存/清理/迁移）广播：前端据此即时自愈版本列表、日期分支与侧栏徽章
function sendVersionsChangedToAll() {
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send('versions_changed');
}
api.onVersionsChanged = sendVersionsChangedToAll;

// ═══ 自动更新 ═══ 启动/设置页/托盘触发检查，主窗口提示条由用户确认后下载
// 便携版：仅检查+下载，更新包放到程序根目录，由用户在资源管理器中打开后自行关闭应用解压；
// 自动安装（apply_update / 更新器脚本）代码保留，供 setup 安装版接入使用
const UPDATE_ENABLED = true;
const GITHUB_REPO = 'BaronJason/video-lab';
const GITEE_REPO = 'hirannu/video-lab';
const UPDATE_API_URL = 'https://api.github.com/repos/' + GITHUB_REPO + '/releases/latest';
// 码云 release 检查地址（GitHub 同款 API 结构：tag_name + assets[]）
const GITEE_API_URL = 'https://gitee.com/api/v5/repos/' + GITEE_REPO + '/releases/latest';
// 当前更新源（跟随设置 update_source，动态切换 GitHub / 码云）
function currentUpdateSource() {
  return (loadConfig().update_source === 'github') ? 'github' : 'gitee';
}
// 根据更新源生成检查地址：码云直连不打加速前缀，GitHub 走原加速链
function updateCheckUrls() {
  if (currentUpdateSource() === 'github') return accelUrls(UPDATE_API_URL);
  return [GITEE_API_URL];
}
// GitHub 加速前缀链：许多机器直连 GitHub 慢/不稳，更新检查与下载按序尝试各加速站（实测
// gh-proxy.com 最快），全部不可达最后回退直连；增删/换加速站只需改 UPDATE_PROXIES
const UPDATE_PROXIES = ['https://gh-proxy.com', 'https://gh-proxy.org'];
// setup 安装版 electron-updater 的 generic 发布源（对应 package.json 的 publish.url）
const UPDATE_PUBLISH_URL = 'https://github.com/' + GITHUB_REPO + '/releases/latest/download';
// 目标为 GitHub 官方域名时生成 [加速1, 加速2, …, 直连] 候选列表，其他地址原样返回单元素
function accelUrls(url) {
  if (url && (url.indexOf('https://github.com/') === 0 || url.indexOf('https://api.github.com/') === 0)) {
    const out = UPDATE_PROXIES.map((p) => p + '/' + url);
    out.push(url);
    return out;
  }
  return [url];
}
const APP_VERSION = (function () { try { return require('./package.json').version || '0.0.0'; } catch (e) { return '0.0.0'; } })();
let lastUpdateInfo = null; // 最近一次检查结果（含资产信息，供确认后下载使用）
let updateBusy = false;    // 检查/下载互斥锁：同一时刻仅允许一个更新操作在跑

function cmpVersion(a, b) {
  const pa = String(a || '').replace(/^v/i, '').split('.').map((x) => parseInt(x, 10) || 0);
  const pb = String(b || '').replace(/^v/i, '').split('.').map((x) => parseInt(x, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x !== y) return x - y;
  }
  return 0;
}
function sendToMain(channel, payload) {
  try { if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send(channel, payload); } catch (e) {}
}
function sendToSettings(channel, payload) {
  try { if (settingsWin && !settingsWin.isDestroyed()) settingsWin.webContents.send(channel, payload); } catch (e) {}
}
// 更新链路日志（Cache/update.log），便于排查检查/下载问题
function writeUpdateLog(line) {
  try {
    const dir = path.join(cacheDir, 'update');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'update.log'), '[' + new Date().toISOString() + '] ' + line + '\r\n', 'utf-8');
  } catch (e) {}
}
// Electron net 请求：走 Chromium 网络栈（跟随系统代理），自动跟随重定向
function netGet(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    let req;
    try { req = net.request({ url, method: 'GET', redirect: 'follow' }); } catch (e) { reject(e); return; }
    const timer = setTimeout(() => { try { req.abort(); } catch (e2) {} reject(new Error('请求超时')); }, timeoutMs || 15000);
    req.on('response', (res) => {
      const chunks = [];
      const headers = res.headers || {};
      res.on('data', (chunk) => { chunks.push(chunk); });
      res.on('end', () => {
        clearTimeout(timer);
        resolve({
          status: res.statusCode,
          headers,
          body: Buffer.concat(chunks),
          get(key) { const v = headers[String(key).toLowerCase()]; return Array.isArray(v) ? v[0] : (v == null ? '' : String(v)); }
        });
      });
      res.on('error', (e) => { clearTimeout(timer); reject(e); });
    });
    req.on('error', (e) => { clearTimeout(timer); reject(e); });
    req.end();
  });
}
// 带断点续传的流式下载：支持 HTTP Range 续传（206）、已完整（416）、错误页拦截；
// 中断时保留已下载部分文件，供重试 / 下次继续
function netDownload(url, dst, onProgress, expectedSize) {
  return new Promise((resolve, reject) => {
    let start = 0;
    try { start = fs.existsSync(dst) ? fs.statSync(dst).size : 0; } catch (e) { start = 0; }
    let req;
    try { req = net.request({ url, method: 'GET', redirect: 'follow', headers: start > 0 ? { 'Range': 'bytes=' + start + '-' } : {} }); } catch (e) { reject(e); return; }
    const timer = setTimeout(() => { try { req.abort(); } catch (e2) {} reject(new Error('下载超时')); }, 120000);
    req.on('response', (res) => {
      const h = res.headers || {};
      const status = res.statusCode || 0;
      if (status >= 400) { clearTimeout(timer); reject(new Error('HTTP ' + status)); return; }
      if (status === 416) { clearTimeout(timer); resolve({ ok: true, complete: true }); return; } // 范围超出 = 文件已完整
      const cl = Array.isArray(h['content-length']) ? h['content-length'][0] : (h['content-length'] == null ? '' : String(h['content-length']));
      let total = expectedSize || parseInt(cl, 10) || 0;
      const resume = start > 0 && status === 206;
      if (resume) {
        const cr = h['content-range'];
        const crv = Array.isArray(cr) ? cr[0] : cr;
        const m = crv ? /(\d+)\/(\d+|\*)/.exec(String(crv)) : null;
        if (m && m[2] !== '*') total = parseInt(m[2], 10) || total;
      }
      let received = resume ? start : 0;
      const ws = fs.createWriteStream(dst, { flags: resume ? 'a' : 'w' });
      ws.on('error', (e) => { clearTimeout(timer); reject(e); });
      res.on('data', (chunk) => { ws.write(chunk); received += chunk.length; if (total && onProgress) onProgress(Math.min(100, Math.round((received / total) * 100))); });
      res.on('end', () => { ws.end(); });
      res.on('error', (e) => { clearTimeout(timer); reject(e); }); // 中断：保留部分文件供续传
      ws.on('finish', () => { clearTimeout(timer); resolve({ ok: true, size: received }); });
    });
    req.on('error', (e) => { clearTimeout(timer); reject(e); });
    req.end();
  });
}
// 检查更新：silent=true 时不打扰（启动自动检查）；notifyMain=false 表示来源为设置页（主窗口不弹「发现新版本」，下载完成后才弹操作条）
async function checkForUpdate(opts) {
  if (!UPDATE_ENABLED) return { ok: false, current: APP_VERSION, latest: '', hasUpdate: false, url: '', size: 0, error: '自动更新已停用' };
  const silent = !!(opts && opts.silent);
  const notifyMain = !opts || opts.notifyMain !== false;
  if (updateBusy) {
    const busyInfo = { ok: false, busy: true, current: APP_VERSION, latest: '', hasUpdate: false, url: '', size: 0, error: '已有更新操作进行中，请稍候' };
    // 托盘等非静默入口：把「进行中」提示发到主窗口状态栏
    if (!silent && notifyMain) sendToMain('update_error', busyInfo);
    return busyInfo;
  }
  const t0 = Date.now();
  try {
    let res = null;
    let accelErr = '';
    for (const cand of updateCheckUrls()) {
      try {
        res = await netGet(cand, 10000);
        if (res.status === 200) break;
        throw new Error('HTTP ' + res.status);
      } catch (e2) {
        res = null;
        accelErr = (e2 && e2.message) || String(e2);
        writeUpdateLog('检查源不可用：' + cand + ' → ' + accelErr);
      }
    }
    if (!res) throw new Error(accelErr || '检查更新失败');
    const data = JSON.parse(res.body.toString('utf-8'));
    const tag = String(data.tag_name || '').replace(/^v/i, '');
    const assets = Array.isArray(data.assets) ? data.assets : [];
    // 优先匹配正式便携包资产（Video-Lab-<版本>-x64-Portable.zip）；
    // Gitee / GitHub 会自动附带源码归档（如 v1.4.6.zip），须排除以免误下载源码包
    // Gitee 分卷场景：便携 zip 超 100MB 上传不了，按 xxx.zip.001/.002 分卷上传，
    // 无单包时收集同组全部分卷（序号连续、≥2 卷）供下载后拼回完整 zip
    const portableRe = /^Video-Lab-.*-x64-Portable\.zip$/i;
    const partRe = /^(Video-Lab-.*-x64-Portable\.zip)\.(\d{3,})$/i;
    let asset = assets.find((a) => portableRe.test(String(a.name || ''))) || null;
    let parts = [];
    if (!asset) {
      const group = new Map();
      for (const a of assets) {
        const m = partRe.exec(String(a.name || ''));
        if (!m) continue;
        const key = m[1].toLowerCase();
        if (!group.has(key)) group.set(key, []);
        group.get(key).push({ name: a.name, url: a.browser_download_url, size: a.size || 0, index: parseInt(m[2], 10) });
      }
      for (const list of group.values()) {
        list.sort((x, y) => x.index - y.index);
        if (list.length >= 2 && list.every((p, i) => p.index === list[0].index + i)) { parts = list; break; }
      }
    }
    // release 资产的 digest 为 sha256:<hex>，作为下载完整性校验依据（分卷组一般无 digest）
    const sha256 = (asset && asset.digest && String(asset.digest).replace(/^sha256:/i, '')) || '';
    const hasUpdate = cmpVersion(tag, APP_VERSION) > 0;
    const info = {
      ok: true, current: APP_VERSION, latest: tag || '', hasUpdate,
      url: asset ? asset.browser_download_url : (parts.length ? parts[0].url : ''),
      size: asset ? asset.size : parts.reduce((s, p) => s + (p.size || 0), 0),
      parts, sha256, error: ''
    };
    lastUpdateInfo = info;
    writeUpdateLog('检查成功：current=' + APP_VERSION + ' latest=v' + tag + ' hasUpdate=' + hasUpdate + ' (' + (Date.now() - t0) + 'ms)');
    if (hasUpdate) {
      if (!silent) sendToSettings('check_update_result', info);
      if (asset && notifyMain) sendToMain('update_available', info);
      else if (!silent && notifyMain) sendToMain('update_none', Object.assign({}, info, { message: '发现新版本，但 Release 缺少便携包' }));
    } else {
      if (!silent) sendToSettings('check_update_result', info);
      if (!silent && notifyMain) sendToMain('update_none', info);
    }
    return info;
  } catch (e) {
    const msg = e.message || String(e);
    writeUpdateLog('检查失败：' + msg + ' (' + (Date.now() - t0) + 'ms)');
    const info = { ok: false, current: APP_VERSION, latest: '', hasUpdate: false, url: '', size: 0, error: msg, silent };
    lastUpdateInfo = info;
    if (!silent && notifyMain) { sendToMain('update_error', info); sendToSettings('check_update_result', info); }
    else if (!silent) sendToSettings('check_update_result', info);
    return info;
  }
}
// 下载最新便携包到程序根目录（便携版：用户自行关闭应用后解压覆盖），进度 % 经 onProgress 回报
// 计算文件 sha256（hex 小写），用于下载完整性校验（优先哈希，字节数兜底）
function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const crypto = require('crypto');
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (d) => hash.update(d));
    stream.on('end', () => resolve(hash.digest('hex').toLowerCase()));
    stream.on('error', reject);
  });
}
// 下载最新便携包到程序根目录（便携版：用户自行关闭应用后解压覆盖）。
// 支持断点续传 + 自动重试（共 4 次尝试）：网络中断保留部分文件续传，哈希校验失败清空重下
async function downloadUpdate(info, onProgress, onStatus) {
  const dir = projectDir();
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
  const zipPath = path.join(dir, 'Video-Lab-' + String(info.latest || '').replace(/^v/i, '') + '-x64-Portable.zip');
  // Gitee 分卷：逐卷下载到 zipPath.partXXX 后拼回完整 zip
  if (info.parts && info.parts.length > 0) return downloadUpdateParts(info, zipPath, onProgress, onStatus);
  const t0 = Date.now();
  let lastErr = '';
  for (let attempt = 1; attempt <= 4; attempt++) {
    if (onStatus) {
      if (attempt === 1) onStatus('正在下载更新（首次尝试）…');
      else onStatus('下载中断，正在重试（' + attempt + '/4）…');
    }
    try {
      let dl = null;
      let accelErr = '';
      for (const cand of accelUrls(info.url)) {
        try {
          dl = await netDownload(cand, zipPath, onProgress, info.size);
          accelErr = '';
          break;
        } catch (ep) {
          accelErr = (ep && ep.message) || String(ep);
          writeUpdateLog('下载源不可用：' + cand + ' → ' + accelErr);
        }
      }
      if (!dl) throw new Error(accelErr || '下载失败');
      if (dl.complete) return { ok: true, zipPath };
      const size = (() => { try { return fs.statSync(zipPath).size; } catch (e) { return 0; } })();
      // 完整性：优先 sha256（release 资产 digest），无则退回字节数比对
      if (info.sha256) {
        if (onStatus) onStatus('正在校验更新包完整性…');
        const actual = await sha256File(zipPath);
        if (actual !== String(info.sha256).toLowerCase()) throw new Error('哈希校验失败：期望 ' + String(info.sha256).slice(0, 12) + '… 实际 ' + actual.slice(0, 12) + '…');
      } else if (info.size && size !== info.size) {
        throw new Error('下载大小不匹配：' + size + '/' + info.size);
      }
      writeUpdateLog('下载完成：' + size + ' 字节，校验通过（尝试 ' + attempt + '/4，' + (Date.now() - t0) + 'ms）');
      return { ok: true, zipPath };
    } catch (e) {
      lastErr = (e && e.message) || String(e);
      writeUpdateLog('下载失败（尝试 ' + attempt + '/4）：' + lastErr);
      if (/哈希校验失败/.test(lastErr)) { try { fs.unlinkSync(zipPath); } catch (u) {} } // 校验失败：清空重下（续传可能延续损坏）
      if (attempt < 4) { if (onStatus) onStatus('下载失败（' + lastErr + '），正在重试…'); await new Promise((r) => setTimeout(r, 1500)); } // 间隔后重试（断点续传）
    }
  }
  writeUpdateLog('下载失败：' + lastErr);
  return { ok: false, error: lastErr };
}
// Gitee 分卷下载：info.parts 为同一便携 zip 的 .001/.002… 分卷（已按序号排序），
// 逐卷经断点续传下载到 zipPath.partXXX，全部完成后按序拼回 zipPath 并校验总大小
async function downloadUpdateParts(info, zipPath, onProgress, onStatus) {
  const parts = info.parts;
  const total = info.size || parts.reduce((s, p) => s + (p.size || 0), 0);
  const partDst = (p) => zipPath + '.part' + String(p.index).padStart(3, '0');
  const t0 = Date.now();
  let lastErr = '';
  for (let attempt = 1; attempt <= 4; attempt++) {
    if (onStatus) onStatus(attempt === 1 ? '正在下载更新分卷（' + parts.length + ' 卷）…' : '分卷下载中断，正在重试（' + attempt + '/4）…');
    try {
      // 逐卷下载（netDownload 自带断点续传，中断保留局部继续）
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        const dst = partDst(part);
        let dl = null, accelErr = '';
        for (const cand of accelUrls(part.url)) {
          try {
            dl = await netDownload(cand, dst, function () {
              try {
                const done = parts.slice(0, i).reduce((s, p) => s + (p.size || 0), 0) + fs.statSync(dst).size;
                if (total && onProgress) onProgress(Math.min(100, Math.round((done / total) * 100)));
              } catch (e) {}
            }, part.size || 0);
            accelErr = '';
            break;
          } catch (ep) {
            accelErr = (ep && ep.message) || String(ep);
            writeUpdateLog('分卷下载源不可用：' + cand + ' → ' + accelErr);
          }
        }
        if (!dl) throw new Error(accelErr || ('分卷下载失败：' + part.name));
      }
      // 按序拼接成完整 zip
      const ws = fs.createWriteStream(zipPath, { flags: 'w' });
      for (const part of parts) {
        const buf = fs.readFileSync(partDst(part));
        await new Promise((resolve, reject) => ws.write(buf, (err) => (err ? reject(err) : resolve())));
      }
      await new Promise((resolve) => ws.end(resolve));
      // 清理分卷临时文件
      for (const part of parts) { try { fs.unlinkSync(partDst(part)); } catch (e) {} }
      const size = (() => { try { return fs.statSync(zipPath).size; } catch (e) { return 0; } })();
      if (total && size !== total) throw new Error('分卷合并后大小不匹配：' + size + '/' + total);
      if (info.sha256) {
        if (onStatus) onStatus('正在校验更新包完整性…');
        const actual = await sha256File(zipPath);
        if (actual !== String(info.sha256).toLowerCase()) throw new Error('哈希校验失败：期望 ' + String(info.sha256).slice(0, 12) + '… 实际 ' + actual.slice(0, 12) + '…');
      }
      writeUpdateLog('分卷下载合并完成：' + size + ' 字节，校验通过（尝试 ' + attempt + '/4，' + (Date.now() - t0) + 'ms）');
      return { ok: true, zipPath };
    } catch (e) {
      lastErr = (e && e.message) || String(e);
      writeUpdateLog('分卷下载失败（尝试 ' + attempt + '/4）：' + lastErr);
      if (/哈希校验失败/.test(lastErr)) { try { fs.unlinkSync(zipPath); } catch (u) {} }
      if (attempt < 4) { if (onStatus) onStatus('分卷下载失败（' + lastErr + '），正在重试…'); await new Promise((r) => setTimeout(r, 1500)); }
    }
  }
  writeUpdateLog('分卷下载失败：' + lastErr);
  return { ok: false, error: lastErr };
}
// 内嵌更新器脚本：等待旧进程退出 → 解压 → 覆盖运行目录（排除用户数据）→ 重启
const UPDATE_SCRIPT_TPL = [
  '# -*- coding: utf-8 -*-',
  '# Video Lab 更新器：由主进程拉起后接管安装（旧进程退出后执行）',
  'param(',
  '  [string]$Target,',
  '  [string]$Zip,',
  '  [string]$ExeName',
  ')',
  '$ErrorActionPreference = \'Continue\'',
  '$logDir = Join-Path $Target \'Cache\'',
  'New-Item -ItemType Directory -Force -Path $logDir | Out-Null',
  '$log = Join-Path $logDir \'update.log\'',
  'function Log($m) { try { Add-Content -Path $log -Value (\'[{0}] {1}\' -f (Get-Date -Format \'yyyy-MM-dd HH:mm:ss\'), $m) -Encoding UTF8 } catch {} }',
  'Log (\'目标目录: \' + $Target)',
  'Log (\'更新包: \' + $Zip)',
  '# 1. 等待旧进程完全退出（最多 120 秒）',
  '$base = [System.IO.Path]::GetFileNameWithoutExtension($ExeName)',
  'for ($i = 0; $i -lt 120; $i++) {',
  '  $any = Get-Process -Name $base -ErrorAction SilentlyContinue',
  '  if (-not $any) { break }',
  '  Start-Sleep -Milliseconds 1000',
  '}',
  'if (Get-Process -Name $base -ErrorAction SilentlyContinue) {',
  '  Log \'旧进程未在 120 秒内退出，放弃更新\'',
  '  [Console]::Beep(600, 400)',
  '  exit 1',
  '}',
  '# 2. 解压到临时目录',
  '$tmp = Join-Path ([System.IO.Path]::GetTempPath()) (\'vl-update-\' + [guid]::NewGuid().ToString(\'N\'))',
  'try { Expand-Archive -Path $Zip -DestinationPath $tmp -Force } catch {',
  '  Log (\'解压失败: \' + $_.Exception.Message)',
  '  [Console]::Beep(400, 600)',
  '  exit 1',
  '}',
  '# 3. 镜像覆盖运行目录（排除 Cache 与 config.json 用户数据）',
  'robocopy $tmp $Target /MIR /R:3 /W:2 /XD Cache config.json /NFL /NDL /NJH /NJS /NP',
  '$code = $LASTEXITCODE',
  'if ($code -ge 8) {',
  '  Log (\'复制失败 robocopy=\' + $code)',
  '  [Console]::Beep(400, 600)',
  '  exit 1',
  '}',
  '# 4. 清理临时目录',
  'try { Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue } catch {}',
  '# 5. 重启应用',
  '$exe = Join-Path $Target $ExeName',
  'if (Test-Path $exe) { Start-Process -FilePath $exe } else {',
  '  Log (\'未找到可执行文件: \' + $exe)',
  '  [Console]::Beep(400, 600)',
  '  exit 1',
  '}',
  'Log \'更新完成\'',
  'Write-Host \'脚本完成，等待10s后退出\'',
  'Start-Sleep -Seconds 10',
  '[Environment]::Exit(0)'
].join('\r\n');
let lastDownload = null; // 已下载但未安装的更新包 { zipPath, info }，等待用户二次确认（UPDATE_ENABLED 下使用）

// ═══ setup 安装版更新（electron-updater）═══
// 检测环节复用上方 GitHub API 的 checkForUpdate；下载/安装阶段经 electron-updater：
// 下载时读 resources/app-update.yml（publish provider=generic）→ 拉取 latest.yml → 下载 setup 安装包；
// 安装时 quitAndInstall 静默升级（NSIS /S）后自动重启。仅 setup 版 require，便携版不加载。
function setupUpdater() {
  try { return require('electron-updater').autoUpdater; } catch (e) { return null; }
}
// setup 安装版下载：electron-updater 检查并下载 setup 安装包（调用方 startUpdate 负责互斥锁与已下载复用）
async function runSetupStartUpdate() {
  const au = setupUpdater();
  if (!au) return { ok: false, error: '未加载 electron-updater 模块' };
  au.autoDownload = false;
  au.autoInstallOnAppQuit = false;
  try {
    au.removeAllListeners('download-progress');
    au.removeAllListeners('update-downloaded');
    au.removeAllListeners('error');
  } catch (e) {}
  au.on('download-progress', (p) => {
    const percent = Math.min(100, Math.max(0, Math.round((p && p.percent) || 0)));
    const latestInfo = (au.updateInfoAndProvider && au.updateInfoAndProvider.result) ? au.updateInfoAndProvider.result.version : '';
    sendToMain('update_downloading', { percent, bytesPerSecond: p && p.bytesPerSecond, current: APP_VERSION, latest: latestInfo });
  });
  au.on('update-downloaded', () => {});
  au.on('error', (e) => { writeUpdateLog('electron-updater: ' + (e && e.message)); sendToMain('update_error', { message: e && e.message }); });
  // 更新源走加速地址（首选 gh-proxy.com）：latest.yml 与安装包都经加速站拉取（generic 源），失败不影响默认源
  try {
    const feedUrl = accelUrls(UPDATE_PUBLISH_URL)[0];
    au.setFeedURL({ provider: 'generic', url: feedUrl });
    writeUpdateLog('setup 更新源：' + feedUrl);
  } catch (ef) {
    writeUpdateLog('setup 设置加速更新源失败（继续使用默认源）：' + ((ef && ef.message) || String(ef)));
  }
  try {
    const r = await au.checkForUpdates();
    const latest = r && r.updateInfo ? String(r.updateInfo.version || '') : '';
    writeUpdateLog('setup 检查：latest=' + latest + ' current=' + APP_VERSION);
    if (!latest || cmpVersion(latest, APP_VERSION) <= 0) {
      sendToMain('update_none', { current: APP_VERSION, latest });
      return { ok: false, error: '暂无可用更新' };
    }
    await au.downloadUpdate();
    lastDownload = { zipPath: au.downloadedUpdateFilePath || '', info: { current: APP_VERSION, latest } };
    writeUpdateLog('setup 更新包下载完成：v' + latest);
    sendToMain('update_downloaded', { ok: true, current: APP_VERSION, latest });
    return { ok: true, downloaded: true };
  } catch (e) {
    const m = (e && e.message) || String(e);
    writeUpdateLog('setup 更新失败：' + m);
    sendToMain('update_error', { message: '下载更新失败：' + m });
    return { ok: false, error: m };
  }
}
function setupApplyUpdate() {
  const au = setupUpdater();
  if (!au) return { ok: false, error: '未加载 electron-updater 模块' };
  sendToMain('update_ready', { current: APP_VERSION });
  try {
    au.autoInstallOnAppQuit = true;
    isQuitting = true;
    au.quitAndInstall();
    return { ok: true };
  } catch (e) {
    writeUpdateLog('quitAndInstall 失败：' + e.message);
    return { ok: false, error: e.message };
  }
}

// 用户点击「立即更新」：仅下载更新包（两步式第一步，需 UPDATE_ENABLED）。
// 统一互斥：同一时刻仅一个下载；已有下载完成的更新包直接复用不重复下载
async function startUpdate() {
  if (!UPDATE_ENABLED) return { ok: false, error: '自动更新已停用' };
  if (lastDownload) {
    sendToMain('update_downloaded', lastDownload.info || { ok: true, current: APP_VERSION });
    return { ok: true, downloaded: true };
  }
  if (updateBusy) return { ok: false, busy: true, error: '已有更新操作进行中，请稍候' };
  updateBusy = true;
  try {
    // 操作一开始就给前端反馈（立即出现 0% 状态栏进度，避免"点了没反应"）
    sendToMain('update_downloading', Object.assign({}, lastUpdateInfo || {}, { percent: 0 }));
    // setup 安装版：走 electron-updater 下载 setup 安装包；便携版保持下方 zip 下载逻辑
    if (!IS_PORTABLE) {
      sendToMain('update_status', '正在连接更新服务器…');
      return await runSetupStartUpdate();
    }
    let info = lastUpdateInfo;
    if (!info || !info.ok || !info.hasUpdate || !info.url) {
      sendToMain('update_status', '正在连接更新服务器…');
      info = await checkForUpdate({ silent: true });
    }
    if (!info || !info.ok) {
      // 顶层已发 0%：失败必须有收尾事件，否则状态栏进度卡住
      sendToMain('update_error', { message: '检查更新失败：' + ((info && info.error) || '未知错误') });
      return { ok: false, error: (info && info.error) || '检查更新失败' };
    }
    if (!info.hasUpdate) {
      sendToMain('update_none', { current: APP_VERSION, message: '暂无可用更新' });
      return { ok: false, error: '暂无可用更新' };
    }
    if (!info.url) {
      sendToMain('update_error', { message: 'Release 缺少便携包资产' });
      return { ok: false, error: 'Release 缺少便携包资产' };
    }
    const dl = await downloadUpdate(info, (p) => sendToMain('update_downloading', Object.assign({}, info, { percent: p })), (text) => sendToMain('update_status', text));
    if (!dl.ok) {
      sendToMain('update_error', { error: dl.error, message: '下载失败：' + dl.error });
      return { ok: false, error: dl.error };
    }
    lastDownload = { zipPath: dl.zipPath, info };
    writeUpdateLog('更新包下载就绪：' + dl.zipPath);
    sendToMain('update_downloaded', info);
    return { ok: true, downloaded: true };
  } finally {
    updateBusy = false;
  }
}
// 用户点击「更新并重启」：拉起更新器并退出应用（两步式第二步，需 UPDATE_ENABLED）
async function applyUpdate() {
  if (!UPDATE_ENABLED) return { ok: false, error: '自动更新已停用' };
  // setup 安装版：electron-updater 静默升级安装并重启
  if (!IS_PORTABLE) return setupApplyUpdate();
  if (!lastDownload) return { ok: false, error: '没有已下载的更新包' };
  const { zipPath, info } = lastDownload;
  const scriptPath = path.join(cacheDir, 'update', 'apply_update.ps1');
  try { fs.mkdirSync(path.dirname(scriptPath), { recursive: true }); fs.writeFileSync(scriptPath, UPDATE_SCRIPT_TPL, 'utf-8'); } catch (e) {
    sendToMain('update_error', { message: '写入更新脚本失败：' + e.message });
    return { ok: false, error: e.message };
  }
  const exeName = path.basename(process.execPath) || 'Video Lab.exe';
  try {
    // 生成 .cmd 启动器（路径全部加引号，避免空格路径被拆散）
    const launcherPath = path.join(cacheDir, 'update', 'launch_update.cmd');
    const cmdLines = [
      '@echo off',
      'pwsh -NoProfile -ExecutionPolicy Bypass -File "' + scriptPath + '" -Target "' + projectDir() + '" -Zip "' + zipPath + '" -ExeName "' + exeName + '"'
    ];
    fs.writeFileSync(launcherPath, cmdLines.join('\r\n') + '\r\n', 'utf-8');
    writeUpdateLog('拉起更新器：' + launcherPath);
    // 经 explorer.exe 启动：其派生的 cmd/pwsh 不在 Electron 的 job object 内，
    // 主进程退出不会被连带终止（直接 spawn / Start-Process 均会被杀，已验证）
    const { spawn } = require('child_process');
    const p = spawn('explorer.exe', [launcherPath], { detached: true, stdio: 'ignore' });
    p.on('error', (err) => {
      writeUpdateLog('更新器启动失败：' + (err && err.message));
      sendToMain('update_error', { message: '启动更新器失败：' + (err && err.message) });
    });
    p.unref();
  } catch (e) {
    writeUpdateLog('spawn 抛出异常：' + (e && e.message));
    sendToMain('update_error', { message: '启动更新器失败：' + e.message });
    return { ok: false, error: e.message };
  }
  sendToMain('update_ready', info);
  isQuitting = true;
  setTimeout(() => { try { app.quit(); } catch (e) {} }, 2000);
  return { ok: true };
}

function registerIpc() {
  ipcMain.handle('list_projects', (e, force) => api.listProjects(!!force));
  ipcMain.handle('list_versions', (e, project, name) => api.listVersions(project, name));
  ipcMain.handle('read_config', (e, p) => api.readConfig(p));
  ipcMain.handle('save_config', (e, p, folders, excludes, watermark) => api.saveConfig(p, folders, excludes, watermark));
  ipcMain.handle('save_config_today', (e, project, name, configName, folders, excludes, watermark) => api.saveConfigToday(project, name, configName, folders, excludes, watermark));
  ipcMain.handle('precheck', (e, paths, excludes) => api.precheck(paths, excludes));
  ipcMain.handle('reset_precheck', (e) => { const sender = e.sender; return api.resetPrecheck((s) => { try { sender.send('reset_progress', s); } catch (err) {} }); });
  // 仅刷新预缓存：不删缓存，只对缺失/变化的视频增量更新（与重置同通道回报进度）
  ipcMain.handle('refresh_precache', (e) => { const sender = e.sender; return api.refreshPrecache((s) => { try { sender.send('reset_progress', s); } catch (err) {} }); });
  ipcMain.handle('list_logs', (e, project, name, versionPath) => api.listLogs(project, name, versionPath));
  ipcMain.handle('search_logs', (e, query) => api.searchLogs(query));
  ipcMain.handle('get_log_content', (e, fromPath, configName) => api.logContent(fromPath, configName));
  ipcMain.handle('list_log_files', (e, fromPath, configName) => api.listLogFiles(fromPath, configName));
  ipcMain.handle('find_replica_output', (e, logPath, videoName) => api.findReplicaOutput(logPath, videoName));
  ipcMain.handle('check_exists', (e, paths) => api.checkExists(paths));
  ipcMain.handle('check_watermark_project', (e, project, wm) => api.checkWatermarkProject(project, wm));
  ipcMain.handle('find_watermark_project', (e, project, wm) => api.findWatermarkProject(project, wm));
  ipcMain.handle('get_project_watermark', (e, project) => api.getProjectWatermark(project));
  ipcMain.handle('set_project_watermark', (e, project, wm, enabled, applyToAll) => api.setProjectWatermark(project, wm, enabled, applyToAll));
  ipcMain.handle('run_batch', (e, p, count, group) => api.runBatch(p, count, group));
  ipcMain.handle('run_replica', (e, logPath, mode, entryVideo) => api.runReplica(logPath, mode, entryVideo));
  ipcMain.handle('list_tasks', () => api.snapshotTasks());
  ipcMain.handle('stop_task', (e, id) => api.stopTask(id));
  ipcMain.handle('rerun_task', (e, id) => api.rerunTask(id));
  ipcMain.handle('pin_task', (e, id) => api.pinTask(id));
  ipcMain.handle('reorder_tasks', (e, ids) => api.reorderTasks(ids));
  ipcMain.handle('pause_task', (e, id) => api.pauseTask(id));
  ipcMain.handle('resume_task', (e, id) => api.resumeTask(id));
  ipcMain.handle('clear_finished_tasks', (e, statuses) => api.clearFinishedTasks(statuses));
  ipcMain.handle('clear_done_tasks', (e, opts) => api.clearDoneTasks(opts || {}));
  ipcMain.handle('get_changelog', () => api.getChangelog());
  ipcMain.handle('get_readme', () => api.getReadme());
  // 启动弹更新日志：仅当配置里记录的上次展示版本与当前版本不同（含初次启动 / 版本更新后）才返回内容，并即刻记录为已展示
  ipcMain.handle('get_changelog_popup', () => {
    try {
      const cfg = loadConfig();
      if (String(cfg.last_changelog_version || '') === APP_VERSION) return { ok: true, show: false };
      const r = api.getChangelog();
      if (!r || !r.ok) return { ok: false, error: (r && r.error) || '读取更新日志失败' };
      cfg.last_changelog_version = APP_VERSION;
      saveConfig(cfg);
      try { Object.assign(config, cfg); } catch (e) {}
      return { ok: true, show: true, content: r.content };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  });
  // 水印悬浮预览：独立置顶小窗，可越出主窗口显示；窗口按水印图实际比例自适应（最大 320px），位置按显示器工作区计算（10px 间距、右上贴齐）
  let wmPreviewWin = null;
  // 定位统一取真实光标屏幕坐标（DIP），绕开前端 clientX/Y 的缩放换算，避免偏到屏幕左上
  function wmPreviewPosition() {
    if (!wmPreviewWin || wmPreviewWin.isDestroyed()) return;
    const { screen } = require('electron');
    const cp = screen.getCursorScreenPoint();
    const wa = screen.getDisplayNearestPoint(cp).workArea;
    // 移动过程只动位置，尺寸一律用显式缓存值，避免 getSize/setContentSize 联动导致忽大忽小
    const W = (wmPreviewWin._wmSize && wmPreviewWin._wmSize[0]) || 300;
    const H = (wmPreviewWin._wmSize && wmPreviewWin._wmSize[1]) || 300;
    const x = cp.x, y = cp.y;
    let px = Math.floor(x + 10), py = Math.floor(y - H - 10);
    if (px + W > wa.x + wa.width) px = Math.floor(x - W - 10);
    if (py < wa.y) py = Math.floor(y + 10);
    if (px < wa.x) px = wa.x;
    if (py + H > wa.y + wa.height) py = wa.y + wa.height - H;
    wmPreviewWin.setPosition(Math.max(wa.x, Math.min(px, wa.x + wa.width - W)), Math.max(wa.y, Math.min(py, wa.y + wa.height - H)), false);
  }
  ipcMain.handle('watermark_preview_show', (e, rawPath) => {
    if (typeof rawPath !== 'string' || !rawPath.trim()) return { ok: false };
    const abs = path.resolve(rawPath);
    const image = nativeImage.createFromPath(abs);
    const size = image.isEmpty() ? { width: 320, height: 320 } : image.getSize();
    const maxSide = 320;
    const scale = Math.min(1, maxSide / Math.max(size.width || 1, size.height || 1));
    const w = Math.max(48, Math.round(size.width * scale)), h = Math.max(48, Math.round(size.height * scale));
    const W = w, H = h; // 窗口 = 图片实际比例尺寸，无边框无留白
    // 尺寸防护：任何非预期 resize（如系统/Move 触发）都立即拉回设定尺寸，防止移动中越来越大
    function wmResizeGuard() {
      if (!wmPreviewWin || wmPreviewWin.isDestroyed() || !wmPreviewWin._wmSize) return;
      const cur = wmPreviewWin.getContentSize();
      if (cur[0] !== wmPreviewWin._wmSize[0] || cur[1] !== wmPreviewWin._wmSize[1]) {
        wmPreviewWin.setContentSize(wmPreviewWin._wmSize[0], wmPreviewWin._wmSize[1], false);
      }
    }
    if (!wmPreviewWin || wmPreviewWin.isDestroyed()) {
      wmPreviewWin = new BrowserWindow({
        width: W, height: H, frame: false, transparent: true, resizable: false,
        backgroundColor: '#00000000', // 全透明底，避免圆角外侧出现实色角
        show: false, skipTaskbar: true, alwaysOnTop: true, hasShadow: false, focusable: false,
        webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: false }
      });
      wmPreviewWin.setAlwaysOnTop(true, 'floating');
      wmPreviewWin.setIgnoreMouseEvents(true, { forward: true }); // 鼠标穿透，避免遮挡主窗口 hover
      wmPreviewWin.on('closed', () => { wmPreviewWin = null; });
    }
    wmPreviewWin.removeListener('resize', wmResizeGuard);
    wmPreviewWin.on('resize', wmResizeGuard);
    // 仅尺寸变化时调整窗口大小，避免每次 show 触发布局抖动
    wmPreviewWin._wmSize = [W, H];
    const cur = wmPreviewWin.getSize();
    if (cur[0] !== W || cur[1] !== H) wmPreviewWin.setContentSize(W, H, false);
    const fileUrl = 'file://' + encodeURI(abs.replace(/\\/g, '/'));
    // 同一张图不重复加载，避免闪烁；skin 变化时（含边框样式）强制刷新
    const urlWithSkin = 'file:///' + path.join(__dirname, 'frontend', 'wm_preview.html').replace(/\\/g, '/') + '?p=' + encodeURIComponent(fileUrl) + '&skin=' + encodeURIComponent((loadConfig().skin || 'white_blue'));
    if (wmPreviewWin._lastUrl !== urlWithSkin) {
      wmPreviewWin._lastUrl = urlWithSkin;
      wmPreviewWin.loadURL(urlWithSkin);
    }
    wmPreviewWin.showInactive();
    wmPreviewPosition();
    return { ok: true };
  });
  ipcMain.handle('watermark_preview_move', () => { wmPreviewPosition(); return { ok: true }; });
  ipcMain.handle('watermark_preview_hide', () => { if (wmPreviewWin && !wmPreviewWin.isDestroyed()) wmPreviewWin.hide(); return { ok: true }; });
  ipcMain.handle('clear_task', (e, id) => api.clearTask(id));
  ipcMain.handle('regroup_task', (e, id, groupCount) => api.regroupTask(id, groupCount));
  ipcMain.handle('resume_all_tasks', () => api.resumeAllTasks());
  ipcMain.handle('pause_all_tasks', () => api.pauseAllTasks());
  ipcMain.handle('confirm_quit', () => { quitConfirmed = true; app.quit(); return { ok: true }; });
  // 关闭主窗口行为：主窗口弹窗选择结果（exit=退出软件 / tray=最小化至托盘）；勾选"不再提醒"则持久化下次直接生效
  ipcMain.handle('choose_close_behavior', (e, behavior, skipReminder) => {
    closeAskOpen = false;
    const b = behavior === 'exit' ? 'exit' : 'tray';
    config.close_behavior = b;
    if (skipReminder) config.close_behavior_skip = true;
    saveConfig(config);
    if (b === 'exit') { isQuitting = true; quitConfirmed = false; app.quit(); }
    else if (mainWin && !mainWin.isDestroyed()) mainWin.hide();
    return { ok: true };
  });
  ipcMain.handle('open_task_window', () => { createTaskWindow(); return { ok: true }; });
  ipcMain.handle('clean_duplicate_star', (e, commit) => api.cleanDuplicateStar(!!commit));
  ipcMain.handle('open_external', async (e, url) => { if (typeof url === 'string' && /^https?:\/\//.test(url)) { const err = await shell.openExternal(url); return err ? { ok: false, error: err } : { ok: true }; } return { ok: false, error: '无效链接' }; });
  ipcMain.handle('open_settings_window', () => { openSettingsWindow(); return { ok: true }; });
  // 自绘托盘菜单项点击：动作与原生托盘菜单一致
  ipcMain.handle('tray_menu_click', (e, action) => {
    hideTrayMenu();
    if (action === 'show_main') showMainWindow();
    else if (action === 'open_tasks') { showMainWindow(); const w = createTaskWindow(); if (w && !w.isDestroyed()) { w.show(); w.focus(); } }
    else if (action === 'open_settings') openSettingsWindow();
    else if (action === 'check_update') { showMainWindow(); checkForUpdate({ silent: false }); }
    else if (action === 'quit') { isQuitting = true; app.quit(); }
    return { ok: true };
  });
  // 设置页：读取完整配置（合并默认值，保证字段齐全）
  ipcMain.handle('get_settings', () => {
    const c = loadConfig();
    return {
      skin: c.skin,
      root: c.root || '',
      batch: Object.assign({}, DEFAULT_CONFIG.batch, c.batch),
      replica: Object.assign({}, DEFAULT_CONFIG.replica, c.replica),
      auto_check_update: c.auto_check_update !== false,
      update_source: c.update_source === 'github' ? 'github' : 'gitee',
      config_storage: c.config_storage === 'appdata' ? 'appdata' : 'program',
      config_path: configFilePath(),
      config_path_program: path.dirname(programConfigPath()),   // 显示目录（含配置与 Cache）
      config_path_appdata: path.dirname(appdataConfigPath()),
      autostart: c.autostart === true,
      close_behavior: c.close_behavior === 'exit' ? 'exit' : 'tray',
    };
  });
  // 设置页：保存完整配置，写入 config.json 并同步内存/后端/主窗口皮肤；切换保存位置时迁移并删除旧文件
  ipcMain.handle('save_settings', (e, s) => {
    const cfg = loadConfig();
    let configMoved = false;
    if (s && typeof s === 'object') {
      for (const k of ['skin', 'root']) {
        if (k === 'root') { if (typeof s.root === 'string' && s.root.trim()) cfg.root = s.root.trim(); } // root 为空不得覆盖已有工作路径
        else if (typeof s[k] === 'string') cfg[k] = s[k].trim();
      }
      if (s.config_storage === 'program' || s.config_storage === 'appdata') cfg.config_storage = s.config_storage;
      if (typeof s.auto_check_update === 'boolean') cfg.auto_check_update = s.auto_check_update;
      if (typeof s.autostart === 'boolean') cfg.autostart = s.autostart;
      if (s.close_behavior === 'exit' || s.close_behavior === 'tray') cfg.close_behavior = s.close_behavior;
      if (s.update_source === 'github' || s.update_source === 'gitee') cfg.update_source = s.update_source;
      if (s.batch && typeof s.batch === 'object') cfg.batch = Object.assign({}, DEFAULT_CONFIG.batch, s.batch);
      if (s.replica && typeof s.replica === 'object') cfg.replica = Object.assign({}, DEFAULT_CONFIG.replica, s.replica);
    }
    // 配置保存位置切换：迁移并删除旧位置文件（迁移式，防止两处配置不一致）
    const target = cfg.config_storage === 'appdata' ? appdataConfigPath() : programConfigPath();
    if (path.resolve(target) !== path.resolve(configFilePath())) {
      const mv = moveConfigFile(target);
      if (mv.ok && mv.moved) { configMoved = true; moveCaches(); } // Cache 一并迁移（配置和数据）
    }
    saveConfig(cfg);
    // 应用开机自启动（openAtLogin + --autostart 静默托盘启动）；开发版不注册，避免污染开发环境
    try { if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: cfg.autostart === true, args: ['--autostart'] }); } catch (e) {}
    Object.assign(config, cfg);
    api.updateSettings(cfg);
    for (const w of BrowserWindow.getAllWindows()) w.webContents.send('settings_saved', cfg);
    return { ok: true, config_moved: configMoved };
  });
  // 运行时形态（便携 zip / setup 安装版），供前端决定「下载完成」后的按钮动作
  ipcMain.handle('get_runtime', () => ({ is_portable: IS_PORTABLE, version: APP_VERSION }));
  // 设置页：检查更新（仅在自动更新启用时生效，UPDATE_ENABLED=false 时返回停用）。
  // 设置页来源不向主窗口弹「发现新版本」（确认弹窗已在设置页内），下载完成后主窗口才弹操作条
  ipcMain.handle('check_update', (e, silent) => {
    const fromSettings = !!(settingsWin && !settingsWin.isDestroyed() && e.sender === settingsWin.webContents);
    return checkForUpdate({ silent: !!silent, notifyMain: !fromSettings });
  });
  // 主窗口状态栏：当前应用版本号（左下角常驻显示）
  ipcMain.handle('get_app_version', () => APP_VERSION);
  // 开机自启动开关（独立读写，设置页「通用设置」可用；openAtLogin + --autostart 静默托盘启动）
  ipcMain.handle('get_autostart', () => ({ enabled: config.autostart === true }));
  ipcMain.handle('set_autostart', (e, en) => {
    const v = !!en;
    config.autostart = v;
    saveConfig(config);
    try { if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: v, args: ['--autostart'] }); } catch (e) {}
    for (const w of BrowserWindow.getAllWindows()) w.webContents.send('settings_saved', loadConfig());
    return { ok: true, enabled: v };
  });
  // 手动取消进行中的后台预检测（后端 token 自增即中断旧探测）
  ipcMain.handle('cancel_precheck', () => api.cancelPrecheck());
  // 主窗口提示条：两步式第一步（仅下载，需 UPDATE_ENABLED）
  ipcMain.handle('start_update', () => startUpdate());
  // 主窗口提示条：两步式第二步（安装并重启，需 UPDATE_ENABLED，setup 版使用）
  ipcMain.handle('apply_update', () => applyUpdate());
  // 便携版：打开资源管理器并选中已下载的更新包（用户关闭应用后自行解压）
  ipcMain.handle('reveal_update_file', () => {
    if (!lastDownload || !fs.existsSync(lastDownload.zipPath)) return { ok: false, error: '更新包不存在' };
    try { shell.showItemInFolder(lastDownload.zipPath); } catch (e) { return { ok: false, error: e.message }; }
    return { ok: true, path: lastDownload.zipPath };
  });
  // 设置页「确认退出」：放弃未保存修改并关闭
  ipcMain.handle('force_close_settings', () => {
    settingsDirty = false;
    try { if (settingsWin && !settingsWin.isDestroyed()) settingsWin.close(); } catch (e) {}
    return { ok: true };
  });
  // 设置页：通用「选择目录」对话框（parent 取调用方窗口，引导窗口/设置窗口/主窗口通用）
  ipcMain.handle('pick_directory', async (e, title, defaultPath) => {
    settingsPickingDir = true;
    try {
      const win = BrowserWindow.fromWebContents(e.sender) || settingsWin || mainWin;
      const result = await dialog.showOpenDialog(win, { title: title || '选择目录', defaultPath: defaultPath || api.getRoot() || defaultRoot() || os.homedir(), properties: ['openDirectory'] });
      return result.canceled || !result.filePaths || result.filePaths.length === 0 ? '' : result.filePaths[0];
    } finally { settingsPickingDir = false; }
  });
  // 设置页：改动状态通知（决定失焦时是直接关闭还是提醒保存）
  ipcMain.on('settings_dirty', (e, d) => { settingsDirty = !!d; });
  ipcMain.handle('get_root', () => api.getRoot());
  ipcMain.handle('check_env', () => api.checkEnv());
  // 首次引导窗口：保存工作路径
  ipcMain.handle('save_guide', (e, s) => {
    const root = s && typeof s.root === 'string' ? s.root.trim() : '';
    if (!root || !fs.existsSync(root) || !fs.statSync(root).isDirectory()) return { ok: false, error: '路径无效或不存在' };
    config.root = root;
    saveConfig(config);
    api.setRoot(root);
    return { ok: true, root };
  });
  ipcMain.handle('choose_workdir', async () => {
    const result = await dialog.showOpenDialog(mainWin, { title: '选择工作路径', defaultPath: api.getRoot(), properties: ['openDirectory'] });
    if (result.canceled || !result.filePaths || result.filePaths.length === 0) return { ok: false, canceled: true };
    const dir = result.filePaths[0];
    config.root = dir; saveConfig(config); api.setRoot(dir);
    return { ok: true, root: dir, projects: api.listProjects() };
  });
  ipcMain.handle('get_skin', () => String(config.skin || 'white_blue'));
  ipcMain.handle('set_skin', (e, skin) => { const v = String(skin || '').trim(); config.skin = v || 'white_blue'; saveConfig(config); return config.skin; });
  ipcMain.handle('open_path', async (e, p) => { const target = path.resolve(p); if (fs.existsSync(target)) { const err = await shell.openPath(target); return err ? { ok: false, error: err } : { ok: true }; } return { ok: false, error: '路径不存在' }; });
  ipcMain.handle('open_parent', async (e, p) => { const target = path.dirname(path.resolve(p)); if (fs.existsSync(target)) { const err = await shell.openPath(target); return err ? { ok: false, error: err } : { ok: true }; } return { ok: false, error: '路径不存在' }; });
  ipcMain.handle('external_edit', async (e, p) => { const target = path.resolve(p); if (fs.existsSync(target) && fs.statSync(target).isFile()) { const err = await shell.openPath(target); return err ? { ok: false, error: err } : { ok: true }; } return { ok: false, error: '文件不存在' }; });
  ipcMain.handle('pick_watermark', async (e, prevPath) => {
    // 默认定位到上一个水印所在位置（当前配置里已有的水印路径），便于就近选择新水印
    const defaultPath = String(prevPath || '').trim();
    const result = await dialog.showOpenDialog(mainWin, { title: '选择水印 PNG', defaultPath, properties: ['openFile'], filters: [{ name: 'PNG 图片', extensions: ['png'] }] });
    return result.canceled || !result.filePaths || result.filePaths.length === 0 ? '' : result.filePaths[0];
  });
  ipcMain.handle('pick_exclude', async () => {
    const result = await dialog.showOpenDialog(mainWin, { title: '选择要排除的路径（文件夹或视频文件）', defaultPath: api.getRoot(), properties: ['openFile', 'openDirectory', 'multiSelections'] });
    return result.canceled || !result.filePaths || result.filePaths.length === 0 ? [] : result.filePaths;
  });
  ipcMain.handle('pick_paths', async () => {
    const result = await dialog.showOpenDialog(mainWin, { title: '选择要添加的素材路径（文件夹或视频文件）', defaultPath: api.getRoot(), properties: ['openFile', 'openDirectory', 'multiSelections'] });
    return result.canceled || !result.filePaths || result.filePaths.length === 0 ? [] : result.filePaths;
  });

  // ── 自制标题栏（frame:false）窗口控制 ──
  // 查找请求来源窗口；无来源时回退主窗口
  function winOf(evt) { return BrowserWindow.fromWebContents(evt.sender) || mainWin; }
  ipcMain.handle('window_caps', (e) => {
    const w = winOf(e);
    return { minimizable: !!w && w.isMinimizable(), maximizable: !!w && w.isMaximizable(), closable: !!w && w.isClosable() };
  });
  ipcMain.handle('window_minimize', (e) => { const w = winOf(e); if (w) w.minimize(); return { ok: true }; });
  ipcMain.handle('window_toggle_maximize', (e) => { const w = winOf(e); if (w) { if (w.isMaximized()) w.unmaximize(); else w.maximize(); } return { ok: true }; });
  ipcMain.handle('window_close', (e) => { const w = winOf(e); if (w) w.close(); return { ok: true }; });
  // 最大化状态变化推送给渲染层，用于切换最大化/还原图标
  ipcMain.on('window_max_changed_listen', (e) => {
    const w = winOf({ sender: e.sender });
    if (w) {
      const emit = () => { try { if (!w.isDestroyed()) w.webContents.send('window_max_changed', w.isMaximized()); } catch (err) {} };
      w.on('maximize', emit); w.on('unmaximize', emit);
      emit();
    }
  });

  // 主窗口/退出前未保存确认：收到渲染进程响应后继续关闭或退出流程
  ipcMain.on('respond_discard_config', (e, action) => {
    discardAskOpen = false;
    if (action !== 'ok') { // 取消：复位退出意图，窗口保持现状
      if (isQuitting) { isQuitting = false; quitConfirmed = false; }
      return;
    }
    if (isQuitting) { // 托盘「退出」路径：确认完成，继续退出（before-quit 不再询问）
      discardQuitHandled = true;
      setTimeout(() => { try { app.quit(); } catch (err) {} }, 0);
      return;
    }
    // 关闭主窗口路径：跳过未保存询问，直接执行既有关闭行为
    discardCloseHandled = true;
    handleMainWindowClose();
  });
}

// 请求主窗口确认配置未保存修改；返回是否已发出请求
function askDiscardConfig() {
  if (discardAskOpen || !mainWin || mainWin.isDestroyed()) return false;
  discardAskOpen = true;
  try { mainWin.webContents.send('confirm_discard_config_request'); } catch (e) { discardAskOpen = false; }
  setTimeout(() => { discardAskOpen = false; }, 30000); // 兜底复位（窗口被销毁等情况）
  return true;
}

// 关闭主窗口：已记忆行为直接生效；未记忆时请求主窗口弹窗引导选择（可勾选"不再提醒"持久化）。
// 关闭前先确认配置未保存修改（覆盖当前配置/保存为当日配置/取消），避免修改丢失。
function handleMainWindowClose() {
  if (!mainWin || mainWin.isDestroyed()) return;
  // 最小化到托盘：窗口仅隐藏，未保存的配置修改不丢失，无需询问
  if (config.close_behavior_skip === true && config.close_behavior !== 'exit') { mainWin.hide(); return; }
  // 配置可能未保存：先请求主窗口确认，确认后再走既有关闭行为
  if (!discardCloseHandled) {
    if (discardAskOpen) { mainWin.hide(); return; } // 确认弹窗已打开：本次先收回窗口，选择在弹窗中完成
    askDiscardConfig();
    return;
  }
  discardCloseHandled = false; // 一次性：本次关闭已确认，处理完复位，下次关闭继续询问
  if (config.close_behavior_skip === true) {
    if (config.close_behavior === 'exit') { isQuitting = true; app.quit(); }
    else mainWin.hide();
    return;
  }
  if (closeAskOpen) { mainWin.hide(); return; } // 引导弹窗已打开：本次先收回窗口，选择在弹窗中完成
  closeAskOpen = true;
  try { mainWin.webContents.send('close_behavior_request'); } catch (e) { closeAskOpen = false; }
  setTimeout(() => { closeAskOpen = false; }, 20000); // 兜底复位（窗口被销毁等情况）
}

function createWindow() {
  mainWin = new BrowserWindow({ title: 'Video Lab', width: 1360, height: 860, minWidth: 1120, minHeight: 700, frame: false, webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false } });
  mainWin.loadFile(path.join(__dirname, 'frontend', 'index.html'));
  mainWin.on('close', (e) => {
    if (!isQuitting) { e.preventDefault(); handleMainWindowClose(); }
  });
  mainWin.on('closed', () => { mainWin = null; });
}

// 首次引导窗口：工作路径缺失时打开（仿设置页样式），用户主动点按钮才弹资源管理器；
// 可保存并关闭，也可直接点右上角关闭跳过（跳过时主窗口进入"空列表 + 中央选择路径"引导态）
let guideWin = null;
function openGuideWindow() {
  return new Promise((resolve) => {
    if (guideWin && !guideWin.isDestroyed()) { guideWin.focus(); return; }
    guideWin = new BrowserWindow({ title: 'Video Lab - 首次设置', width: 620, height: 420, resizable: false, maximizable: false, minimizable: false, frame: false, webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false } });
    guideWin.loadFile(path.join(__dirname, 'frontend', 'guide.html'));
    guideWin.on('closed', () => { guideWin = null; resolve(); });
  });
}// 首次（或配置缺失）时：若有工作路径直接继续；否则打开引导窗口由用户保存或跳过。
// 跳过（root 仍无效）时保持 root 为空：主窗口进入「空项目列表 + 居中选择路径」引导态
async function ensureConfig() {
    const isDir = (p) => { try { return p && fs.existsSync(p) && fs.statSync(p).isDirectory(); } catch (e) { return false; } };
    if (!isDir(config.root)) {
      await openGuideWindow(); // 保存或右上角关闭（跳过）都会关闭该窗口
    }
    api.setRoot(isDir(config.root) ? config.root : '');
  }

app.whenReady().then(async () => {
  // 应用身份（AppUserModelID）与 build.appId 统一（com.videolab.manager）：
  // 需配合「开始菜单快捷方式 + 相同 AUMID」一起注册，Windows 才能解析显示名（Video Lab）与图标；
  // 不可移除——缺失时任务管理器会把应用识别为框架名 "Electron"、图标解析失败（乱码）
  try { app.setAppUserModelId('com.videolab.manager'); } catch (e) {}
  Menu.setApplicationMenu(null);
  registerIpc();
  await ensureConfig();
  createTray();
  createWindow();
  // 开机自启（--autostart）：静默到托盘常驻；延迟避开开机 IO 高峰后后台预热工作目录（扫描+索引+日志），不打扰用户；
  // 用户随后打开软件时由单实例锁唤起现有实例（秒开）
  if (IS_AUTOSTART && mainWin && !mainWin.isDestroyed()) {
    mainWin.hide();
    setTimeout(() => { try { api.listProjects(true); } catch (e) {} }, 30000);
  }
  // 启动自动检查更新（仅检查；UPDATE_ENABLED=false 时便携版静默停用）
  if (UPDATE_ENABLED && mainWin && !mainWin.isDestroyed()) {
    mainWin.webContents.once('did-finish-load', () => {
      if (config.auto_check_update !== false) checkForUpdate({ silent: true });
    });
  }
  api.restoreTasks(); // 恢复上次会话的任务列表（退出时已做中断/暂停转换）
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('before-quit', (e) => {
  settingsForceClose = true; // 退出路径：设置窗口带未保存修改也允许关闭
  // 仅管理主动退出（托盘「退出」）；若主窗口仍在运行任务，先经主窗口弹确认框（与界面同款样式）
  if (!isQuitting) return;
  // 配置可能未保存：先经主窗口确认（覆盖当前配置/保存为当日配置/取消），确认后再继续退出
  if (!discardQuitHandled && mainWin && !mainWin.isDestroyed()) {
    e.preventDefault();
    showMainWindow();
    askDiscardConfig();
    return;
  }
  if (api.hasRunningTask() && !quitConfirmed) {
    e.preventDefault();
    showMainWindow();
    if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('confirm_quit_request');
    else { api.shutdownTasks(); quitConfirmed = true; app.quit(); }
    return;
  }
  // 收尾：运行中→已中断、排队→暂停，随后持久化任务列表并退出
  api.shutdownTasks();
  quitConfirmed = true;
});
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && isQuitting) app.quit();
});
