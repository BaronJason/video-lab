// -*- coding: utf-8 -*-
// Video Lab — Electron 主进程
'use strict';

// ── 启动阶段计时 ──
// 冷启动慢的排查长期缺少数据：日志只记了「什么时候启动」，没记「各阶段花了多久」，
// 导致每次优化都靠猜。这里从进程第一行起就开始计时，whenReady → 窗口可见 → 后端就绪
// 各阶段耗时统一落到运行日志的 app.timing 事件，下次再有人说慢可以直接看数。
const _BOOT_T0 = process.hrtime.bigint();
function bootMs() { return Number(process.hrtime.bigint() - _BOOT_T0) / 1e6; }

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { app, BrowserWindow, ipcMain, dialog, shell, Menu, Tray, nativeImage, net, screen } = require('electron');
const _bootReqElectron = bootMs();
const { Api, DEFAULT_CONFIG } = require('./backend');
const { startHttpServer } = require('./server');
const _bootReqBackend = bootMs();
// 内嵌 HTTP 服务器：浏览器访问 http://localhost:<port> 获得与本体等价的功能
let httpServerInfo = null; // { ok, port, token, url, broadcastAll, close }
// 浏览器访问地址：优先取内存运行态；服务器已停/未启动时回退到 config.json 的 http_token 重建链接
// （token 在实例启动时写入 config，供开发测试读取；typeOf 守卫避免 config 声明前的 TDZ）
function httpUrl() {
  if (httpServerInfo && httpServerInfo.ok) return httpServerInfo.url;
  try {
    if (typeof config !== 'undefined' && config && config.http_token) {
      const p = parseInt(config.http_port, 10) || 9527;
      return 'http://localhost:' + p + '/?token=' + config.http_token;
    }
  } catch (e) {}
  return '';
}

// 启动/重启内嵌 HTTP 服务器：固定 token（首次生成持久化到 config.http_token，此后复用）；
// 端口或令牌在设置页变更后由 save_settings 调用本函数重启服务器，新配置即时生效
function restartHttpServer() {
  let httpToken = '';
  try {
    httpToken = String(config.http_token || '').trim();
    if (httpToken.length < 16) {
      httpToken = crypto.randomBytes(16).toString('hex');
      config.http_token = httpToken;
      saveConfig(config);
    }
  } catch (e) { try { httpToken = crypto.randomBytes(16).toString('hex'); } catch (e2) {} }
  startHttpServer({
    api,
    getMainWin: () => mainWin,
    getSettingsWin: () => settingsWin,
    httpPort: parseInt(config.http_port, 10) || 9527,
    httpToken: httpToken,
    extraRoutes: buildHttpExtraRoutes(),
    runLog: runLog,
    broadcast: function (event, data) { /* webContents.send 由各 send 函数完成，此处仅占位 */ }
  }).then(function (info) {
    httpServerInfo = info;
    if (info.ok) console.log('[HTTP] 浏览器访问: ' + info.url);
    else console.error('[HTTP] 启动失败: ' + (info.error || '未知错误'));
  }).catch(function (e) { console.error('[HTTP] 异常: ' + e); });
}

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
  // setup 安装版：exe 所在目录即程序根（引导文件与三库同级定位）
  return path.dirname(process.execPath);
}
// Node 引擎目录动态解析：引擎必须是真实文件系统路径（asar 内无法被 spawn 执行）。
// 源码共存形态（开发机）：引擎就在 main.js 同级 app\engines；
// 打包形态：便携/开发形态用 resources\app\engines，setup 安装在 resources\Engines（extraResources 产物）。
// ⚠ 开发形态不能用 projectDir() 作基准 —— 未打包时它等于 __dirname（app 目录本身），
//    拼出的 resources\app\engines 并不存在，会让源码形态的实例解析不到引擎。
function resolveEnginesDir() {
  if (!app.isPackaged) {
    const local = path.join(__dirname, 'engines');
    try { if (fs.existsSync(local)) return fs.realpathSync(local); } catch (e) {}
    return local;
  }
  const base = projectDir();
  const src = path.join(base, 'resources', 'app', 'engines');
  const dist = path.join(base, 'resources', 'Engines');
  try { if (fs.existsSync(src)) return src; } catch (e) {}
  return dist;
}
function configFilePath() { return configFile; }
function programConfigPath() { return path.join(projectDir(), 'config.json'); }
function appdataConfigPath() { return path.join(app.getPath('appData'), 'Video Lab', 'config.json'); }
// 启动时自动仲裁「配置和数据」的保存位置：
//  1) 两侧都无配置 → 默认程序目录（随后由 ensureConfig 打开启动引导窗口）
//  2) 两侧各有一份 → 取修改时间较新的一份生效，并删除旧的一份（防双份残留复发）
//  3) 库与引导文件同目录（扁平布局）——不再有「配置在一侧、缓存在对侧」的情形
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
    try { fs.unlinkSync(stale); } catch (e) {} // 以新的一份为准并清理旧的（防双份残留复发）
    return chosen;
  }
  return hasAppd ? appd : prog;
}
let configFile = resolveConfigLocation();
// 数据根目录 = 引导文件所在目录：三库（config.json / settings.db / cache.db）扁平同目录，
// 不再有 Cache\ / Config\ 中间层；库路径一律由 storageDir() 派生，杜绝「路径重算」类 bug
const SETTINGS_DB = 'settings.db';
const CACHE_DB = 'cache.db';
const storageDir = () => path.dirname(configFilePath());

// ── 运行日志（排查用，保留 7 天）──
// 任务记录 / 任务标记 / 成片产物都可能被清除或删除，一旦清除就只剩"反推"。
// 本日志独立留存、任何清除操作都不触碰它 —— 它是事后唯一还在的证据。
// 位置与三库同级：<storageDir>\log\app-YYYY-MM-DD.log
const runLog = require(path.join(resolveEnginesDir(), 'base', 'runlog.js'));
runLog.init(path.join(storageDir(), 'log'));
const _pruned = runLog.pruneOld();
const _bootLogReady = bootMs();
runLog.sys('app.start',
  '启动 · 版本 ' + app.getVersion() + ' · ' + (app.isPackaged ? (IS_PORTABLE ? '便携形态' : '安装形态') : '源码形态')
  + (_pruned.removed ? ' · 已清理 ' + _pruned.removed + ' 个过期日志' : ''),
  { version: app.getVersion(), packaged: app.isPackaged, portable: IS_PORTABLE, storageDir: storageDir(), enginesDir: resolveEnginesDir(), keepDays: runLog.KEEP_DAYS });
runLog.sys('app.timing', '启动阶段 · 日志就绪',
  { electronReq: Math.round(_bootReqElectron), backendReq: Math.round(_bootReqBackend), logReady: Math.round(_bootLogReady) });

