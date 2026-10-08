// engines/base/ladder.js —— 「加速换档重试」策略（底座共享，唯一实现）
//
// 适用：批量拼接、日志复刻（以及将来任何需要"把成片压进时长上限"的模块）。
//
// ⚠ 本文件是档位语义的**唯一来源** —— 调用方一律用 createRunner()，不得再各自内联
//   THR_STEPS / 档位换算 / 允许时长。历史上批量与复刻各写一份，一侧补了「本档耗尽即提前进档」、
//   另一侧没补，两侧达标率就此分叉且不互通；任何策略改动改这里即可。
//
// 策略：
//   先在当前档跑满「每档轮数」；凑不出/压不下来，就逐级加大加速倍率（换档）继续；
//   换档时清空失败记忆，否则候选一直被挡、换档等于没换。
//   某档内可替换位已耗尽时，不再空转剩余轮数，直接进下一档（否则设定的每档轮数白跑）。
//
// 参数语义：本底座**只管策略**，不绑定任何配置键 —— maxDuration / speedThreshold / maxRetry
//   （后者在两个调用方里对应设置页的「重试次数」= 每档轮数）全部由调用方传入。
//   现阶段批量与复刻因业务强关联而共用批量那套设置（复刻读 BATCH_*），这是**调用方的当前决定**，
//   不是底座的约束；将来新模块接入时传自己的值即可（比如想要不同的档位节奏，改这里或传入派生参数）。
//
// 红线（务必理解，别用反）：
//   · 输出时长**恒以 maxDuration 封顶**（平台规则，超出无法过审）；
//   · 换档只放宽「允许的组合时长」，**不是**用加速去放宽替换/选片预算；
//   · 加速的定位是**拼接完成后**的兜底：总时长超过设定值时，把成片整体加速压回设定值。
//   · ★ 因此「成片最终验收」的上限必须是**达标那一档的 speedOf()**，
//     不能写死 maxDuration × speedThreshold —— 那样会把换到第 2 档及以后才达标的成片
//     （这是换档机制的正常产物）误判为「超阈值」而丢弃。
'use strict';

const THR_STEPS = [1, 1.25, 1.5, 1.75, 2];   // 加速倍率梯度（相对用户设置的 speedLimit）
const MAX_SPEED_RATIO = 2.0;                 // 加速倍率硬顶（画面可接受范围）

/** 每档重试轮数：直接取用户设置的「重试次数」，设定值即实际轮数（不再用 Math.max(100,...) 抬高） */
function retryPerStep(maxRetry) {
  return Math.max(1, Math.round(Number(maxRetry) || 1));
}

/** 第 round 轮属于哪个加速档位（0 基，封顶到最后一档） */
function stepOfRound(round, retryPerStepVal) {
  return Math.min(Math.floor(round / retryPerStepVal), THR_STEPS.length - 1);
}

/** 该档位下「允许的组合时长」（输出上限仍为 maxDuration，超出部分靠加速压回） */
function allowedDuration(maxDuration, speedThreshold, thrStep) {
  return Math.min(
    maxDuration * speedThreshold * THR_STEPS[thrStep],
    maxDuration * MAX_SPEED_RATIO
  );
}

/** 该档位生效的加速倍率上限（= 用户设置 × 档位系数，硬顶 MAX_SPEED_RATIO） */
function speedOfStep(speedThreshold, thrStep) {
  return Math.min(speedThreshold * THR_STEPS[thrStep], MAX_SPEED_RATIO);
}

/** 是否处在「换档点」（需要清掉上一档的失败记忆） */
function isShiftRound(round, retryPerStepVal) {
  return round > 0 && round % retryPerStepVal === 0;
}

/** 总轮数 = 每档轮数 × 档位数 */
function totalRounds(maxRetry) {
  return retryPerStep(maxRetry) * THR_STEPS.length;
}

