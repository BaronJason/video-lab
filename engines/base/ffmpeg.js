// ffmpeg 统一调用：数组参数（免引号转义，中文/空格路径安全）+ GPU 编码硬约束 + 进度/错误分流
'use strict';

const { spawn } = require('node:child_process');

// 硬约束：GPU 编码参数固定注入，禁止回退 libx264
const NVENC_ARGS = ['-c:v', 'h264_nvenc', '-preset', 'p4', '-rc', 'vbr', '-cq', '27', '-profile:v', 'high', '-level', '4.1'];

/**
 * 按 CQ 生成编码参数（其余参数一律用硬约束值，**不开放调整**）。
 * 工具侧的「码率控制」步骤只改 CQ，其余由本源统一注入 —— 避免各处手写参数写出偏门组合。
 * @param {number|null|undefined} cq 传 null/undefined 时用默认 27
 */
function nvencArgs(cq) {
  const q = (cq == null || !isFinite(Number(cq))) ? '27' : String(Math.round(Number(cq)));
  return NVENC_ARGS.map((x) => (x === '27' ? q : x));
}

/**
 * @param {string[]} args
 * @param {{onProgress?:Function, signal?:any, cwd?:string, env?:object, binary?:string,
 *          captureStdout?:boolean}} opts
 *   captureStdout —— 是否需要收集 stdout。ffmpeg 的诊断类滤镜（如 metadata=print）
 *   默认把结果写到 **stdout**（`file=-`）而不是 stderr，需要这类输出的调用方要开启它。
 * @returns {Promise<{code:number, stderr:string, stdout:string, error:string|null}>}
 */
function runFfmpeg(args, { onProgress, signal, cwd, env, binary = 'ffmpeg', captureStdout = false } = {}) {
  return new Promise((resolve) => {
    const child = spawn(binary, args, {
      windowsHide: true,
      signal,
      cwd,
      env: Object.assign({}, process.env, env),
    });
    let stderr = '';
    let stdout = '';
    let _errLine = '';   // stderr 跨 chunk 行缓冲：进程管道按缓冲区分块，stats 行可能被从中间切开
    child.stdout && child.stdout.on('data', (buf) => {
      if (!captureStdout) return;
      stdout += buf.toString('utf8');
    });
    child.stderr && child.stderr.on('data', (buf) => {
      const text = buf.toString('utf8');
      stderr += text;
      // ★ 必须跨 chunk 缓冲：`-stats` 的进度行是 `frame=...\rframe=...\r...` 的回车刷新流，
      //   网络管道按缓冲区切块会把 `frame=` 从中间切断（实测切成 `e= 468 fps=...`），
      //   残段漏进任务日志就是用户看到的"格式不统一"。攒齐完整行再处理。
      _errLine += text;
      const lines = _errLine.split(/\r?\n/);
      _errLine = lines.pop() || '';            // 尾段不完整，留待下个 chunk 拼合
      for (const line of lines) {
        if (!line) continue;
        // 一条日志行内可能含多个 \r 覆盖段，逐段转发
        for (const seg of line.split('\r')) {
          if (!seg) continue;
          // 行首锚定的 stats 段（与 backend 的折叠正则同一口径，残段不再外漏）
          if (/^\s*(frame|fps|q|size|time|bitrate|dup|drop|speed|elapsed)\s*=/.test(seg)) {
            onProgress && onProgress(seg);
          }
        }
      }
    });
    child.on('error', (err) => resolve({ code: -1, stderr, stdout, error: err.message }));
    child.on('close', (code) => resolve({ code: code == null ? -1 : code, stderr, stdout, error: null }));
  });
}

module.exports = { runFfmpeg, NVENC_ARGS, nvencArgs };