// ── IPC 统一留痕：一处覆盖全部通道 ──
// 回答"用户到底点了什么"——任务窗口与主窗口的写操作都会经过这里，
// 包括删除配置、新增配置、添加/删除路径、重分组、清除产物等。
// 只读与展示类通道、以及保存设置时的冗余配置项，都由 runlog 侧统一过滤。
// 浏览器端（HTTP）走 server.js，用同一套 chEvent 留痕，两边格式一致。
const _origIpcHandle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = function (channel, fn) {
  return _origIpcHandle(channel, async function (e, ...args) {
    const t0 = Date.now();
    try {
      const r = await fn(e, ...args);
      runLog.chEvent('ipc', channel, args, r, Date.now() - t0);
      return r;
    } catch (err) {
      runLog.err('ipc.' + channel, err, { args: runLog.briefArgs(args, 400) });
      throw err;
    }
  });
};
// 切换配置保存位置：复制到目标位置并删除旧位置文件（迁移式，不留两份）
function moveConfigFile(target) {
  const src = configFile;
  if (path.resolve(target) === path.resolve(src)) return { ok: true, moved: false };
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (fs.existsSync(src)) fs.copyFileSync(src, target);
    try { if (fs.existsSync(src) && path.resolve(target) !== path.resolve(src)) fs.unlinkSync(src); } catch (e) {}
    const fromDir = path.dirname(src);
    configFile = target;                        // 引导文件已到新位置
    moveStorage(fromDir, path.dirname(target)); // 两个库随其后（关连接 → rename/cp → 读回校验 → 回收站源）
    return { ok: true, moved: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
// 移入系统回收站（可还原）；Electron 不可用时降级为重命名备份，绝不静默删除
function recycleFile(p) {
  try {
    const { shell } = require('electron');
    if (shell && typeof shell.trashItem === 'function') {
      shell.trashItem(p).catch(() => { try { fs.renameSync(p, p + '.bak'); } catch (e) {} });
      return true;
    }
  } catch (e) {}
  try { fs.renameSync(p, p + '.bak'); return true; } catch (e) { return false; }
}
// 回收「搬空后的对侧空壳目录」：搬迁完成后旧位置若已无任何内容则整个移入回收站，
// 否则便携版切到程序目录后会在 AppData 侧留下空文件夹（目录非空则保留，不误删用户手放的内容）
function recycleIfEmpty(dir) {
  try {
    if (!dir || !fs.existsSync(dir)) return false;
    if (fs.readdirSync(dir).length) return false;
    return recycleFile(dir);
  } catch (e) { return false; }
}
// 迁移「配置和数据保存位置」：只搬 2 个库（settings.db / cache.db）及其 -wal/-shm，不再递归搬目录树
// （引导文件由 moveConfigFile 负责）。前置：关全部连接 + 无任务在跑 —— Windows 下持有句柄会阻止移动。
// 策略：rename 优先（同盘瞬时完成），跨盘降级 cp + 读回校验 + 源文件入回收站。
function moveStorage(fromDir, toDir) {
  if (!fromDir || !toDir || path.resolve(fromDir) === path.resolve(toDir)) return { ok: true, moved: false };
  if (api && typeof api.hasRunningTasks === 'function' && api.hasRunningTasks()) {
    return { ok: false, error: '有任务正在运行，请等待任务结束后再切换保存位置' };
  }
  const moved = [];
  try {
    if (api && typeof api.closeStorageConnections === 'function') api.closeStorageConnections();
    fs.mkdirSync(toDir, { recursive: true });
    for (const base of [SETTINGS_DB, CACHE_DB]) {
      for (const name of [base, base + '-wal', base + '-shm']) {
        const p = path.join(fromDir, name);
        if (!fs.existsSync(p)) continue;
        const dst = path.join(toDir, name);
        try { fs.renameSync(p, dst); } catch (e) { fs.copyFileSync(p, dst); }
        moved.push([p, dst]);
      }
    }
    // 读回校验：目标侧必须存在且大小与源一致（rename 成功时源已不在，以目标为准）
    for (const [srcPath, dstPath] of moved) {
      let srcSize = 0, dstSize = -1;
      try { dstSize = fs.statSync(dstPath).size; } catch (e) { dstSize = -1; }
      try { srcSize = fs.statSync(srcPath).size; } catch (e) { srcSize = dstSize; }
      if (dstSize < 0 || srcSize !== dstSize) throw new Error('读回校验失败：' + path.basename(dstPath));
    }
    for (const [srcPath] of moved) { if (fs.existsSync(srcPath)) recycleFile(srcPath); } // 跨盘复制留下的源文件
    if (api && typeof api.onStorageMoved === 'function') api.onStorageMoved(toDir);
    // 运行日志随存储位置一起搬：否则切换后日志继续写在旧位置，用户在新位置找不到，
    // 重启后又写到新位置，等于把历史割成两处。
    try {
      const oldLog = path.join(fromDir, 'log');
      const newLog = path.join(toDir, 'log');
      if (path.resolve(oldLog) !== path.resolve(newLog)) {
        runLog.close();                       // 先断开旧文件句柄，否则 Windows 上 rename 会失败
        if (fs.existsSync(oldLog)) {
          fs.mkdirSync(newLog, { recursive: true });
          for (const f of fs.readdirSync(oldLog)) {
            const s = path.join(oldLog, f);
            try { fs.renameSync(s, path.join(newLog, f)); }
            catch (e) { try { fs.copyFileSync(s, path.join(newLog, f)); } catch (e2) {} }
          }
          try { if (!fs.readdirSync(oldLog).length) fs.rmdirSync(oldLog); } catch (e) {}
        }
        runLog.init(newLog);                  // 无论搬移是否顺利，都把写入口切到新位置
      }
    } catch (e) {}
    recycleIfEmpty(fromDir); // 旧位置已搬空则整目录入回收站，避免留下空壳（非空则保留）
    return { ok: true, moved: true, count: moved.length };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
}
function defaultRoot() { return path.dirname(projectDir()); }
// 已废弃的配置键：PS1 双轨期遗留（scripts_dir = 旧脚本目录、use_node_engine = 引擎开关）。
// 代码已不再读取，但不显式剔除就会随 saveConfig 一直写回磁盘，成为永久残留。
const OBSOLETE_CONFIG_KEYS = ['scripts_dir', 'use_node_engine'];
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
  for (const k of OBSOLETE_CONFIG_KEYS) delete cfg[k];
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
// ── 每日定时检查更新：按设置整点触发静默检查，检查后滚动安排次日（应用需保持运行） ──
let dailyUpdateTimer = null;
function scheduleDailyUpdateCheck() {
  if (dailyUpdateTimer) { clearTimeout(dailyUpdateTimer); dailyUpdateTimer = null; }
  if (!UPDATE_ENABLED || config.check_update_daily !== true) return;
  const hour = parseInt(config.check_update_hour, 10);
  if (!(hour >= 0 && hour <= 23)) return;
  const now = new Date();
  const next = new Date(now);
  next.setHours(hour, 0, 0, 0);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  dailyUpdateTimer = setTimeout(function () {
    dailyUpdateTimer = null;
    checkForUpdate({ silent: true }).catch(function () {});
    scheduleDailyUpdateCheck();
  }, Math.min(next.getTime() - now.getTime(), 24 * 3600 * 1000));
}

const root = resolveRoot(config);
// 库与引导文件同目录（扁平布局）：不再有 Cache\ / Config\ 中间层，也不需要「配置侧 / 缓存侧对齐」
const { migrateToFlatLayout, listStagingDirs } = require(path.join(resolveEnginesDir(), 'base', 'migrate.js'));
// 库路径一律由 storageDir() 派生（见上方定义）：不存在需要重算的路径，杜绝「写回旧位置」类 bug
// 一次性布局迁移：旧布局（Cache\ + Config\ + config 同级旧设置文件）→ 三库（config.json / settings.db / cache.db）。
// 每次启动执行且幂等（逐条 upsert 合并，便于回退旧版后再升级收敛）；校验通过才把旧物暂存，失败则保持旧布局可启动。
// 暂存目录交由 app ready 后的回收任务（启动早期调用 shell.trashItem 不可靠）。
const pendingTrashDirs = [];
try {
  const mr = migrateToFlatLayout({ configDir: path.dirname(configFile), log: (m) => console.log(m) });
  if (mr.migrated && mr.stagingDir) pendingTrashDirs.push(mr.stagingDir);
  if (mr.errors && mr.errors.length) console.error('[migrate] ' + mr.errors.join('；'));
} catch (e) { console.error('[migrate] 迁移异常：' + ((e && e.message) || e)); }
for (const d of listStagingDirs(path.dirname(configFile))) {
  if (pendingTrashDirs.indexOf(d) < 0) pendingTrashDirs.push(d); // 回收上次运行未及清理的暂存目录
}
if (pendingTrashDirs.length) {
  app.whenReady().then(() => { for (const d of pendingTrashDirs) { try { recycleFile(d); } catch (e) {} } });
}
const api = new Api(root, config, resolveEnginesDir(), storageDir());
// 扫描/重建环节进度：推送主窗口渲染层实时状态（walk/收集日志/重建成片索引/水印统计 一一对应）
api.onScanProgress = (p) => {
  try {
    const w = (mainWin && !mainWin.isDestroyed()) ? mainWin : (BrowserWindow.getAllWindows()[0] || null);
    if (w && !w.isDestroyed()) w.webContents.send('scan_progress', p);
  } catch (e) {}
  if (httpServerInfo && httpServerInfo.broadcastAll) httpServerInfo.broadcastAll('scan_progress', p);
};
// FFmpeg 环境自愈进度：主窗（更新浮窗复用）+ 设置窗（维护区行内进度）双通道
api.onFfmpegProgress = (p) => {
  sendToMain('env_fix_progress', p);
  sendToSettings('env_fix_progress', p);
};

// 主窗口与任务窗口：主窗口仅在原生模态对话框/载入遮罩时被禁用；任务列表窗口不随父窗口禁用
let mainWin = null;
// 系统托盘：关闭主窗口仅最小化到托盘，右键托盘图标菜单可退出或显示主窗口
let tray = null;
let isQuitting = false;
let exitLogged = false;   // 退出留痕只记一次（before-quit 因 preventDefault 会被多次触发）
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
  // 托盘唤出计时：用户反馈「点托盘要等很久」，这里记录从点击到窗口真正显示的耗时，
  // 区分「窗口需重建（重 loadFile，慢）」与「窗口仅被隐藏（应 <100ms）」两种情况
  const _t = process.hrtime.bigint();
  const needRebuild = !mainWin || mainWin.isDestroyed();
  if (needRebuild) createWindow();
  mainWin.show();
  mainWin.focus();
  const ms = Number(process.hrtime.bigint() - _t) / 1e6;
  try {
    runLog.sys('app.timing', '托盘唤出主窗口'
      + (needRebuild ? '（窗口已销毁 → 重建）' : '（窗口仅隐藏 → 直接显示）'),
      { costMs: Math.round(ms), rebuilt: needRebuild });
  } catch (e) {}
}
function createTray() {
  if (!tray) {
    tray = new Tray(trayIcon());
    tray.setToolTip('Video Lab');
  }
  // 左键直接唤起主窗口；右键唤出自绘托盘菜单
  tray.on('click', () => { hideTrayMenu(); showMainWindow(); });
  tray.on('right-click', () => showTrayMenu());
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
// 视频处理工具窗口：独立于主窗口的**非模态**窗口（可与主窗口并排、同时操作；
// 关掉窗口不影响正在跑的任务；任务结果回主窗口任务列表查看 —— 计划 §七）
let toolWin = null;
function createToolWindow() {
  if (toolWin && !toolWin.isDestroyed()) { toolWin.focus(); return toolWin; }
  // 尺寸=主窗口（1360×860）同比例缩小到 0.75：1020×645 —— 一眼看出是同一套界面的小窗
  toolWin = new BrowserWindow({
    title: 'Video Lab - 视频处理', width: 1020, height: 645, minWidth: 760, minHeight: 520,
    resizable: true, frame: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false },
  });
  if (mainWin && !mainWin.isDestroyed()) {
    const pb = mainWin.getBounds();
    const wa = screen.getDisplayNearestPoint({ x: Math.round(pb.x + pb.width / 2), y: Math.round(pb.y + pb.height / 2) }).workArea;
    const x = Math.max(wa.x, Math.round(pb.x + (pb.width - 1020) / 2));
    const y = Math.max(wa.y, Math.round(pb.y + (pb.height - 645) / 2));
    toolWin.setPosition(Math.min(x, wa.x + wa.width - 1020), Math.min(y, wa.y + wa.height - 645));
  }
  toolWin.loadFile(path.join(__dirname, 'frontend', 'tool.html'));
  toolWin.on('closed', () => { toolWin = null; });
  return toolWin;
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
  // 浏览器端自身打开内嵌模态时会自行添加遮罩，不需要这里广播（否则浏览器网页也会被遮罩）
  if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('settings_window_opened');
  settingsWin = new BrowserWindow({ title: 'Video Lab - 设置', width: 680, height: 640, resizable: false, maximizable: false, minimizable: false, parent: mainWin, frame: false, webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false } });
  // 打开即相对主窗口几何居中：子窗口默认落点常偏右/偏下，手动定位并钳制到所在显示器工作区，
  // 主窗口贴显示器边缘时设置窗口也不会跑出屏幕
  if (mainWin && !mainWin.isDestroyed()) {
    const pb = mainWin.getBounds();
    const cx = Math.round(pb.x + pb.width / 2);
    const cy = Math.round(pb.y + pb.height / 2);
    const wa = screen.getDisplayNearestPoint({ x: cx, y: cy }).workArea;
    const x = Math.max(wa.x, Math.round(pb.x + (pb.width - 680) / 2));
    const y = Math.max(wa.y, Math.round(pb.y + (pb.height - 640) / 2));
    settingsWin.setPosition(
      Math.min(x, wa.x + wa.width - 680),
      Math.min(y, wa.y + wa.height - 640)
    );
  }
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
      if (httpServerInfo && httpServerInfo.broadcastAll) httpServerInfo.broadcastAll('confirm_discard_request', null);
    } catch (err) {}
  });
  settingsWin.on('closed', () => {
    settingsWin = null; settingsDirty = false; settingsPickingDir = false;
    try {
      if (mainWin && !mainWin.isDestroyed() && mainWin.webContents && !mainWin.webContents.isDestroyed()) {
        mainWin.webContents.send('settings_window_closed');
      }
      if (httpServerInfo && httpServerInfo.broadcastAll) httpServerInfo.broadcastAll('settings_window_closed', null);
    } catch (e) {}
    // ★ 关闭设置窗后把主窗口提回前台：用户若在设置窗里开过资源管理器（打开日志/选择目录），
    //   explorer 与其他窗口会压在 Z 序上方，Windows 顺着销毁顺序激活的常常不是主窗 ——
    //   主窗被留在下层，任务栏看软件就像"没选中"（实测稳定触发）
    try {
      if (mainWin && !mainWin.isDestroyed()) {
        if (mainWin.isMinimized()) mainWin.restore();
        else mainWin.show();          // 已可见的窗口 show() = 提到前台并激活
        mainWin.focus();
        if (!mainWin.isFocused()) app.focus({ steal: true });   // 极端场景兜底
      }
    } catch (e2) {}
  });
  return settingsWin;
}
// 设置窗口失焦处理：alt+Tab 切到其他应用时不关闭；
// 仅当用户点击了主窗口区域（失焦后主窗口重新获得焦点）时，未修改才关闭、有修改则报错音+闪红提醒
let settingsDirty = false;
let settingsPickingDir = false;
function sysBeep() {
  // 用 Electron 原生 shell.beep() 播放系统提示音：不再 spawn pwsh
  // （PS1 双轨期残留的最后一处活代码依赖，无 pwsh 环境下会静默失效）
  try { require('electron').shell.beep(); } catch (e) {}
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
      if (httpServerInfo && httpServerInfo.broadcastAll) httpServerInfo.broadcastAll('settings_flash_close', null);
    } else {
      settingsWin.close();
    }
  }, 160);
}
// 任务快照变化时推送给所有窗口（主窗口按钮计数 + 任务窗口列表）
function sendTasksToAll() {
  const tasks = api.snapshotTasks();
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send('task_update', tasks);
  if (httpServerInfo && httpServerInfo.broadcastAll) httpServerInfo.broadcastAll('task_update', tasks);
}
api.onTasksChanged = sendTasksToAll;
// 配置文件写操作（保存/清理/迁移）广播：前端据此即时自愈版本列表、日期分支与侧栏徽章
function sendVersionsChangedToAll() {
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send('versions_changed');
  if (httpServerInfo && httpServerInfo.broadcastAll) httpServerInfo.broadcastAll('versions_changed', null);
}
api.onVersionsChanged = sendVersionsChangedToAll;

