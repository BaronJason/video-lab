// ffmpeg 统一调用：数组参数（免引号转义，中文/空格路径安全）+ GPU 编码硬约束 + 进度/错误分流
'use strict';

const { spawn } = require('node:child_process');

// 硬约束：GPU 编码参数固定注入，禁止回退 libx264。
// 三档编码格式全部走 NVENC（RTX 40 系原生支持 AV1），供「转码 / 码率」步骤按格式选用：
// · H.264 —— 最通用（播放器/剪辑软件/手机全支持），默认档，行为与历史一致
// · H.265 —— 同画质体积更小；**必须带 hvc1 标签**（mp4 里默认 hev1 时 Windows 照片、
//   部分剪辑软件与预览组件不认，产物会"打不开"，进而拖垮下游模块 —— 兼容性硬保障）
// · AV1 —— 体积最小；mp4 内默认 av01 标签即通用写法
const NVENC_CODECS = {
  h264: ['-c:v', 'h264_nvenc', '-preset', 'p4', '-rc', 'vbr', '-cq', '27', '-profile:v', 'high', '-level', '4.1'],
  hevc: ['-c:v', 'hevc_nvenc', '-preset', 'p4', '-rc', 'vbr', '-cq', '27', '-tag:v', 'hvc1'],
  av1: ['-c:v', 'av1_nvenc', '-preset', 'p4', '-rc', 'vbr', '-cq', '27'],
};
const NVENC_ARGS = NVENC_CODECS.h264;

/**
 * 按 CQ（+ 可选编码格式）生成编码参数（其余参数一律用硬约束值，**不开放调整**）。
 * 工具侧的「转码 / 码率」步骤只改 CQ 与编码格式，其余由本源统一注入 —— 避免各处手写参数写出偏门组合。
 * @param {number|null|undefined} cq 传 null/undefined 时用默认 27
 * @param {'h264'|'hevc'|'av1'} [codec] 编码格式，缺省 h264（向后兼容既有调用）
 */
function nvencArgs(cq, codec) {
  const q = (cq == null || !isFinite(Number(cq))) ? '27' : String(Math.round(Number(cq)));
  const args = NVENC_CODECS[String(codec || 'h264')] || NVENC_CODECS.h264;
  return args.map((x) => (x === '27' ? q : x));
}

/**
 * @param {string[]} args
 * @param {{onProgress?:Function, signal?:any, cwd?:string, env?:object, binary?:string,
 *          captureStdout?:boolean}} opts
 *   captureStdout —— 是否需要收集 stdout。ffmpeg 的诊断类滤镜（如 metadata=print）
 *   默认把结果写到 **stdout**（`file=-`）而不是 stderr，需要这类输出的调用方要开启它。
 * @returns {Promise<{code:number, stderr:string, stdout:string, error:string|null}>}
 */
function runFfmpeg(args, { onProgress, signal, cwd, env, binary, captureStdout = false } = {}) {
  // FFmpeg 路径解析：backend 注入的 VL_FFMPEG_BIN（自愈下载后的数据目录）优先，回退 PATH
  binary = binary || process.env.VL_FFMPEG_BIN || 'ffmpeg';
  return new Promise((resolve) => {
    const child = spawn(binary, args, {
      windowsHide: true,
      signal,
      cwd,
      env: Object.assign({}, process.env, env),
    });
    let stderr = '';
    let stdout = '';
    // stderr 跨 chunk 缓冲：进程管道按缓冲区分块，stats 行可能被从中间切开
    let _errBuf = '';
    // `-stats` 的进度流是 `frame=...\rframe=...\r...`（**回车分隔、无换行**），
    // 普通日志行才是 \n 结尾 —— 所以 \r 与 \n 都要当作分隔符切段；
    // 只按 \n 切会把整个进度流扣在缓冲里不转发（任务进度条就不动了，实测踩到）
    const STATS_RE = /^\s*(frame|fps|q|size|time|bitrate|dup|drop|speed|elapsed)\s*=/;
    function pushErrSegs(flushLast) {
      const segs = _errBuf.split(/\r\n|\r|\n/);
      _errBuf = flushLast ? '' : (segs.pop() || '');   // 尾段不完整，留待下个 chunk；flush 时按完整段处理
      for (const seg of segs) {
        if (!seg) continue;
        // 行首锚定的 stats 段（与 backend 的折叠正则同一口径，残段不再外漏）
        if (STATS_RE.test(seg)) onProgress && onProgress(seg);
      }
    }
    child.stdout && child.stdout.on('data', (buf) => {
      if (!captureStdout) return;
      stdout += buf.toString('utf8');
    });
    child.stderr && child.stderr.on('data', (buf) => {
      const text = buf.toString('utf8');
      stderr += text;
      _errBuf += text;
      pushErrSegs(false);
    });
    child.on('error', (err) => { pushErrSegs(true); resolve({ code: -1, stderr, stdout, error: err.message }); });
    child.on('close', (code) => { pushErrSegs(true); resolve({ code: code == null ? -1 : code, stderr, stdout, error: null }); });
  });
}

module.exports = { runFfmpeg, NVENC_ARGS, nvencArgs };