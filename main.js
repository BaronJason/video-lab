// -*- coding: utf-8 -*-
// Video Lab — Electron 主进程
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { app, BrowserWindow, ipcMain, dialog, shell, Menu, Tray, nativeImage } = require('electron');
const { Api, DEFAULT_CONFIG } = require('./backend');

// 单实例锁：同一时刻仅允许一个主进程实例运行（跨盘共享同一 userData 的锁），重复打开时唤出现有实例主窗口
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => showMainWindow());
}

try {
  const rootDir = path.dirname(process.execPath);
  const bins = [path.join(rootDir, 'tools', 'pwsh'), path.join(rootDir, 'tools', 'ffmpeg')].filter((d) => fs.existsSync(d));
  if (bins.length) process.env.PATH = bins.join(path.delimiter) + path.delimiter + (process.env.PATH || '');
} catch (e) {}

function projectDir() {
  if (!app.isPackaged) return __dirname;
  let dir = path.dirname(process.execPath);
  for (let i = 0; i < 8; i++) {
    if (path.basename(dir) === 'Video Lab') return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.dirname(process.execPath);
}
function configFilePath() { return path.join(projectDir(), 'config.json'); }
function defaultRoot() { return path.dirname(projectDir()); }
function loadConfig() {
  const cfg = Object.assign({}, DEFAULT_CONFIG);
  try {
    const p = configFilePath();
    if (fs.existsSync(p)) {
      const data = JSON.parse(fs.readFileSync(p, 'utf-8'));
      if (data && typeof data === 'object' && !Array.isArray(data)) Object.assign(cfg, data);
    }
  } catch (e) {}
  return cfg;
}
function saveConfig(config) { try { fs.writeFileSync(configFilePath(), JSON.stringify(config, null, 2), 'utf-8'); } catch (e) {} }
function resolveRoot(config) {
  const env = (process.env.TXT_MANAGER_ROOT || '').trim().replace(/^"|"$/g, '');
  if (env && fs.existsSync(env) && fs.statSync(env).isDirectory()) return env;
  if (config.root && fs.existsSync(config.root) && fs.statSync(config.root).isDirectory()) return config.root;
  return defaultRoot();
}

const config = loadConfig();
const root = resolveRoot(config);
// 缓存统一放根目录 Cache 子文件夹（打包版）；开发版放临时目录避免污染源码
const cacheDir = (() => {
  const dir = app.isPackaged ? path.join(projectDir(), 'Cache') : os.tmpdir();
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
  return dir;
})();
// 三个缓存统一命名(下划线)且统一存放于 Cache 子文件夹：
//   scan_cache.json   —— TXT 指纹缓存
//   video_cache.json  —— 预检测(ffprobe)缓存
//   log_cache.json    —— 日志 txt 缓存（刷新配置时一并收集）
const scanCachePath = path.join(cacheDir, app.isPackaged ? 'scan_cache.json' : 'video_lab_scan_cache.json');
const videoCachePath = path.join(cacheDir, 'video_cache.json');
const logCachePath = path.join(cacheDir, app.isPackaged ? 'log_cache.json' : 'video_lab_log_cache.json');
// 迁移旧 scan 缓存命名（同目录内把旧的连字符命名改为下划线）；不含脚本目录缓存——脚本目录属用户个人数据，应用绝不读写
(function migrateOldScanCache() {
  const oldScan = path.join(cacheDir, app.isPackaged ? 'scan-cache.json' : 'video-lab-scan-cache.json');
  if (oldScan === scanCachePath || !fs.existsSync(oldScan) || fs.existsSync(scanCachePath)) return;
  try { fs.copyFileSync(oldScan, scanCachePath); fs.unlinkSync(oldScan); } catch (e) {}
})();
const api = new Api(root, config, scanCachePath, videoCachePath, logCachePath);

// 主窗口与任务窗口：主窗口仅在原生模态对话框/载入遮罩时被禁用；任务列表窗口不随父窗口禁用
let mainWin = null;
// 系统托盘：关闭主窗口仅最小化到托盘，右键托盘图标菜单可退出或显示主窗口
let tray = null;
let isQuitting = false;
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
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示主窗口', click: () => showMainWindow() },
    { type: 'separator' },
    { label: '退出', click: () => { isQuitting = true; app.quit(); } }
  ]));
  tray.on('double-click', () => showMainWindow());
}
// 任务窗口：显示所有生成任务的状态与实时日志
let taskWin = null;
function createTaskWindow() {
  if (taskWin && !taskWin.isDestroyed()) { taskWin.focus(); return taskWin; }
  taskWin = new BrowserWindow({ title: 'Video Lab - 任务', width: 760, height: 620, minWidth: 520, minHeight: 400, webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false } });
  taskWin.loadFile(path.join(__dirname, 'frontend', 'task.html'));
  taskWin.on('closed', () => { taskWin = null; });
  return taskWin;
}
// 任务快照变化时推送给所有窗口（主窗口按钮计数 + 任务窗口列表）
function sendTasksToAll() {
  const tasks = api.snapshotTasks();
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send('task_update', tasks);
}
api.onTasksChanged = sendTasksToAll;

