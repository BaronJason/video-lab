// -*- coding: utf-8 -*-
// Electron preload：通过 contextBridge 向渲染进程暴露后端 API。
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('txapi', {
  list_projects: (force) => invoke('list_projects', force),
  list_versions: (project, name) => invoke('list_versions', project, name),
  read_config: (p) => invoke('read_config', p),
  save_config: (p, folders, excludes, watermark) =>
    invoke('save_config', p, folders, excludes, watermark),
  save_config_today: (project, name, configName, folders, excludes, watermark) =>
    invoke('save_config_today', project, name, configName, folders, excludes, watermark),
  precheck: (paths, excludes) => invoke('precheck', paths, excludes),
  reset_precheck: () => invoke('reset_precheck'),
  refresh_precache: () => invoke('refresh_precache'),
  cancel_precheck: () => invoke('cancel_precheck'),
  get_autostart: () => invoke('get_autostart'),
  set_autostart: (en) => invoke('set_autostart', !!en),
  on_reset_progress: (cb) => {
    const ch = (e, s) => { try { cb(s); } catch (err) {} };
    ipcRenderer.on('reset_progress', ch);
    return () => { ipcRenderer.removeListener('reset_progress', ch); };
  },
  on_scan_progress: (cb) => {
    const ch = (e, p) => { try { cb(p); } catch (err) {} };
    ipcRenderer.on('scan_progress', ch);
    return () => { ipcRenderer.removeListener('scan_progress', ch); };
  },
  list_logs: (project, name, versionPath) => invoke('list_logs', project, name, versionPath),
  search_logs: (query) => invoke('search_logs', query),
  get_log_content: (fromPath, configName) => invoke('get_log_content', fromPath, configName),
  list_log_files: (fromPath, configName) => invoke('list_log_files', fromPath, configName),
  check_exists: (paths) => invoke('check_exists', paths),
  check_watermark_project: (project, wm) => invoke('check_watermark_project', project, wm),
  find_watermark_project: (project, wm) => invoke('find_watermark_project', project, wm),
  run_batch: (p, count, group) => invoke('run_batch', p, count, group),
  run_replica: (logPath, mode, entryVideo) => invoke('run_replica', logPath, mode, entryVideo),
  list_tasks: () => invoke('list_tasks'),
  stop_task: (id) => invoke('stop_task', id),
  pin_task: (id) => invoke('pin_task', id),
  reorder_tasks: (ids) => invoke('reorder_tasks', ids),
  pause_task: (id) => invoke('pause_task', id),
  resume_task: (id) => invoke('resume_task', id),
  clear_finished_tasks: (statuses) => invoke('clear_finished_tasks', statuses),
  clear_done_tasks: (opts) => invoke('clear_done_tasks', opts),
  get_changelog: () => invoke('get_changelog'),
  get_changelog_popup: () => invoke('get_changelog_popup'),
  get_readme: () => invoke('get_readme'),
  watermark_preview_show: (fileUrl) => invoke('watermark_preview_show', fileUrl),
  watermark_preview_move: (x, y) => invoke('watermark_preview_move', x, y),
  watermark_preview_hide: () => invoke('watermark_preview_hide'),
  clear_task: (id) => invoke('clear_task', id),
  resume_all_tasks: () => invoke('resume_all_tasks'),
  pause_all_tasks: () => invoke('pause_all_tasks'),
  confirm_quit: () => invoke('confirm_quit'),
  on_confirm_quit_request: (cb) => { ipcRenderer.on('confirm_quit_request', () => { try { cb(); } catch (e) {} }); },
  open_task_window: () => invoke('open_task_window'),
  open_settings_window: () => invoke('open_settings_window'),
  clean_duplicate_star: (commit) => invoke('clean_duplicate_star', commit),
  open_external: (url) => invoke('open_external', url),
  check_update: (silent) => invoke('check_update', !!silent),
  get_runtime: () => invoke('get_runtime'),
  get_app_version: () => invoke('get_app_version'),
  start_update: () => invoke('start_update'),
  apply_update: () => invoke('apply_update'),
  reveal_update_file: () => invoke('reveal_update_file'),
  on_update_available: (cb) => { ipcRenderer.on('update_available', (e, info) => { try { cb(info); } catch (err) {} }); },
  on_update_progress: (cb) => { ipcRenderer.on('update_downloading', (e, info) => { try { cb(info); } catch (err) {} }); },
  on_update_status: (cb) => { ipcRenderer.on('update_status', (e, text) => { try { cb(text); } catch (err) {} }); },
  on_update_none: (cb) => { ipcRenderer.on('update_none', (e, info) => { try { cb(info); } catch (err) {} }); },
  on_update_error: (cb) => { ipcRenderer.on('update_error', (e, info) => { try { cb(info); } catch (err) {} }); },
  on_update_ready: (cb) => { ipcRenderer.on('update_ready', (e, info) => { try { cb(info); } catch (err) {} }); },
  on_update_downloaded: (cb) => { ipcRenderer.on('update_downloaded', (e, info) => { try { cb(info); } catch (err) {} }); },
  on_check_update_result: (cb) => { ipcRenderer.on('check_update_result', (e, info) => { try { cb(info); } catch (err) {} }); },
  get_settings: () => invoke('get_settings'),
  save_settings: (s) => invoke('save_settings', s),
  pick_directory: (title, defaultPath) => invoke('pick_directory', title, defaultPath),
  on_settings_saved: (cb) => { ipcRenderer.on('settings_saved', (e, cfg) => { try { cb(cfg); } catch (err) {} }); },
  notify_dirty: (d) => { try { ipcRenderer.send('settings_dirty', !!d); } catch (e) {} },
  on_confirm_discard: (cb) => { ipcRenderer.on('confirm_discard_request', () => { try { cb(); } catch (e) {} }); },
  force_close_settings: () => invoke('force_close_settings'),
  on_settings_flash_close: (cb) => { ipcRenderer.on('settings_flash_close', () => { try { cb(); } catch (e) {} }); },
  on_settings_window_opened: (cb) => { ipcRenderer.on('settings_window_opened', () => { try { cb(); } catch (e) {} }); },
  on_settings_window_closed: (cb) => { ipcRenderer.on('settings_window_closed', () => { try { cb(); } catch (e) {} }); },
  on_task_update: (cb) => { ipcRenderer.on('task_update', (e, tasks) => { try { cb(tasks); } catch (err) {} }); },
  open_path: (p) => invoke('open_path', p),
  open_parent: (p) => invoke('open_parent', p),
  external_edit: (p) => invoke('external_edit', p),
  pick_watermark: () => invoke('pick_watermark'),
  pick_exclude: () => invoke('pick_exclude'),
  pick_paths: () => invoke('pick_paths'),
  get_root: () => invoke('get_root'),
  save_guide: (s) => invoke('save_guide', s),
  check_env: () => invoke('check_env'),
  get_skin: () => invoke('get_skin'),
  set_skin: (skin) => invoke('set_skin', skin),
  choose_workdir: () => invoke('choose_workdir'),
  // 自制标题栏（frame:false）窗口控制
  window_caps: () => invoke('window_caps'),
  window_minimize: () => invoke('window_minimize'),
  window_toggle_maximize: () => invoke('window_toggle_maximize'),
  window_close: () => invoke('window_close'),
  listen_window_max: () => { try { ipcRenderer.send('window_max_changed_listen'); } catch (e) {} },
  on_window_max_changed: (cb) => { ipcRenderer.on('window_max_changed', (e, m) => { try { cb(!!m); } catch (err) {} }); },
});