// ═══ 自动更新 ═══ 启动/设置页/托盘触发检查，主窗口提示条由用户确认后下载
// 便携版：只检查 + 下载，更新包落地后由「打开更新文件」在资源管理器中选中，用户关闭应用后自行解压覆盖；
//         安装过程不经应用代码（早期曾实现自动安装脚本，因调试不稳定已弃用）
// setup 安装版：electron-updater 静默升级安装并重启
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
// 更新源/更新方式即时落盘：设置页「检查更新」按界面当前选中值执行，
// 避免「切了仓库没保存就检查」时静默沿用旧值（用户看到的与实际的必须一致）。
// 仅接受合法值，非法/缺省不改动 —— 只覆盖这两个字段，其余设置保持原样。
function applyUpdatePref(pref) {
  const cfg = loadConfig();
  let changed = false;
  if (pref && typeof pref === 'object') {
    if (pref.update_source === 'github' || pref.update_source === 'gitee') {
      if (cfg.update_source !== pref.update_source) { cfg.update_source = pref.update_source; changed = true; }
    }
    if (pref.update_mode === 'auto' || pref.update_mode === 'notify') {
      if (cfg.update_mode !== pref.update_mode) { cfg.update_mode = pref.update_mode; changed = true; }
    }
  }
  if (changed) {
    saveConfig(cfg);
    Object.assign(config, cfg);
    scheduleDailyUpdateCheck();   // 与 save_settings 保持一致：更新方式变化后重排定时检查
    writeUpdateLog('更新偏好即时生效：source=' + currentUpdateSource() + ' mode=' + (cfg.update_mode === 'auto' ? 'auto' : 'notify'));
  }
  return { ok: true, changed, update_source: currentUpdateSource(), update_mode: cfg.update_mode === 'auto' ? 'auto' : 'notify' };
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
  if (httpServerInfo && httpServerInfo.broadcastAll) httpServerInfo.broadcastAll(channel, payload);
}
function sendToSettings(channel, payload) {
  try { if (settingsWin && !settingsWin.isDestroyed()) settingsWin.webContents.send(channel, payload); } catch (e) {}
  if (httpServerInfo && httpServerInfo.broadcastAll) httpServerInfo.broadcastAll(channel, payload);
}
// 更新链路日志：按用户要求不再写入 Cache/update/update.log 缓存，保留调用点为 no-op
function writeUpdateLog(line) {}
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
      if (asset || parts.length) {
        // 更新方式=自动检查并下载：发现新版本立即自动下载，不弹「发现新版本」提示条；
        // 进度直接走主窗口状态栏，下载完成后再弹「更新并重启」操作条；启动/定时/手动检查均生效
        if (loadConfig().update_mode === 'auto') {
          info.autoDownload = true;
          // 回执要先于自动下载发出：否则设置页一直停在「正在检查更新…」等下载完成
          if (!silent) sendToSettings('check_update_result', info);
          writeUpdateLog('更新方式=自动下载，发现 v' + tag + ' 开始自动下载');
          startUpdate().catch((e) => writeUpdateLog('自动下载异常：' + ((e && e.message) || e)));
          return info;
        }
        if (!silent) sendToSettings('check_update_result', info);
        if (notifyMain) sendToMain('update_available', info);
      } else {
        // 发现新版本但资产不全：同样要回执，否则设置页状态停在「正在检查更新…」不收敛
        if (!silent) sendToSettings('check_update_result', Object.assign({}, info, { noAsset: true }));
        if (!silent && notifyMain) sendToMain('update_none', Object.assign({}, info, { message: '发现新版本，但 Release 缺少便携包' }));
      }
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
// 便携版更新包落地后由用户自行解压覆盖（早期自动安装脚本因调试不稳定已弃用，见文件头「自动更新」说明）
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
// 用户点击「立即安装」（两步式第二步，需 UPDATE_ENABLED）：仅 setup 安装版经 electron-updater；
// 便携版的更新包由用户自行解压覆盖，故此处直接给出指引
async function applyUpdate() {
  if (!UPDATE_ENABLED) return { ok: false, error: '自动更新已停用' };
  if (!IS_PORTABLE) return setupApplyUpdate(); // setup 安装版：electron-updater 静默升级安装并重启
  return { ok: false, error: '便携版请先「打开更新文件」，关闭应用后自行解压覆盖' };
}

