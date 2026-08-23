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
  list_logs: (project, name, versionPath) => invoke('list_logs', project, name, versionPath),
  search_logs: (query) => invoke('search_logs', query),
  get_log_content: (fromPath) => invoke('get_log_content', fromPath),
  check_exists: (paths) => invoke('check_exists', paths),
  run_batch: (p, count, group) => invoke('run_batch', p, count, group),
  run_replica: (logPath, mode) => invoke('run_replica', logPath, mode),
  list_tasks: () => invoke('list_tasks'),
  stop_task: (id) => invoke('stop_task', id),
  pause_task: (id) => invoke('pause_task', id),
  resume_task: (id) => invoke('resume_task', id),
  clear_finished_tasks: () => invoke('clear_finished_tasks'),
  open_task_window: () => invoke('open_task_window'),
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
