// 滤镜链构建助手（工具共用）
//
// 为什么需要它：多个步骤各自的滤镜片段要**合并成一条链**，而拼接环节最容易写歪
// ——逗号/分号混用、中间流标签重名、忘了送 NVENC 前的 format 兜底。
// 统一在本模块构造，各步骤只负责"产出自己的片段"。
//
// ★ 硬约束（§3.2）：**只允许 CPU 滤镜** —— 本模块不提供任何 *_cuda / hwupload 入口，
//   从设计上排除「全 GPU 管线」那条曾导致成片闪烁的路。
'use strict';

const FORCE_FORMAT = 'format=yuv420p';   // 送 NVENC 前的像素格式兜底（10bit 源等）

/**
 * @param {{hasAudio?:boolean}} opts
 */
function createChain(opts) {
  const hasAudio = !(opts && opts.hasAudio === false);
  const vParts = [];     // 视频侧的简单滤镜（逗号串联）
  const aParts = [];     // 音频侧的简单滤镜
  const rawParts = [];   // 需要自定义标签的复杂片段（overlay / concat 等）

  const api = {
    hasAudio,

    /** 追加视频滤镜片段，如 'scale=iw*0.74:ih*0.74' */
    vf(expr) { if (expr) vParts.push(String(expr)); return api; },

    /** 追加音频滤镜片段，如 'atempo=1.25' */
    af(expr) { if (expr) aParts.push(String(expr)); return api; },

    /** 追加原始 filter_complex 片段（多输入场景，标签由调用方自管） */
    raw(expr) { if (expr) rawParts.push(String(expr)); return api; },

    isEmpty() { return !vParts.length && !aParts.length && !rawParts.length; },

    /** 当前视频侧片段（只读，便于日志） */
    videoParts() { return vParts.slice(); },
    audioParts() { return aParts.slice(); },

    /**
     * 产出 filter_complex 与 map 参数。
     * 约定：视频末流 `[vout]`、音频末流 `[aout]`（无音频时不含音频链）。
     */
    build() {
      const segs = [];
      segs.push('[0:v]' + vParts.concat([FORCE_FORMAT]).join(',') + '[vout]');
      if (hasAudio) {
        segs.push('[0:a]' + (aParts.length ? aParts.concat(['asetpts=PTS-STARTPTS']).join(',') : 'anull') + '[aout]');
      }
      for (const r of rawParts) segs.push(r);

      const args = ['-filter_complex', segs.join(';'), '-map', '[vout]'];
      if (hasAudio) args.push('-map', '[aout]');
      return { fc: segs.join(';'), args };
    },
  };
  return api;
}

/** 拼一条「单输入顺序滤镜」的简单链（多数步骤用这个即可） */
function simpleChain(videoParts, audioParts, hasAudio) {
  const c = createChain({ hasAudio });
  (videoParts || []).forEach((x) => c.vf(x));
  (audioParts || []).forEach((x) => c.af(x));
  return c;
}

module.exports = { createChain, simpleChain, FORCE_FORMAT };