// HTTP 服务器 extraRoutes：涉及 main.js 内部状态（config/loadConfig/saveConfig 等）的路由
// 浏览器侧请求这些路由时，复用与 ipcMain handler 相同的逻辑
function buildHttpExtraRoutes() {
  return {
    // ── agent 友好接口（计划 §8.3）：三条均为纯新增，不改动任何现有接口 ──
    // 读运行日志：任务记录/标记/成片都可能被清除，运行日志是事后唯一证据
    get_runlog: (args) => {
      const o = (args && args[0]) || {};
      if (o.list) return { ok: true, dir: runLog.getDir(), files: runLog.listDays() };
      return runLog.readDay(o.date, o);
    },
    // 一次拿全环境上下文，省去 agent 多次探测
    get_app_info: () => {
      const c = loadConfig();
      const t = (() => { try { return api.listTools(); } catch (e) { return { ok: false, error: String(e && e.message || e) }; } })();
      const enginesDir = resolveEnginesDir();
      const ready = (p) => { try { return fs.existsSync(p); } catch (e) { return false; } };
      return {
        ok: true,
        app: 'Video Lab',
        version: app.getVersion(),
        form: IS_PORTABLE ? 'portable' : 'installed',
        autostart: IS_AUTOSTART,
        storageDir: storageDir(),
        enginesDir,
        configPath: configFilePath(),
        logDir: runLog.getDir(),
        root: api.getRoot(),
        skin: c.skin || '',
        http: { url: httpUrl(), port: parseInt(c.http_port, 10) || 9527 },
        env: api.checkEnv(),
        modules: [
          { id: 'batch', ready: ready(path.join(enginesDir, 'modules', 'batch', 'index.js')) },
          { id: 'mask', ready: ready(path.join(enginesDir, 'modules', 'mask', 'index.js')) },
          { id: 'replica', ready: ready(path.join(enginesDir, 'modules', 'replica', 'index.js')) },
          { id: 'tool', ready: ready(path.join(enginesDir, 'tools', 'module.js')) },
        ],
        tools: t && t.ok ? { steps: t.stepCount, engine: t.engine } : { error: (t && t.error) || '不可用' },
      };
    },
    // 接口清单：**由路由表 + preload 自动生成**，新增通道无需登记
    get_api_index: () => {
      const info = httpServerInfo || {};
      const channels = (typeof info.channelIndex === 'function') ? info.channelIndex() : [];
      let uiChannels = [], events = [];
      try {
        const src = fs.readFileSync(path.join(__dirname, 'preload.js'), 'utf8');
        const si = new Set(), se = new Set();
        for (const m of src.matchAll(/invoke\('([a-z0-9_]+)'/g)) if (!si.has(m[1])) { si.add(m[1]); uiChannels.push(m[1]); }
        for (const m of src.matchAll(/ipcRenderer\.on\('([a-z0-9_]+)'/g)) if (!se.has(m[1])) { se.add(m[1]); events.push(m[1]); }
      } catch (e) {}
      return {
        ok: true,
        http: { url: httpUrl() },
        count: channels.length,
        channels,
        uiChannels: uiChannels.sort(),
        events: events.sort(),
        notes: 'POST /api/<channel>，body 为 JSON 数组（参数按序）；需 token（?token= 或 X-Token 头）；返回 {ok, data} 或 {ok:false, error}',
      };
    },

    get_settings: () => {
      const c = loadConfig();
      return {
        skin: c.skin, root: c.root || '',
        batch: Object.assign({}, DEFAULT_CONFIG.batch, c.batch),
        replica: Object.assign({}, DEFAULT_CONFIG.replica, c.replica),
        mask: Object.assign({}, DEFAULT_CONFIG.mask, c.mask),
        auto_check_update: c.auto_check_update !== false,
        check_update_daily: c.check_update_daily === true,
        check_update_hour: (() => { const h = parseInt(c.check_update_hour, 10); return (h >= 0 && h <= 23) ? h : 9; })(),
        update_source: c.update_source === 'github' ? 'github' : 'gitee',
        update_mode: c.update_mode === 'auto' ? 'auto' : 'notify',
        config_storage: c.config_storage === 'appdata' ? 'appdata' : 'program',
        config_path: configFilePath(),
        config_path_program: path.dirname(programConfigPath()),
        config_path_appdata: path.dirname(appdataConfigPath()),
        autostart: c.autostart === true,
        close_behavior: c.close_behavior === 'exit' ? 'exit' : 'tray',
        http_port: parseInt(c.http_port, 10) || 9527,
        http_token: String(c.http_token || ''),
        http_url: httpUrl(),
        log_dir: runLog.getDir(),
        show_maintenance: c.show_maintenance === true,
        notify_task_end: c.notify_task_end !== false,
        backup_dir: api.getAppSetting('backup_dir', ''),
        backup_auto_clean: api.getAppSetting('backup_auto_clean', false) === true,
        backup_keep_days: parseInt(api.getAppSetting('backup_keep_days', 7), 10) || 7,
        backup_dir_effective: String(api.getAppSetting('backup_dir', '') || '').trim()
          || require('path').join(storageDir(), 'backup'),   // 占位符直接显示实际默认地址
      };
    },
    // 运行日志目录（设置页「维护」区）
    get_log_dir: () => ({ ok: true, dir: runLog.getDir() }),
    save_settings: (args) => {
      const s = args[0];
      const cfg = loadConfig();
      let configMoved = false;
      if (s && typeof s === 'object') {
        for (const k of ['skin', 'root']) {
          if (k === 'root') { if (typeof s.root === 'string' && s.root.trim()) cfg.root = s.root.trim(); }
          else if (typeof s[k] === 'string') cfg[k] = s[k].trim();
        }
        if (s.config_storage === 'program' || s.config_storage === 'appdata') cfg.config_storage = s.config_storage;
        if (typeof s.auto_check_update === 'boolean') cfg.auto_check_update = s.auto_check_update;
        if (typeof s.check_update_daily === 'boolean') cfg.check_update_daily = s.check_update_daily;
        if (s.check_update_hour !== undefined && s.check_update_hour !== null) { const h = parseInt(s.check_update_hour, 10); if (h >= 0 && h <= 23) cfg.check_update_hour = h; }
        if (typeof s.autostart === 'boolean') cfg.autostart = s.autostart;
      mergeAppSettings(cfg, s);   // 与软件端 IPC 路径共用同一份合入逻辑
        if (s.close_behavior === 'exit' || s.close_behavior === 'tray') cfg.close_behavior = s.close_behavior;
        if (s.update_source === 'github' || s.update_source === 'gitee') cfg.update_source = s.update_source;
        if (s.update_mode === 'auto' || s.update_mode === 'notify') cfg.update_mode = s.update_mode;
        if (s.http_port !== undefined && s.http_port !== null) { const p = parseInt(s.http_port, 10); if (p > 0 && p < 65536) cfg.http_port = p; }
        if (typeof s.http_token === 'string') { const tk = s.http_token.trim(); if (tk.length >= 8 && tk.length <= 64) cfg.http_token = tk; }
        if (s.batch && typeof s.batch === 'object') cfg.batch = Object.assign({}, DEFAULT_CONFIG.batch, s.batch);
        if (s.replica && typeof s.replica === 'object') cfg.replica = Object.assign({}, DEFAULT_CONFIG.replica, s.replica);
        if (s.mask && typeof s.mask === 'object') cfg.mask = Object.assign({}, DEFAULT_CONFIG.mask, s.mask);
      }
      const target = cfg.config_storage === 'appdata' ? appdataConfigPath() : programConfigPath();
      if (path.resolve(target) !== path.resolve(configFilePath())) {
        const mv = moveConfigFile(target);
        if (mv.ok && mv.moved) { configMoved = true; }
      }
      const httpStripped = stripNewSettings(cfg);   // 新版本设置项不进 config.json
      saveConfig(cfg);
      Object.assign(config, cfg);
      persistNewSettings(httpStripped, config);     // 补回内存 + 落 settings.db
      // 端口/令牌实际变更才重启 HTTP 服务器（重启会断开浏览器既有 SSE 连接）；
      // 皮肤等其它设置变更保留连接，settings_saved 广播可即时送达浏览器，无需手动刷新
      const httpPortWanted = parseInt(cfg.http_port, 10) || 9527;
      const httpTokenWanted = String(cfg.http_token || '').trim();
      if (httpServerInfo && httpServerInfo.close && (httpServerInfo.port !== httpPortWanted || httpServerInfo.token !== httpTokenWanted)) {
        try { httpServerInfo.close(); } catch (e) {}
        httpServerInfo = null;
      }
      if (!httpServerInfo) restartHttpServer();
      scheduleDailyUpdateCheck();
      api.updateSettings(cfg);
      for (const w of BrowserWindow.getAllWindows()) w.webContents.send('settings_saved', cfg);
      if (httpServerInfo && httpServerInfo.broadcastAll) httpServerInfo.broadcastAll('settings_saved', cfg);
      return { ok: true, config_moved: configMoved };
    },
    save_guide: (args) => {
      const s = args[0];
      const root = s && typeof s.root === 'string' ? s.root.trim() : '';
      if (!root || !fs.existsSync(root) || !fs.statSync(root).isDirectory()) return { ok: false, error: '路径无效或不存在' };
      config.root = root; saveConfig(config); api.setRoot(root);
      return { ok: true, root };
    },
    get_skin: () => String(config.skin || 'white_blue'),
    set_skin: (args) => { const v = String(args[0] || '').trim(); config.skin = v || 'white_blue'; saveConfig(config); return config.skin; },
    get_autostart: () => ({ enabled: config.autostart === true }),
    set_autostart: (args) => {
      const v = !!args[0]; config.autostart = v; saveConfig(config);
      try { if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: v, args: ['--autostart'] }); } catch (e) {}
      for (const w of BrowserWindow.getAllWindows()) w.webContents.send('settings_saved', loadConfig());
      if (httpServerInfo && httpServerInfo.broadcastAll) httpServerInfo.broadcastAll('settings_saved', loadConfig());
      return { ok: true, enabled: v };
    },
    get_changelog_popup: () => {
      try {
        const cfg = loadConfig();
        if (String(cfg.last_changelog_version || '') === APP_VERSION) return { ok: true, show: false };
        const r = api.getChangelog();
        if (!r || !r.ok) return { ok: false, error: (r && r.error) || '读取更新日志失败' };
        // 此处不写 last_changelog_version：标记由前端在弹窗关闭时经 ack_changelog_popup 回写，
        // 避免「静默启动时主窗口 JS 已执行但用户没看到弹窗」就把展示机会消耗掉
        return { ok: true, show: true, content: r.content };
      } catch (e) { return { ok: false, error: String(e) }; }
    },
    ack_changelog_popup: () => {
      try {
        const cfg = loadConfig();
        cfg.last_changelog_version = APP_VERSION;
        saveConfig(cfg);
        try { Object.assign(config, cfg); } catch (e) {}
        return { ok: true };
      } catch (e) { return { ok: false, error: String(e) }; }
    },
    get_runtime: () => ({ is_portable: IS_PORTABLE, version: APP_VERSION }),
    get_app_version: () => APP_VERSION,
    // 返回带 token 的浏览器访问地址（含真实 token）；HTTP 侧需要自身已带 token 才能调用（本机防护），
    // Electron 本体侧 ipcMain 无需 token —— 用于设置页/开发测试获取链接
    get_browser_url: () => {
      const url = httpUrl();
      return url ? { ok: true, url } : { ok: false, error: 'HTTP 服务未就绪' };
    },
    check_update: (args) => {
      const silent = !!args[0];
      return checkForUpdate({ silent: silent, notifyMain: true });
    },
    // 浏览器侧同样支持「检查更新前先让更新源/方式即时生效」（与 IPC 路径共用同一处理函数）
    apply_update_pref: (args) => applyUpdatePref(args[0]),
    respond_discard_config: (args) => {
      // 浏览器侧响应未保存确认：简化处理（浏览器侧无关闭流程，直接返回成功）
      return { ok: true };
    },
    choose_close_behavior: (args) => {
      // 浏览器侧无关闭行为选择，返回不支持
      return { ok: false, error: '浏览器侧不支持' };
    },
  };
}

