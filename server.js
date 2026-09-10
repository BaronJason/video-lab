// -*- coding: utf-8 -*-
// Video Lab — 内嵌 HTTP 服务器
// 在 Electron 主进程内启动，对外暴露与本体等价的功能，浏览器访问 http://localhost:<port>
// 同一份 config.json、同一个 Api 单例、同一批任务队列，本体和浏览器共享数据
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { dialog, shell, BrowserWindow } = require('electron');

const FRONTEND_DIR = path.join(__dirname, 'frontend');
const ICON_DIR = path.join(__dirname, 'icon');

// 前台打开目录：本体点击时 Electron 窗口在前台，explorer 继承前台权限直接弹出；
// 浏览器请求到达的是后台主进程（焦点在浏览器侧），shell.openPath 会使 explorer 新窗口被
// Windows 前台锁压制、后台冒出。改为 cmd /c start（ShellExecute 方式）让 explorer 获得前台激活权
function openDirForeground(target) {
  return new Promise((resolve) => {
    // cmd /c start "" "path"：start 首个参数为窗口标题（空），第二个为目标目录
    execFile('cmd.exe', ['/c', 'start', '""', '"' + target + '"'], { windowsHide: true }, (err) => {
      if (err) resolve({ ok: false, error: String(err && err.message || err) });
      else resolve({ ok: true });
    });
  });
}

// 纯 backend 类 channel：直接转发到 api.<method>，args 数组展开
// [channel, apiMethod, argTransform?] argTransform 可选，用于处理布尔/默认值
const PURE_BACKEND_ROUTES = {
  list_projects: { m: 'listProjects', a: (args) => [!!args[0]] },
  list_versions: { m: 'listVersions', a: (args) => [args[0], args[1]] },
  read_config: { m: 'readConfig', a: (args) => [args[0]] },
  save_config: { m: 'saveConfig', a: (args) => [args[0], args[1], args[2], args[3]] },
  save_config_today: { m: 'saveConfigToday', a: (args) => [args[0], args[1], args[2], args[3], args[4], args[5]] },
  new_empty_config: { m: 'newEmptyConfig', a: (args) => [args[0]] },
  remove_branch: { m: 'removeBranch', a: (args) => [args[0], args[1]] },
  branch_other_txt: { m: 'branchOtherTxt', a: (args) => [args[0]] },
  precheck: { m: 'precheck', a: (args) => [args[0], args[1]] },
  list_logs: { m: 'listLogs', a: (args) => [args[0], args[1], args[2]] },
  search_logs: { m: 'searchLogs', a: (args) => [args[0]] },
  get_log_content: { m: 'logContent', a: (args) => [args[0], args[1]] },
  list_log_files: { m: 'listLogFiles', a: (args) => [args[0], args[1]] },
  find_replica_output: { m: 'findReplicaOutput', a: (args) => [args[0], args[1]] },
  check_exists: { m: 'checkExists', a: (args) => [args[0]] },
  check_watermark_project: { m: 'checkWatermarkProject', a: (args) => [args[0], args[1]] },
  find_watermark_project: { m: 'findWatermarkProject', a: (args) => [args[0], args[1]] },
  get_project_watermark: { m: 'getProjectWatermark', a: (args) => [args[0]] },
  set_project_watermark: { m: 'setProjectWatermark', a: (args) => [args[0], args[1], args[2], args[3], args[4], args[5]] },
  run_batch: { m: 'runBatch', a: (args) => [args[0], args[1], args[2]] },
  run_replica: { m: 'runReplica', a: (args) => [args[0], args[1], args[2]] },
  continue_replica: { m: 'continueReplica', a: (args) => [args[0]] },
  list_tasks: { m: 'snapshotTasks', a: () => [] },
  stop_task: { m: 'stopTask', a: (args) => [args[0]] },
  rerun_task: { m: 'rerunTask', a: (args) => [args[0]] },
  pin_task: { m: 'pinTask', a: (args) => [args[0]] },
  reorder_tasks: { m: 'reorderTasks', a: (args) => [args[0]] },
  pause_task: { m: 'pauseTask', a: (args) => [args[0]] },
  resume_task: { m: 'resumeTask', a: (args) => [args[0]] },
  clear_finished_tasks: { m: 'clearFinishedTasks', a: (args) => [args[0]] },
  clear_done_tasks: { m: 'clearDoneTasks', a: (args) => [args[0] || {}] },
  get_changelog: { m: 'getChangelog', a: () => [] },
  get_readme: { m: 'getReadme', a: () => [] },
  clear_task: { m: 'clearTask', a: (args) => [args[0]] },
  regroup_task: { m: 'regroupTask', a: (args) => [args[0], args[1]] },
  resume_all_tasks: { m: 'resumeAllTasks', a: () => [] },
  pause_all_tasks: { m: 'pauseAllTasks', a: () => [] },
  run_mask: { m: 'runMask', a: (args) => [args[0]] },
  continue_mask: { m: 'continueMask', a: (args) => [args[0]] },
  list_mask_projects: { m: 'listMaskProjects', a: () => [] },
  list_mask_videos: { m: 'listMaskVideos', a: (args) => [args[0]] },
  list_mask_masks: { m: 'listMaskMasks', a: (args) => [args[0]] },
  scan_mask_raw_dirs: { m: 'scanMaskRawDirs', a: (args) => [args[0]] },
  scan_mask_theme_sig: { m: 'maskThemeSig', a: (args) => [args[0]] },
  list_mask_logs: { m: 'listMaskLogs', a: (args) => [args[0]] },
  get_mask_session: { m: 'getMaskSession', a: (args) => [args[0]] },
  save_mask_session: { m: 'saveMaskSession', a: (args) => [args[0], args[1]] },
  clear_mask_session: { m: 'clearMaskSession', a: (args) => [args[0]] },
  get_mask_default_dir: { m: 'getMaskDefaultDir', a: (args) => [args[0]] },
  set_mask_default_dir: { m: 'setMaskDefaultDir', a: (args) => [args[0], args[1]] },
  delete_mask_related: { m: 'deleteMaskRelated', a: (args) => [args[0], args[1]] },
  delete_mask_videos: { m: 'deleteMaskVideos', a: (args) => [args[0], args[1]] },
  move_mask_out: { m: 'moveMaskOut', a: (args) => [args[0], args[1], args[2]] },
  delete_secondary_products: { m: 'deleteSecondaryProducts', a: (args) => [args[0], args[1]] },
  clean_duplicate_star: { m: 'cleanDuplicateStar', a: (args) => [!!args[0]] },
  get_root: { m: 'getRoot', a: () => [] },
  check_env: { m: 'checkEnv', a: () => [] },
  cancel_precheck: { m: 'cancelPrecheck', a: () => [] },
};