function registerIpc() {
  ipcMain.handle('list_projects', (e, force) => api.listProjects(!!force));
  ipcMain.handle('list_versions', (e, project, name) => api.listVersions(project, name));
  ipcMain.handle('read_config', (e, p) => api.readConfig(p));
  ipcMain.handle('save_config', (e, p, folders, excludes, watermark) => api.saveConfig(p, folders, excludes, watermark));
  ipcMain.handle('save_config_today', (e, project, name, configName, folders, excludes, watermark) => api.saveConfigToday(project, name, configName, folders, excludes, watermark));
  ipcMain.handle('precheck', (e, paths, excludes) => api.precheck(paths, excludes));
  ipcMain.handle('reset_precheck', (e) => { const sender = e.sender; return api.resetPrecheck((s) => { try { sender.send('reset_progress', s); } catch (err) {} }); });
  ipcMain.handle('list_logs', (e, project, name, versionPath) => api.listLogs(project, name, versionPath));
  ipcMain.handle('search_logs', (e, query) => api.searchLogs(query));
  ipcMain.handle('get_log_content', (e, fromPath, configName) => api.logContent(fromPath, configName));
  ipcMain.handle('list_log_files', (e, fromPath, configName) => api.listLogFiles(fromPath, configName));
  ipcMain.handle('check_exists', (e, paths) => api.checkExists(paths));
  ipcMain.handle('run_batch', (e, p, count, group) => api.runBatch(p, count, group));
  ipcMain.handle('run_replica', (e, logPath, mode) => api.runReplica(logPath, mode));
  ipcMain.handle('list_tasks', () => api.snapshotTasks());
  ipcMain.handle('stop_task', (e, id) => api.stopTask(id));
  ipcMain.handle('pause_task', (e, id) => api.pauseTask(id));
  ipcMain.handle('resume_task', (e, id) => api.resumeTask(id));
  ipcMain.handle('clear_finished_tasks', () => api.clearFinishedTasks());
  ipcMain.handle('open_task_window', () => { createTaskWindow(); return { ok: true }; });
  ipcMain.handle('get_root', () => api.getRoot());
  ipcMain.handle('check_env', () => api.checkEnv());
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
  ipcMain.handle('pick_watermark', async () => {
    const result = await dialog.showOpenDialog(mainWin, { title: '选择水印 PNG', defaultPath: api.watermarkDir || '', properties: ['openFile'], filters: [{ name: 'PNG 图片', extensions: ['png'] }] });
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
}

function createWindow() {
  mainWin = new BrowserWindow({ title: 'Video Lab', width: 1360, height: 860, minWidth: 1120, minHeight: 700, webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false } });
  mainWin.loadFile(path.join(__dirname, 'frontend', 'index.html'));
  mainWin.on('close', (e) => {
    if (!isQuitting) { e.preventDefault(); mainWin.hide(); }
  });
  mainWin.on('closed', () => { mainWin = null; });
}

// 首次（或配置缺失）时引导用户选择必要目录，每个弹窗标题都写明用途
async function ensureConfig() {
  const isDir = (p) => { try { return p && fs.existsSync(p) && fs.statSync(p).isDirectory(); } catch (e) { return false; } };
  if (!isDir(config.root)) {
    const r = await dialog.showOpenDialog({ title: '选择项目数据根目录', message: '这里存放各项目文件夹及其 TXT 配置（必选）', buttonLabel: '选择此目录', defaultPath: defaultRoot(), properties: ['openDirectory'] });
    if (!r.canceled && r.filePaths && r.filePaths[0]) config.root = r.filePaths[0];
  }
  if (!isDir(config.scripts_dir)) {
    const r = await dialog.showOpenDialog({ title: '选择脚本目录', message: '这里放置「批量拼接.ps1」「视频复刻.ps1」（用于生成成片；可取消稍后在 config.json 中补）', buttonLabel: '选择此目录', properties: ['openDirectory'] });
    if (!r.canceled && r.filePaths && r.filePaths[0]) config.scripts_dir = r.filePaths[0];
  }
  if (!isDir(config.watermark_dir)) {
    const r = await dialog.showOpenDialog({ title: '选择水印默认目录', message: '水印 PNG 所在的默认目录（可取消，稍后在 config.json 中补）', buttonLabel: '选择此目录', properties: ['openDirectory'] });
    if (!r.canceled && r.filePaths && r.filePaths[0]) config.watermark_dir = r.filePaths[0];
  }
  saveConfig(config);
  api.setRoot(isDir(config.root) ? config.root : defaultRoot());
}

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  registerIpc();
  await ensureConfig();
  createTray();
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && isQuitting) app.quit();
});