function registerIpc() {
  ipcMain.handle('list_projects', (e, force) => api.listProjects(!!force));
  ipcMain.handle('list_versions', (e, project, name) => api.listVersions(project, name));
  ipcMain.handle('read_config', (e, p) => api.readConfig(p));
  ipcMain.handle('save_config', (e, p, folders, excludes, watermark) => api.saveConfig(p, folders, excludes, watermark));
  ipcMain.handle('save_config_today', (e, project, name, configName, folders, excludes, watermark) => api.saveConfigToday(project, name, configName, folders, excludes, watermark));
  ipcMain.handle('new_empty_config', (e, project) => api.newEmptyConfig(project));
  ipcMain.handle('remove_branch', (e, p, scope) => api.removeBranch(p, scope));
  ipcMain.handle('branch_other_txt', (e, p) => api.branchOtherTxt(p));
  ipcMain.handle('precheck', (e, paths, excludes) => api.precheck(paths, excludes));
  ipcMain.handle('reset_precheck', (e) => { const sender = e.sender; return api.resetPrecheck((s) => { try { sender.send('reset_progress', s); } catch (err) {} if (httpServerInfo && httpServerInfo.broadcastAll) httpServerInfo.broadcastAll('reset_progress', s); }); });
  // 仅刷新预缓存：不删缓存，只对缺失/变化的视频增量更新（与重置同通道回报进度）
  ipcMain.handle('refresh_precache', (e) => { const sender = e.sender; return api.refreshPrecache((s) => { try { sender.send('reset_progress', s); } catch (err) {} if (httpServerInfo && httpServerInfo.broadcastAll) httpServerInfo.broadcastAll('reset_progress', s); }); });
  ipcMain.handle('clean_video_cache', (e) => api.cleanVideoCache());
  ipcMain.handle('list_logs', (e, project, name, versionPath) => api.listLogs(project, name, versionPath));
  ipcMain.handle('search_logs', (e, query) => api.searchLogs(query));
  ipcMain.handle('get_log_content', (e, fromPath, configName) => api.logContent(fromPath, configName));
  ipcMain.handle('list_log_files', (e, fromPath, configName) => api.listLogFiles(fromPath, configName));
  ipcMain.handle('find_replica_output', (e, logPath, videoName) => api.findReplicaOutput(logPath, videoName));
  ipcMain.handle('check_exists', (e, paths) => api.checkExists(paths));
  ipcMain.handle('check_watermark_project', (e, project, wm) => api.checkWatermarkProject(project, wm));
  ipcMain.handle('find_watermark_project', (e, project, wm) => api.findWatermarkProject(project, wm));
  ipcMain.handle('get_project_watermark', (e, project) => api.getProjectWatermark(project));
  ipcMain.handle('set_project_watermark', (e, project, wm, enabled, applyToAll, group, groupEnabled) => api.setProjectWatermark(project, wm, enabled, applyToAll, group, groupEnabled));
  ipcMain.handle('run_batch', (e, p, count, group) => api.runBatch(p, count, group));
  ipcMain.handle('run_replica', (e, logPath, mode, entryVideo, opts) => api.runReplica(logPath, mode, entryVideo, opts));
  ipcMain.handle('continue_replica', (e, taskId) => api.continueReplica(taskId));
  ipcMain.handle('list_tasks', () => api.snapshotTasks());
  ipcMain.handle('locate_task', (e, taskId, target) => {
    const info = api.taskLocate(taskId);
    if (!info || !info.ok) return info;
    showMainWindow();
    const payload = Object.assign({}, info, { target: target === 'log' ? 'log' : 'config', taskId });
    try { if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('locate_request', payload); } catch (err) {}
    if (httpServerInfo && httpServerInfo.broadcastAll) httpServerInfo.broadcastAll('locate_request', payload);
    return info;
  });
  // 复刻任务「打开成片文件夹」：打开复刻产物目录（月份/MMdd/模式目录），未生成时报错
  ipcMain.handle('open_replica_output', async (e, taskId) => {
    const r = api.taskReplicaOutputDir(taskId);
    if (!r.ok) return r;
    const err = await shell.openPath(r.dir);
    return err ? { ok: false, error: err } : { ok: true };
  });
  // 复刻任务成片目录只读探测（供前端打开前判定按钮可用性，避免点击后再弹窗）
  ipcMain.handle('task_replica_outdir', (e, taskId) => api.taskReplicaOutputDir(taskId));
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
  // 启动弹更新日志：仅当配置里记录的上次展示版本与当前版本不同（含初次启动 / 版本更新后）才返回内容。
  // 标记（last_changelog_version）改由前端在弹窗关闭时经 ack_changelog_popup 回写，
  // 避免「静默到托盘启动时主窗口 JS 已执行、用户却没看到弹窗」白白消耗掉展示机会
  ipcMain.handle('get_changelog_popup', () => {
    try {
      const cfg = loadConfig();
      if (String(cfg.last_changelog_version || '') === APP_VERSION) return { ok: true, show: false };
      const r = api.getChangelog();
      if (!r || !r.ok) return { ok: false, error: (r && r.error) || '读取更新日志失败' };
      return { ok: true, show: true, content: r.content };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  });
  ipcMain.handle('ack_changelog_popup', () => {
    try {
      const cfg = loadConfig();
      cfg.last_changelog_version = APP_VERSION;
      saveConfig(cfg);
      try { Object.assign(config, cfg); } catch (e) {}
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  });
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
  // 视频处理工具（第 4 个模块）：独立窗口 / 步骤 schema / 建任务 / 参数记忆 / 重新执行
  ipcMain.handle('open_tool_window', () => { createToolWindow(); return { ok: true }; });
  ipcMain.handle('list_tools', () => api.listTools());
  ipcMain.handle('run_tool', (e, spec) => api.runTool(spec));
  ipcMain.handle('get_tool_prefs', () => api.getToolPrefs());
  ipcMain.handle('save_tool_prefs', (e, prefs) => api.saveToolPrefs(prefs));
  ipcMain.handle('rerun_tool_task', (e, id) => api.rerunToolTask(id));
  ipcMain.handle('pick_image', async (e, prev) => {
    const w = winOf(e) || mainWin;
    const r = await dialog.showOpenDialog(w || undefined, {
      title: '选择要叠加的图片',
      defaultPath: String(prev || '').trim() || api.getRoot(),
      properties: ['openFile'],
      filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp'] }],
    });
    return (r.canceled || !r.filePaths || !r.filePaths.length) ? '' : r.filePaths[0];
  });
  // 遮罩叠加（复用主窗口）：任务提交 / 断点续跑 / 项目与素材只读扫描 / 水印文件选择
  ipcMain.handle('run_mask', (e, payload) => api.runMask(payload));
  ipcMain.handle('continue_mask', (e, taskId) => api.continueMask(taskId));
  ipcMain.handle('list_mask_projects', () => api.listMaskProjects());
  ipcMain.handle('list_mask_videos', (e, dir) => api.listMaskVideos(dir));
  ipcMain.handle('list_mask_masks', (e, dir) => api.listMaskMasks(dir));
  ipcMain.handle('scan_mask_raw_dirs', (e, dir) => api.scanMaskRawDirs(dir));
  ipcMain.handle('scan_mask_theme_sig', (e, dir) => api.maskThemeSig(dir));
  ipcMain.handle('list_mask_logs', (e, projectPath) => api.listMaskLogs(projectPath));
  ipcMain.handle('get_mask_session', (e, name) => api.getMaskSession(name));
  ipcMain.handle('save_mask_session', (e, name, data) => api.saveMaskSession(name, data));
  ipcMain.handle('clear_mask_session', (e, name) => api.clearMaskSession(name));
  ipcMain.handle('get_mask_default_dir', (e, name) => api.getMaskDefaultDir(name));
  ipcMain.handle('set_mask_default_dir', (e, name, dir) => api.setMaskDefaultDir(name, dir));
  ipcMain.handle('delete_mask_videos', (e, projectPath, names) => api.deleteMaskVideos(projectPath, names));
  ipcMain.handle('move_mask_out', (e, projectPath, videoName, newDir) => api.moveMaskOut(projectPath, videoName, newDir));
  ipcMain.handle('relocate_mask_out', (e, projectPath, videoName, newDir) => api.relocateMaskOut(projectPath, videoName, newDir));
  ipcMain.handle('delete_mask_log', (e, projectPath, logPath) => api.deleteMaskLog(projectPath, logPath));
  ipcMain.handle('delete_secondary_products', (e, projectPath, maskOutPaths) => api.deleteSecondaryProducts(projectPath, maskOutPaths));
  ipcMain.handle('choose_mask_file', async (e, prev) => {
    const win = mainWin && !mainWin.isDestroyed() ? mainWin : null;
    const r = await dialog.showOpenDialog(win, { title: '选择水印文件', defaultPath: prev || (api.getRoot() || os.homedir()), properties: ['openFile'], filters: [{ name: '视频水印', extensions: ['mov', 'mp4'] }] });
    if (r.canceled || !r.filePaths || !r.filePaths.length) return { ok: false };
    return { ok: true, path: r.filePaths[0] };
  });
  ipcMain.handle('clean_duplicate_star', (e, commit) => api.cleanDuplicateStar(!!commit));
  ipcMain.handle('open_external', async (e, url) => { if (typeof url === 'string' && /^https?:\/\//.test(url)) { const err = await shell.openExternal(url); return err ? { ok: false, error: err } : { ok: true }; } return { ok: false, error: '无效链接' }; });
  ipcMain.handle('open_settings_window', () => { openSettingsWindow(); return { ok: true }; });
  // 自绘托盘菜单项点击：动作与原生托盘菜单一致
  ipcMain.handle('tray_menu_click', (e, action) => {
    hideTrayMenu();
    if (action === 'show_main') showMainWindow();
    else if (action === 'open_tasks') { showMainWindow(); const w = createTaskWindow(); if (w && !w.isDestroyed()) { w.show(); w.focus(); } }
    else if (action === 'open_settings') openSettingsWindow();
    else if (action === 'open_tools') { const w = createToolWindow(); if (w && !w.isDestroyed()) { w.show(); w.focus(); } }
    else if (action === 'open_browser') {
      const url = httpUrl();
      if (url) { shell.openExternal(url); return { ok: true }; }
      return { ok: false, error: 'HTTP 服务未就绪（请检查端口/令牌配置）' };
    }
    else if (action === 'check_update') { showMainWindow(); checkForUpdate({ silent: false }); }
    else if (action === 'quit') { isQuitting = true; app.quit(); }
    return { ok: true };
  });
  // 设置页：读取完整配置（合并默认值，保证字段齐全）
  // ───────── 应用级设置的读写（软件端 IPC 与浏览器端 HTTP 两条保存路径共用）─────────
  // 用户定案：新版本加入的设置项只落 settings.db（config.json 仅作旧版回退写入，新字段不进）；
  // 读取默认走 backend.getAppSetting（settings.db 优先、config 回退）。
  // ⚠ 两条保存路径必须都调用这几个函数 —— 曾因只改 HTTP 路径、漏改 IPC 路径导致软件端保存失效。
  const APP_SETTING_KEYS = ['notify_task_end', 'show_maintenance', 'backup_dir', 'backup_auto_clean', 'backup_keep_days'];
  // 新版本设置项（不进 config.json，只落 settings.db）
  const NEW_SETTING_KEYS = ['backup_dir', 'backup_auto_clean', 'backup_keep_days'];

  function mergeAppSettings(cfg, s) {
    if (!s || typeof s !== 'object') return cfg;
    if (typeof s.notify_task_end === 'boolean') cfg.notify_task_end = s.notify_task_end;
    if (typeof s.show_maintenance === 'boolean') cfg.show_maintenance = s.show_maintenance;
    if (typeof s.backup_dir === 'string') cfg.backup_dir = s.backup_dir;
    if (typeof s.backup_auto_clean === 'boolean') cfg.backup_auto_clean = s.backup_auto_clean;
    if (s.backup_keep_days !== undefined) cfg.backup_keep_days = parseInt(s.backup_keep_days, 10) || 7;
    return cfg;
  }
  // 写盘前摘除新设置项（config.json 不收），返回摘出的值
  function stripNewSettings(cfg) {
    const out = {};
    for (const k of NEW_SETTING_KEYS) {
      if (cfg[k] !== undefined) { out[k] = cfg[k]; delete cfg[k]; }
    }
    return out;
  }
  // 落 settings.db 并补回内存 config（显式传值：main.config 与 backend.config 是两个对象）
  function persistNewSettings(vals, memoryConfig) {
    for (const k of Object.keys(vals || {})) memoryConfig[k] = vals[k];
    try { api._saveAppSettings(vals); } catch (e) {}
  }

  ipcMain.handle('get_settings', () => {
    const c = loadConfig();
    return {
      skin: c.skin,
      root: c.root || '',
      batch: Object.assign({}, DEFAULT_CONFIG.batch, c.batch),
      replica: Object.assign({}, DEFAULT_CONFIG.replica, c.replica),
      mask: Object.assign({}, DEFAULT_CONFIG.mask, c.mask),
      auto_check_update: c.auto_check_update !== false,
      check_update_daily: c.check_update_daily === true,
      check_update_hour: (() => { const h = parseInt(c.check_update_hour, 10); return (h >= 0 && h <= 23) ? h : 9; })(),
      update_source: c.update_source === 'github' ? 'github' : 'gitee',
      update_mode: c.update_mode === 'auto' ? 'auto' : 'notify',
      config_storage: c.config_storage === 'appdata' ? 'appdata' : 'program',
      config_path: configFilePath(),
      config_path_program: path.dirname(programConfigPath()),   // 显示目录（含引导文件与三库）
      config_path_appdata: path.dirname(appdataConfigPath()),
      log_dir: runLog.getDir(),   // 运行日志目录（设置页「打开文件夹」用；与 HTTP 版 get_settings 对齐）
      show_maintenance: api.getAppSetting('show_maintenance', false) === true,   // 「维护」板块可见性（用户侧默认关闭）
      notify_task_end: api.getAppSetting('notify_task_end', true) !== false,   // 任务通知（默认开启，settings 优先）
      // backup_* 只落 settings.db，读回必须走 getAppSetting（loadConfig 的磁盘 config 不含它们）
      backup_dir: api.getAppSetting('backup_dir', ''),
      backup_auto_clean: api.getAppSetting('backup_auto_clean', false) === true,
      backup_keep_days: parseInt(api.getAppSetting('backup_keep_days', 7), 10) || 7,
      backup_dir_effective: String(api.getAppSetting('backup_dir', '') || '').trim()
        || path.join(storageDir(), 'backup'),   // 占位符直接显示实际默认地址
      autostart: c.autostart === true,
      close_behavior: c.close_behavior === 'exit' ? 'exit' : 'tray',
      http_port: parseInt(c.http_port, 10) || 9527,
      http_token: String(c.http_token || ''),
      http_url: httpUrl(),
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
      if (typeof s.check_update_daily === 'boolean') cfg.check_update_daily = s.check_update_daily;
      if (s.check_update_hour !== undefined && s.check_update_hour !== null) { const h = parseInt(s.check_update_hour, 10); if (h >= 0 && h <= 23) cfg.check_update_hour = h; }
      if (typeof s.autostart === 'boolean') cfg.autostart = s.autostart;
      if (s.close_behavior === 'exit' || s.close_behavior === 'tray') cfg.close_behavior = s.close_behavior;
      if (s.update_source === 'github' || s.update_source === 'gitee') cfg.update_source = s.update_source;
      if (s.update_mode === 'auto' || s.update_mode === 'notify') cfg.update_mode = s.update_mode;
      if (s.http_port !== undefined && s.http_port !== null) { const p = parseInt(s.http_port, 10); if (p > 0 && p < 65536) cfg.http_port = p; }
      if (typeof s.http_token === 'string') { const tk = s.http_token.trim(); if (tk.length >= 8 && tk.length <= 64) cfg.http_token = tk; }
      if (s.batch && typeof s.batch === 'object') cfg.batch = Object.assign({}, DEFAULT_CONFIG.batch, s.batch);
      if (s.replica && typeof s.replica === 'object') cfg.replica = Object.assign({}, DEFAULT_CONFIG.replica, s.replica);
      if (s.mask && typeof s.mask === 'object') cfg.mask = Object.assign({}, DEFAULT_CONFIG.mask, s.mask);
    }
    mergeAppSettings(cfg, s);   // 应用级设置（含 v2.2.1 新增项）
    // 配置保存位置切换：迁移并删除旧位置文件（迁移式，防止两处配置不一致）
    const target = cfg.config_storage === 'appdata' ? appdataConfigPath() : programConfigPath();
    if (path.resolve(target) !== path.resolve(configFilePath())) {
      const mv = moveConfigFile(target);
      if (mv.ok && mv.moved) { configMoved = true; } // 库随配置一并迁移（moveConfigFile 内部完成）
    }
    const strippedNew = stripNewSettings(cfg);   // 新版本设置项不进 config.json（只落 settings.db）
    saveConfig(cfg);
    // 应用开机自启动（openAtLogin + --autostart 静默托盘启动）；开发版不注册，避免污染开发环境
    try { if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: cfg.autostart === true, args: ['--autostart'] }); } catch (e) {}
    Object.assign(config, cfg);
    persistNewSettings(strippedNew, config);     // 补回内存 config + 落 settings.db
    // 端口/令牌实际变更才重启 HTTP 服务器（重启会断开浏览器既有 SSE 连接）；
    // 皮肤等其它设置变更保留连接，settings_saved 广播可即时送达浏览器，无需手动刷新
    const httpPortWanted = parseInt(cfg.http_port, 10) || 9527;
    const httpTokenWanted = String(cfg.http_token || '').trim();
    if (httpServerInfo && httpServerInfo.close && (httpServerInfo.port !== httpPortWanted || httpServerInfo.token !== httpTokenWanted)) {
      try { httpServerInfo.close(); } catch (e) {}
      httpServerInfo = null;
    }
    if (!httpServerInfo) restartHttpServer();
    scheduleDailyUpdateCheck(); // 定时检查设置可能变更：重新安排
    api.updateSettings(cfg);
    for (const w of BrowserWindow.getAllWindows()) w.webContents.send('settings_saved', cfg);
    if (httpServerInfo && httpServerInfo.broadcastAll) httpServerInfo.broadcastAll('settings_saved', cfg);
    return { ok: true, config_moved: configMoved };
  });
  // 运行时形态（便携 zip / setup 安装版），供前端决定「下载完成」后的按钮动作
  ipcMain.handle('get_runtime', () => ({ is_portable: IS_PORTABLE, version: APP_VERSION }));
  // 返回带 token 的浏览器访问地址（含真实 token）；HTTP 侧需要自身已带 token 才能调用（本机防护），
  // Electron 本体侧 ipcMain 无需 token —— 用于设置页/开发测试获取链接
  ipcMain.handle('get_browser_url', () => {
    const url = httpUrl();
    return url ? { ok: true, url } : { ok: false, error: 'HTTP 服务未就绪' };
  });
  // 设置页：检查更新（仅在自动更新启用时生效，UPDATE_ENABLED=false 时返回停用）。
  // 设置页来源不向主窗口弹「发现新版本」（确认弹窗已在设置页内），下载完成后主窗口才弹操作条
  ipcMain.handle('check_update', (e, silent) => {
    const fromSettings = !!(settingsWin && !settingsWin.isDestroyed() && e.sender === settingsWin.webContents);
    return checkForUpdate({ silent: !!silent, notifyMain: !fromSettings });
  });
  // 设置页：更新源/更新方式即时落盘（检查更新前调用，使界面当前选中值立刻生效）
  ipcMain.handle('apply_update_pref', (e, pref) => applyUpdatePref(pref));
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
    if (httpServerInfo && httpServerInfo.broadcastAll) httpServerInfo.broadcastAll('settings_saved', loadConfig());
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
  // 运行日志目录（设置页「维护」区展示与打开）
  ipcMain.handle('get_log_dir', () => ({ ok: true, dir: runLog.getDir() }));
  // FFmpeg 环境自愈：前端点「修复」触发；完成/失败广播双窗，成功才落盘 ffmpeg_dir
  ipcMain.handle('env_fix_start', async () => {
    const r = await api.ensureFfmpeg();
    sendToMain('env_fix_done', r);
    sendToSettings('env_fix_done', r);
    if (r.ok) saveConfig(config);   // backend 写入的 this.config.ffmpeg_dir 与这里是同一引用
    return r;
  });
  // 启动检测 FFmpeg 环境：不完整才弹下载提示（滤镜链实跑比对，见 backend.checkEnv）
  setTimeout(() => {
    try {
      const env = api.checkEnv();
      if (!env.downloadNeeded) return;
      sendToMain('env_fix_available', { missing: env.missing || [], hasFfmpeg: env.ffmpeg });
      sendToSettings('env_fix_available', { missing: env.missing || [], hasFfmpeg: env.ffmpeg });
    } catch (e) {}
  }, 3500);
  ipcMain.handle('list_dir', async (e, dir) => api.listDir(dir));   // 工具页目录浏览对话框（preload 已定义，此前漏注册）
  ipcMain.handle('open_path', async (e, p) => { const target = path.resolve(p); if (fs.existsSync(target)) { const err = await shell.openPath(target); return err ? { ok: false, error: err } : { ok: true }; } return { ok: false, error: '路径不存在' }; });
  ipcMain.handle('open_parent', async (e, p) => { const target = path.dirname(path.resolve(p)); if (fs.existsSync(target)) { const err = await shell.openPath(target); return err ? { ok: false, error: err } : { ok: true }; } return { ok: false, error: '路径不存在' }; });
  // 打开「文件夹」类操作的统一入口，按目标类型分流：
  //   目录 → 在资源管理器中打开该目录（进入，而不是打开父级再选中它）；
  //   文件 → 打开其所在文件夹并选中该文件（定位）。
  ipcMain.handle('open_folder_select', async (e, p) => {
    const target = path.resolve(String(p || '').replace(/^"|"$/g, ''));
    if (!target || !fs.existsSync(target)) return { ok: false, error: '路径不存在' };
    try {
      if (fs.statSync(target).isDirectory()) {
        const err = await shell.openPath(target);
        return err ? { ok: false, error: err } : { ok: true };
      }
    } catch (e2) { /* stat 失败按文件处理：定位到所在目录 */ }
    shell.showItemInFolder(target);
    return { ok: true };
  });
  ipcMain.handle('report_ui_error', async (e, p) => { try { return api.reportUiError(p) || { ok: true }; } catch (err) { return { ok: false, error: String(err && err.message || err) }; } });
  ipcMain.handle('open_project_dir', async (e, project) => {
    const root = api.getRoot();
    const target = path.resolve(root || '', String(project || ''));
    if (fs.existsSync(target)) { const err = await shell.openPath(target); return err ? { ok: false, error: err } : { ok: true }; }
    return { ok: false, error: '项目目录不存在' };
  });
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
    const result = await dialog.showOpenDialog(mainWin, { title: '选择要添加的文件夹', defaultPath: api.getRoot(), properties: ['openDirectory', 'multiSelections'] });
    return result.canceled || !result.filePaths || result.filePaths.length === 0 ? [] : result.filePaths;
  });
  ipcMain.handle('pick_single_folder', async () => {
    const result = await dialog.showOpenDialog(mainWin, { title: '选择要修改为的文件夹', defaultPath: api.getRoot(), properties: ['openDirectory'] });
    return result.canceled || !result.filePaths || result.filePaths.length === 0 ? '' : result.filePaths[0];
  });
  // 遮罩「添加文件」（原片/遮罩两栏共用）：多选视频文件（含 .lnk 快捷方式）
  ipcMain.handle('pick_paths_files', async () => {
    const result = await dialog.showOpenDialog(mainWin, {
      title: '选择视频文件（支持 mp4/mov/avi/mkv 等 / .lnk 快捷方式）',
      defaultPath: api.getRoot(),
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: '视频文件', extensions: ['mp4', 'mov', 'avi', 'mkv', 'm4v', 'webm', 'flv', 'lnk'] }]
    });
    return result.canceled || !result.filePaths || result.filePaths.length === 0 ? [] : result.filePaths;
  });
  // 遮罩「添加文件夹」（原片/遮罩两栏共用）：多选文件夹，其中视频将递归扫描
  ipcMain.handle('pick_paths_dirs', async () => {
    const result = await dialog.showOpenDialog(mainWin, { title: '选择文件夹（将递归扫描其中视频）', defaultPath: api.getRoot(), properties: ['openDirectory', 'multiSelections'] });
    return result.canceled || !result.filePaths || result.filePaths.length === 0 ? [] : result.filePaths;
  });
  ipcMain.handle('resolve_shortcut', (e, p) => api.resolveShortcut(p));
  ipcMain.handle('mask_add_source', (e, side, p) => api.maskAddSource(side, p));

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
  if (httpServerInfo && httpServerInfo.broadcastAll) httpServerInfo.broadcastAll('confirm_discard_config_request', null);
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
  if (httpServerInfo && httpServerInfo.broadcastAll) httpServerInfo.broadcastAll('close_behavior_request', null);
  setTimeout(() => { closeAskOpen = false; }, 20000); // 兜底复位（窗口被销毁等情况）
}

