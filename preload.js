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
  on_reset_progress: (cb) => {
    const ch = (e, s) => { try { cb(s); } catch (err) {} };
    ipcRenderer.on('reset_progress', ch);
    return () => { ipcRenderer.removeListener('reset_progress', ch); };
  },
  list_logs: (project, name, versionPath) => invoke('list_logs', project, name, versionPath),
  search_logs: (query) => invoke('search_logs', query),
  get_log_content: (fromPath, configName) => invoke('get_log_content', fromPath, configName),
  list_log_files: (fromPath, configName) => invoke('list_log_files', fromPath, configName),
  check_exists: (paths) => invoke('check_exists', paths),
  run_batch: (p, count, group) => invoke('run_batch', p, count, group),
  run_replica: (logPath, mode, entryVideo) => invoke('run_replica', logPath, mode, entryVideo),
  list_tasks: () => invoke('list_tasks'),
  stop_task: (id) => invoke('stop_task', id),
  pin_task: (id) => invoke('pin_task', id),
  reorder_tasks: (ids) => invoke('reorder_tasks', ids),
  pause_task: (id) => invoke('pause_task', id),
  resume_task: (id) => invoke('resume_task', id),
  clear_finished_tasks: (statuses) => invoke('clear_finished_tasks', statuses),
  clear_task: (id) => invoke('clear_task', id),
  resume_all_tasks: () => invoke('resume_all_tasks'),
  pause_all_tasks: () => invoke('pause_all_tasks'),
  confirm_quit: () => invoke('confirm_quit'),
  on_confirm_quit_request: (cb) => { ipcRenderer.on('confirm_quit_request', () => { try { cb(); } catch (e) {} }); },
  open_task_window: () => invoke('open_task_window'),
  open_settings_window: () => invoke('open_settings_window'),
  get_settings: () => invoke('get_settings'),
  save_settings: (s) => invoke('save_settings', s),
  pick_directory: (title, defaultPath) => invoke('pick_directory', title, defaultPath),
  on_settings_saved: (cb) => { ipcRenderer.on('settings_saved', (e, cfg) => { try { cb(cfg); } catch (err) {} }); },
  notify_dirty: (d) => { try { ipcRenderer.send('settings_dirty', !!d); } catch (e) {} },
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
  check_env: () => invoke('check_env'),
  get_skin: () => invoke('get_skin'),
  set_skin: (skin) => invoke('set_skin', skin),
  choose_workdir: () => invoke('choose_workdir'),
});
