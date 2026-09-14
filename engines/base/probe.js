// ffprobe 封装：视频元信息 + 有效性判定（1080×1920 且 duration>0，与 PS1 对齐）
'use strict';

const { spawn } = require('node:child_process');
const { exists } = require('./paths');

function probe(videoPath) {
  return new Promise((resolve) => {
    if (!exists(videoPath)) {
      // 防御版（对齐 replica）：路径不存在返回无效对象，不抛异常
      return resolve({ valid: false, duration: 0, width: 0, height: 0 });
    }
    const args = ['-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      videoPath];
    const child = spawn('ffprobe', args, { windowsHide: true });
    let out = '';
    child.stdout && child.stdout.on('data', (b) => { out += b.toString('utf8'); });
    child.on('close', (code) => {
      const lines = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      let width = 0, height = 0, duration = 0;
      if (code === 0 && lines.length >= 3) {
        width = parseInt(lines[0], 10) || 0;
        height = parseInt(lines[1], 10) || 0;
        duration = parseFloat(lines[2]) || 0;
      }
      const valid = width === 1080 && height === 1920 && duration > 0;
      resolve({ valid, duration, width, height });
    });
    child.on('error', () => resolve({ valid: false, duration: 0, width: 0, height: 0 }));
  });
}

module.exports = { probe };