function createWindow() {
  mainWin = new BrowserWindow({ title: 'Video Lab', width: 1360, height: 860, minWidth: 1120, minHeight: 700, frame: false, show: false, webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false } });
  mainWin.loadFile(path.join(__dirname, 'frontend', 'index.html'));
  // 普通启动：页面就绪后显示；开机自启（--autostart）保持隐藏，仅托盘常驻
  mainWin.once('ready-to-show', () => {
    logTiming('主窗口 ready-to-show（首帧可显示）');
    if (!IS_AUTOSTART) mainWin.show();
  });
  mainWin.on('close', (e) => {
    if (!isQuitting) { e.preventDefault(); handleMainWindowClose(); }
  });
  mainWin.on('closed', () => { mainWin = null; });
}

// 启动阶段计时落日志（app.timing）：冷启动排查的唯一数据来源，避免今后只能靠体感猜
function logTiming(label) {
  try { runLog.sys('app.timing', '启动阶段 · ' + label, { sinceProcessStart: Math.round(bootMs()) }); } catch (e) {}
}

// 窗口渲染完成后再执行后台初始化：把重活（读任务日志、起 HTTP、建托盘）排到窗口可见之后，
// 使其不再叠加到「点了图标迟迟不出窗口」的体感上。
// ⚠ 不能用 ready-to-show 作为唯一触发：开机自启场景窗口从不 show，"首帧显示"语义不成立；
// 用 did-finish-load（页面加载完成，与窗口是否可见无关）保证两种启动方式都能及时触发。
// 另加 3 秒兜底：页面加载异常时也不能把后续初始化永久挂住。
let _afterLoadDone = false;
const _afterLoadQueue = [];
function runAfterWindowLoad(fn) {
  if (_afterLoadDone) { setTimeout(fn, 0); return; }
  _afterLoadQueue.push(fn);
  if (_afterLoadQueue.length > 1) return;
  const flush = () => {
    if (_afterLoadDone) return;
    _afterLoadDone = true;
    for (const f of _afterLoadQueue.splice(0)) { try { f(); } catch (e) {} }
  };
  const wc = mainWin && !mainWin.isDestroyed() ? mainWin.webContents : null;
  if (wc) wc.once('did-finish-load', () => setImmediate(flush));
  setTimeout(flush, 3000);   // 兜底
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
    // 开机自启为静默后台启动：配置缺失也不弹首次引导窗，保持无打扰（用户稍后手动打开时再引导）
    if (!IS_AUTOSTART && !isDir(config.root)) {
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
  logTiming('whenReady 后 注册 IPC 完成');
  // ── 启动顺序原则：**能在窗口显示后做的，绝不放在窗口显示前** ──
  // 早期实现把 ensureConfig / createTray / createWindow / HTTP / restoreTasks 全串在这里，
  // 任一环节慢都会直接叠加到「点了图标迟迟不出窗口」的体感上（而 restoreTasks 要读上百条任务日志）。
  // 现在只保留「窗口必须先有的最小集」，其余一律在首帧之后再跑。
  createWindow();
  logTiming('主窗口已创建（loadFile 已发起）');
  // 开机自启（--autostart）：进程静默常驻托盘，窗口保持隐藏
  runAfterWindowLoad(() => {
    ensureConfig().catch(() => {});   // 首次引导窗口（配置缺失时）：必须在窗口加载后，避免阻塞启动
    try { createTray(); } catch (e) {}
    restartHttpServer();              // 内嵌 HTTP 服务器：浏览器访问 http://localhost:<port>
    if (IS_AUTOSTART && mainWin && !mainWin.isDestroyed()) mainWin.hide();
    logTiming('窗口加载后：托盘 / HTTP 就绪');
    // 启动自动检查更新（仅检查；UPDATE_ENABLED=false 时便携版静默停用）
    if (UPDATE_ENABLED && mainWin && !mainWin.isDestroyed()) {
      if (config.auto_check_update !== false) setTimeout(() => checkForUpdate({ silent: true }), 3000);
      scheduleDailyUpdateCheck();
    }
    // 任务列表恢复：读上百条任务日志，是最重的一步 —— 放到窗口加载后且让出一轮事件循环，
    // 保证窗口已经画出来再占用主进程（原先它排在 createWindow 之前，直接拖慢每次冷启动）
    setTimeout(() => {
      try { api.restoreTasks(); } catch (e) {}
      logTiming('窗口加载后：任务列表已恢复');
    }, 0);
  });
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
  if ((api.hasRunningTask() || api.hasQueuedTask()) && !quitConfirmed) {
    e.preventDefault();
    showMainWindow();
    if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('confirm_quit_request');
    else { api.shutdownTasks(); quitConfirmed = true; app.quit(); }
    if (httpServerInfo && httpServerInfo.broadcastAll) httpServerInfo.broadcastAll('confirm_quit_request', null);
    return;
  }
  // 收尾：运行中→已中断、排队→暂停，随后持久化任务列表并退出
  api.shutdownTasks();
  quitConfirmed = true;
  // 退出留痕要用同步写 —— 此刻进程即将结束，流缓冲里的最后几行等不到 flush
  if (!exitLogged) {
    exitLogged = true;
    try {
      runLog.logEventSync('SYS', 'app.exit', '退出 · 任务已收尾（运行中→已中断、排队→暂停）', {});
      runLog.close();
    } catch (err) {}
  }
});
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' && isQuitting) app.quit();
});

