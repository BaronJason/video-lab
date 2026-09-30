// engines/base/ladder.js —— 「加速换档重试」策略（底座共享）
//
// 适用：批量拼接、日志复刻（以及将来任何需要"把成片压进时长上限"的模块）。
// 策略（与批量模块 2026-09-29 定案一致）：
//   先在当前档跑满「每档轮数」；仍凑不出/压不下来，就逐级加大加速倍率（换档）继续尝试；
//   换档时清空失败记忆，否则候选一直被挡、换档等于没换。
//
// 参数语义：`BATCH_MAX_RETRY`（设置页的「重试次数」，全局参数）在本策略里用作**每档轮数** ——
//   换档重试时每个档位各跑多少轮；总轮数 = 每档轮数 × 档位数。批量与复刻共用同一套。
//
// 红线（务必理解，别用反）：
//   · 输出时长**恒以 maxDuration 封顶**（平台规则，超出无法过审）；
//   · 换档只放宽「允许的组合时长」，**不是**用加速去放宽替换/选片预算；
//   · 加速的定位是**拼接完成后**的兜底：总时长超过设定值时，把成片整体加速压回设定值。
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

module.exports = {
  THR_STEPS,
  MAX_SPEED_RATIO,
  retryPerStep,
  stepOfRound,
  allowedDuration,
  speedOfStep,
  isShiftRound,
  totalRounds,
};
