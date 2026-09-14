// ffmpeg 统一调用：数组参数（免引号转义，中文/空格路径安全）+ GPU 编码硬约束 + 进度/错误分流
'use strict';

const { spawn } = require('node:child_process');

// 硬约束：GPU 编码参数固定注入，禁止回退 libx264
const NVENC_ARGS = ['-c:v', 'h264_nvenc', '-preset', 'p4', '-rc', 'vbr', '-cq', '27', '-profile:v', 'high', '-level', '4.1'];

function runFfmpeg(args, { onProgress, signal, cwd, env, binary = 'ffmpeg' } = {}) {
  return new Promise((resolve) => {
    const child = spawn(binary, args, {
      windowsHide: true,
      signal,
      cwd,
      env: Object.assign({}, process.env, env),
    });
    let stderr = '';
    child.stderr && child.stderr.on('data', (buf) => {
      const text = buf.toString('utf8');
      stderr += text;
      for (const line of text.split(/\r?\n/)) {
        if (!line) continue;
        if (/frame\s*=|time\s*=/.test(line)) onProgress && onProgress(line);
      }
    });
    child.on('error', (err) => resolve({ code: -1, stderr, error: err.message }));
    child.on('close', (code) => resolve({ code: code == null ? -1 : code, stderr, error: null }));
  });
}

module.exports = { runFfmpeg, NVENC_ARGS };