function startHttpServer(opts) {
  const api = opts.api;
  const getMainWin = opts.getMainWin || (() => null);
  const getSettingsWin = opts.getSettingsWin || (() => null);
  const extraRoutes = opts.extraRoutes || {};
  const httpPort = opts.httpPort || 9527;
  // 广播函数：由 main.js 注入，同时推 webContents.send 和 SSE
  const broadcast = opts.broadcast || (function () {});
  // 固定 token：main.js 注入（config.http_token，首次启动生成后持久化，此后长期复用）；
  // 未注入（如独立测试）时才临时随机生成
  const httpToken = (typeof opts.httpToken === 'string' && opts.httpToken) || crypto.randomBytes(16).toString('hex');
  const sseClients = new Set();

  // SSE 广播：遍历所有连接的 SSE 客户端推送事件
  function sseBroadcast(event, data) {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data === undefined ? null : data)}\n\n`;
    for (const res of sseClients) {
      try { res.write(payload); } catch (e) {}
    }
  }
  // 统一广播：同时推 Electron 窗口和 SSE 客户端
  function broadcastAll(event, data) {
    try { broadcast(event, data); } catch (e) {}
    sseBroadcast(event, data);
  }

  // dialog/shell 类路由（浏览器侧后端代劳）
  const dialogRoutes = {
    choose_mask_file: async (args) => {
      const win = getMainWin();
      const prev = args[0] || (api.getRoot() || '');
      const r = await dialog.showOpenDialog(win || undefined, { title: '选择水印文件', defaultPath: prev, properties: ['openFile'], filters: [{ name: '视频水印', extensions: ['mov', 'mp4'] }] });
      if (r.canceled || !r.filePaths || !r.filePaths.length) return { ok: false };
      return { ok: true, path: r.filePaths[0] };
    },
    pick_directory: async (args) => {
      const win = getMainWin() || getSettingsWin();
      const result = await dialog.showOpenDialog(win || undefined, { title: args[0] || '选择目录', defaultPath: args[1] || api.getRoot() || '', properties: ['openDirectory'] });
      return result.canceled || !result.filePaths || result.filePaths.length === 0 ? '' : result.filePaths[0];
    },
    choose_workdir: async () => {
      const win = getMainWin();
      const result = await dialog.showOpenDialog(win || undefined, { title: '选择工作路径', defaultPath: api.getRoot(), properties: ['openDirectory'] });
      if (result.canceled || !result.filePaths || result.filePaths.length === 0) return { ok: false, canceled: true };
      const dir = result.filePaths[0];
      return { ok: true, root: dir, projects: api.listProjects() };
    },
    pick_watermark: async (args) => {
      const win = getMainWin();
      const defaultPath = String(args[0] || '').trim();
      const result = await dialog.showOpenDialog(win || undefined, { title: '选择水印 PNG', defaultPath, properties: ['openFile'], filters: [{ name: 'PNG 图片', extensions: ['png'] }] });
      return result.canceled || !result.filePaths || result.filePaths.length === 0 ? '' : result.filePaths[0];
    },
    pick_exclude: async () => {
      const win = getMainWin();
      const result = await dialog.showOpenDialog(win || undefined, { title: '选择要排除的路径（文件夹或视频文件）', defaultPath: api.getRoot(), properties: ['openFile', 'openDirectory', 'multiSelections'] });
      return result.canceled || !result.filePaths || result.filePaths.length === 0 ? [] : result.filePaths;
    },
    pick_paths: async () => {
      const win = getMainWin();
      const result = await dialog.showOpenDialog(win || undefined, { title: '选择要添加的文件夹', defaultPath: api.getRoot(), properties: ['openDirectory', 'multiSelections'] });
      return result.canceled || !result.filePaths || result.filePaths.length === 0 ? [] : result.filePaths;
    },
    pick_paths_files: async () => {
      const win = getMainWin();
      const result = await dialog.showOpenDialog(win || undefined, { title: '选择视频文件（支持 mp4/mov/avi/mkv 等 / .lnk 快捷方式）', defaultPath: api.getRoot(), properties: ['openFile', 'multiSelections'], filters: [{ name: '视频文件', extensions: ['mp4', 'mov', 'avi', 'mkv', 'm4v', 'webm', 'flv', 'lnk'] }] });
      return result.canceled || !result.filePaths || result.filePaths.length === 0 ? [] : result.filePaths;
    },
    pick_paths_dirs: async () => {
      const win = getMainWin();
      const result = await dialog.showOpenDialog(win || undefined, { title: '选择文件夹（将递归扫描其中视频）', defaultPath: api.getRoot(), properties: ['openDirectory', 'multiSelections'] });
      return result.canceled || !result.filePaths || result.filePaths.length === 0 ? [] : result.filePaths;
    },
    resolve_shortcut: async (args) => api.resolveShortcut(args[0]),
    mask_add_source: async (args) => api.maskAddSource(args[0], args[1]),
    pick_single_folder: async () => {
      const win = getMainWin();
      const result = await dialog.showOpenDialog(win || undefined, { title: '选择要修改为的文件夹', defaultPath: api.getRoot(), properties: ['openDirectory'] });
      return result.canceled || !result.filePaths || result.filePaths.length === 0 ? '' : result.filePaths[0];
    },
  };

  const shellRoutes = {
    open_external: async (args) => {
      const url = args[0];
      if (typeof url === 'string' && /^https?:\/\//.test(url)) {
        const err = await shell.openExternal(url);
        return err ? { ok: false, error: err } : { ok: true };
      }
      return { ok: false, error: '无效链接' };
    },
    open_replica_output: async (args) => {
      const r = api.taskReplicaOutputDir(args[0]);
      if (!r.ok) return r;
      return openDirForeground(r.dir);
    },
    open_path: async (args) => {
      const p = args[0];
      const target = path.resolve(p);
      if (!fs.existsSync(target)) return { ok: false, error: '路径不存在' };
      // 目录走前台方式（与本体一致）；文件保持 shell.openPath 打开关联程序
      if (fs.statSync(target).isDirectory()) return openDirForeground(target);
      const err = await shell.openPath(target);
      return err ? { ok: false, error: err } : { ok: true };
    },
    open_parent: async (args) => {
      const p = args[0];
      const target = path.dirname(path.resolve(p));
      if (fs.existsSync(target)) return openDirForeground(target);
      return { ok: false, error: '路径不存在' };
    },
    open_folder_select: async (args) => {
      const p = String(args[0] || '').replace(/^"|"$/g, '');
      const target = path.resolve(p);
      if (target && fs.existsSync(target)) { shell.showItemInFolder(target); return { ok: true }; }
      return { ok: false, error: '路径不存在' };
    },
    open_project_dir: async (args) => {
      const project = args[0];
      const root = api.getRoot();
      const target = path.resolve(root || '', String(project || ''));
      if (fs.existsSync(target)) return openDirForeground(target);
      return { ok: false, error: '项目目录不存在' };
    },
    external_edit: async (args) => {
      const p = args[0];
      const target = path.resolve(p);
      if (fs.existsSync(target) && fs.statSync(target).isFile()) {
        const err = await shell.openPath(target);
        return err ? { ok: false, error: err } : { ok: true };
      }
      return { ok: false, error: '文件不存在' };
    },
  };

  // 推进度类路由（通过 broadcastAll 推送事件）
  const progressRoutes = {
    reset_precheck: (args) => api.resetPrecheck((s) => { broadcastAll('reset_progress', s); }),
    refresh_precache: (args) => api.refreshPrecache((s) => { broadcastAll('reset_progress', s); }),
    locate_task: (args) => {
      const taskId = args[0];
      const target = args[1];
      const info = api.taskLocate(taskId);
      if (!info || !info.ok) return info;
      const payload = Object.assign({}, info, { target: target === 'log' ? 'log' : 'config', taskId });
      broadcastAll('locate_request', payload);
      return info;
    },
  };

  // 浏览器侧降级路由：返回不支持
  const unsupportedRoutes = {
    window_caps: () => ({ minimizable: false, maximizable: false, closable: false }),
    window_minimize: () => ({ ok: true }),
    window_toggle_maximize: () => ({ ok: true }),
    window_close: () => ({ ok: true }),
    window_max_changed_listen: () => ({ ok: true }),
    tray_menu_click: () => ({ ok: false, error: '浏览器侧不支持' }),
    choose_close_behavior: () => ({ ok: false, error: '浏览器侧不支持' }),
    confirm_quit: () => ({ ok: false, error: '浏览器侧不支持' }),
    force_close_settings: () => ({ ok: true }),
    open_task_window: () => { return { ok: false, error: 'browser_redirect', url: '/task' }; },
    open_settings_window: () => { return { ok: false, error: 'browser_redirect', url: '/settings' }; },
    start_update: () => ({ ok: false, error: '请在应用本体中完成更新' }),
    apply_update: () => ({ ok: false, error: '请在应用本体中完成更新' }),
    reveal_update_file: () => ({ ok: false, error: '请在应用本体中完成更新' }),
  };

  // 合并所有路由
  function resolveRoute(channel) {
    if (PURE_BACKEND_ROUTES[channel]) {
      const r = PURE_BACKEND_ROUTES[channel];
      return (args) => api[r.m].apply(api, r.a(args || []));
    }
    if (dialogRoutes[channel]) return dialogRoutes[channel];
    if (shellRoutes[channel]) return shellRoutes[channel];
    if (progressRoutes[channel]) return progressRoutes[channel];
    if (unsupportedRoutes[channel]) return unsupportedRoutes[channel];
    if (extraRoutes[channel]) return extraRoutes[channel];
    return null;
  }

  // token 校验
  function checkToken(req) {
    const url = new URL(req.url, 'http://localhost');
    const qToken = url.searchParams.get('token');
    if (qToken && qToken === httpToken) return true;
    const hToken = req.headers['x-token'];
    if (hToken && hToken === httpToken) return true;
    return false;
  }

  // MIME 类型
  const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
    '.svg': 'image/svg+xml',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
  };

  function serveStatic(req, res, filePath) {
    fs.readFile(filePath, (err, data) => {
      if (err) { res.writeHead(404); res.end('Not Found'); return; }
      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-cache, no-store, must-revalidate' });
      res.end(data);
    });
  }

  function handleApi(req, res, body) {
    let args;
    try { args = body ? JSON.parse(body) : []; } catch (e) { args = []; }
    if (!Array.isArray(args)) args = [args];
    // 从 URL 路径提取 channel：/api/<channel>
    const m = req.url.match(/^\/api\/([a-z_]+)/);
    const channel = m ? m[1] : '';
    const handler = resolveRoute(channel);
    if (!handler) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: '未知接口: ' + channel }));
      return;
    }
    Promise.resolve().then(() => handler(args)).then((result) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, data: result === undefined ? null : result }));
    }).catch((err) => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: String(err && err.message || err) }));
    });
  }

  function handleSSE(req, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    res.write(': connected\n\n');
    sseClients.add(res);
    req.on('close', () => { sseClients.delete(res); });
  }

  // PWA manifest
  const manifest = JSON.stringify({
    name: 'Video Lab',
    short_name: 'Video Lab',
    description: 'Video Lab — 批量成片项目管理',
    start_url: './',
    display: 'standalone',
    background_color: '#ffffff',
    theme_color: '#6a6fff',
    icons: [
      { src: '/icon/app-icon.png', sizes: '192x192', type: 'image/png' },
      { src: '/icon/app-icon.png', sizes: '512x512', type: 'image/png' },
    ],
  });

  // 最小 service worker（仅满足 PWA 安装条件，不缓存）
  const SW_JS = `self.addEventListener('install', e => self.skipWaiting());\nself.addEventListener('activate', e => self.clients.claim());\nself.addEventListener('fetch', e => {});`;

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname;

    // 静态资源（无需 token）
    if (pathname === '/' || pathname === '/index.html') {
      serveStatic(req, res, path.join(FRONTEND_DIR, 'index.html'));
      return;
    }
    if (pathname === '/task' || pathname === '/task.html') {
      serveStatic(req, res, path.join(FRONTEND_DIR, 'task.html'));
      return;
    }
    if (pathname === '/settings' || pathname === '/settings.html') {
      serveStatic(req, res, path.join(FRONTEND_DIR, 'settings.html'));
      return;
    }
    if (pathname === '/guide' || pathname === '/guide.html') {
      serveStatic(req, res, path.join(FRONTEND_DIR, 'guide.html'));
      return;
    }
    if (pathname === '/manifest.json') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(manifest);
      return;
    }
    if (pathname === '/sw.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
      res.end(SW_JS);
      return;
    }
    if (pathname.startsWith('/frontend/')) {
      const rel = pathname.slice('/frontend/'.length).replace(/\.\.\//g, '');
      serveStatic(req, res, path.join(FRONTEND_DIR, rel));
      return;
    }
    if (pathname.startsWith('/icon/')) {
      const rel = pathname.slice('/icon/'.length).replace(/\.\.\//g, '');
      serveStatic(req, res, path.join(ICON_DIR, rel));
      return;
    }
    // HTML/CSS/JS 相对路径兜底：HTML 引用「styles.css / skins/white_blue.css / icons.js /
    // app.js / txapi.js」等相对路径（与 Electron file: 协议下 HTML 位于 frontend/ 目录一致），
    // 以及 CSS 内 url() 相对资源（assets/...、skins/assets/...），统一按 frontend/ 根解析。
    // 仅当文件实际存在时服务，避免把未知请求误判为 404 之外的资源
    {
      const rel = pathname.replace(/^\/+/, '').replace(/\.\.\//g, '');
      const fp = path.join(FRONTEND_DIR, rel);
      if (rel && fs.existsSync(fp) && fs.statSync(fp).isFile()) {
        serveStatic(req, res, fp);
        return;
      }
    }

    // SSE 端点（需 token）
    if (pathname === '/events') {
      if (!checkToken(req)) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
      }
      handleSSE(req, res);
      return;
    }

    // API 端点（需 token）
    if (pathname.startsWith('/api/')) {
      if (!checkToken(req)) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: '无效 token' }));
        return;
      }
      if (req.method === 'POST') {
        let body = '';
        req.on('data', c => { body += c; if (body.length > 10 * 1024 * 1024) req.destroy(); });
        req.on('end', () => handleApi(req, res, body));
        req.on('error', () => { res.writeHead(400); res.end('Bad Request'); });
      } else {
        // GET 请求也支持（无 body 时 args 为空数组）
        handleApi(req, res, '');
      }
      return;
    }

    res.writeHead(404);
    res.end('Not Found');
  });

  let started = false;
  let actualPort = httpPort;
  return new Promise((resolve) => {
    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE' && !started) {
        // 端口被占用，尝试 +1 重试最多 10 次
        server.close();
        let tryPort = httpPort + 1;
        let attempts = 0;
        function tryNext() {
          if (attempts >= 10) {
            resolve({ ok: false, error: '端口 ' + httpPort + '-'+(httpPort+10)+' 均被占用', broadcastAll });
            return;
          }
          const tmp = http.createServer();
          tmp.on('error', () => { attempts++; tryPort++; tmp.close(); tryNext(); });
          tmp.listen(tryPort, '127.0.0.1', () => { tmp.close(); actualPort = tryPort; doListen(); });
        }
        tryNext();
      } else {
        resolve({ ok: false, error: String(err.message || err), broadcastAll });
      }
    });
    function doListen() {
      server.listen(actualPort, '127.0.0.1', () => {
        started = true;
        resolve({
          ok: true,
          port: actualPort,
          token: httpToken,
          url: 'http://localhost:' + actualPort + '/?token=' + httpToken,
          broadcastAll,
          close: () => { try { server.close(); } catch (e) {} },
        });
      });
    }
    doListen();
  });
}

module.exports = { startHttpServer };