/**
 * 档位驱动器 —— 批量拼接与日志复刻共用，两侧只消费它暴露的结果，不各写一份。
 * @param {object}  o
 * @param {number}  o.maxDuration     成片时长上限（输出硬顶）
 * @param {number}  o.speedThreshold  用户设置的允许超出比例（1.2 = 允许超 20%）
 * @param {number}  o.maxRetry        设置页「重试次数」= 每档轮数
 * @param {object} [o.logger]         有则统一输出换档话术（两侧文案一致）
 */
function createRunner({ maxDuration, speedThreshold, maxRetry, logger } = {}) {
  const per = retryPerStep(maxRetry);
  const rounds = per * THR_STEPS.length;

  return {
    perStep: per,
    rounds,

    /** 该轮所处档位（0 基） */
    stepOf(round) { return stepOfRound(round, per); },

    /** 该轮「允许的组合时长」—— 循环内用它判断是否达标 */
    allowedOf(round) { return allowedDuration(maxDuration, speedThreshold, stepOfRound(round, per)); },

    /** 该轮达标后可用的最大加速倍率 —— 成片最终验收用它，不要用固定 speedThreshold */
    speedOf(round) { return speedOfStep(speedThreshold, stepOfRound(round, per)); },

    /** 该档是否已到最后一档 */
    isLastStep(round) { return stepOfRound(round, per) >= THR_STEPS.length - 1; },

    /** 是否处在换档点 */
    isShift(round) { return isShiftRound(round, per); },

    /** 换档点统一话术（口径以批量模块原始实现为准：显示该档标称倍率；
     *  实际「允许组合时长」另有 MAX_SPEED_RATIO 硬顶，见 allowedOf） */
    announceShift(round) {
      if (!logger) return;
      const s = speedThreshold * THR_STEPS[stepOfRound(round, per)];
      logger.info(`⤴️  加大加速倍率至 ${s.toFixed(2)} 倍，继续尝试`
        + `（输出时长仍以上限 ${maxDuration}s 封顶）`);
    },

    /** 本档已无候选时的「提前进档」：返回下一档起始轮次；已在末档或无下一档返回 -1。
     *  调用写法：`const nx = L.nextStepStart(round); if (nx >= 0) { round = nx - 1; continue; }`（round 会被 ++ 补回） */
    nextStepStart(round) {
      const step = stepOfRound(round, per);
      if (step >= THR_STEPS.length - 1) return -1;
      const next = (step + 1) * per;
      return next < rounds ? next : -1;
    },

    /** 提前进档的统一话术 */
    announceStepSkip() {
      if (logger) logger.info('⏭️  本档可替换位置已用尽 → 提前进入下一档（放宽允许时长）继续尝试');
    },

    /**
     * 成片最终验收（唯一实现）：按达标档位判定「是否需要加速 / 倍率多少 / 是否超限」。
     * ⚠ 调用方不得再自己算 needSpeed / speedRatio：两侧各写一份（一边写死 speedThreshold、
     * 一边 clamp 写死 2.0）会让口径分叉，达标率与理论值对不上。
     * @param {number} totalDuration 组合总时长（重复消除等后续改动后须以最终值重新调用）
     * @param {number} okRound       达标时所处的轮次（0 = 未换档）
     * @returns {{needSpeed:boolean, speedRatio:number, exceeded:boolean}}
     *   needSpeed=true 时 speedRatio ∈ (1, MAX_SPEED_RATIO]；exceeded=true 表示超出达标档位允许上限
     */
    finalize(totalDuration, okRound = 0) {
      const cap = maxDuration * speedOfStep(speedThreshold, stepOfRound(okRound, per));
      if (totalDuration > maxDuration && totalDuration <= cap) {
        return { needSpeed: true, speedRatio: Math.min(totalDuration / maxDuration, MAX_SPEED_RATIO), exceeded: false };
      }
      if (totalDuration > cap) return { needSpeed: false, speedRatio: 1, exceeded: true };
      return { needSpeed: false, speedRatio: 1, exceeded: false };
    },
  };
}

module.exports = {
  THR_STEPS,
  MAX_SPEED_RATIO,
  createRunner,
  retryPerStep,
  stepOfRound,
  allowedDuration,
  speedOfStep,
  isShiftRound,
  totalRounds,
};