// ── 崩溃留痕 ──
// 程序异常退出后，"发生了什么"往往只剩这一行 —— 这是本日志最该覆盖的场景。
// 注意：监听 uncaughtException 会让 Node 不再自动退出，因此记录后仍需 process.exit(1)
// 保持「未捕获异常即退出」的原有行为，避免进程带病继续运行。
process.on('uncaughtException', (err) => {
  try {
    runLog.logEventSync('ERR', 'app.uncaughtException',
      String((err && err.message) || err).slice(0, 300),
      { stack: String((err && err.stack) || '').slice(0, 1200) });
    runLog.close();
  } catch (e) {}
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  try { runLog.err('app.unhandledRejection', reason); } catch (e) {}
});
// 渲染进程 / 子进程异常退出（主进程仍在运行，但往往正是故障现场）
app.on('render-process-gone', (e, contents, details) => {
  try {
    runLog.err('app.renderGone',
      '渲染进程退出 · ' + String((details && details.reason) || ''),
      { exitCode: details && details.exitCode, url: contents && contents.getURL && contents.getURL() });
  } catch (err) {}
});
app.on('child-process-gone', (e, details) => {
  try {
    runLog.err('app.childGone',
      '子进程退出 · ' + String((details && details.type) || '') + '/' + String((details && details.reason) || ''),
      { exitCode: details && details.exitCode, name: details && details.name });
  } catch (err) {}
});
