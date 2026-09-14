// 重试基座：统一 batch/replica 的渐进替换重试（首段固定 / 只接受更短 / 并列随机 / 失败记忆 / 耗尽源沿用）
'use strict';

// 与 P0 基线对齐的关键行为（5bd92c5 / ddfe436 / fa825c0 / c7df93c）：
// 1. 首段固定：首个位置选定后重试轮不变
// 2. 替换只接受严格更短候选（ShorterThan），等长不做无效替换
// 3. PreferShort 并列时长随机（不许 Sort 确定性锁定单文件）
// 4. 失败记忆：batch 按「位置索引|路径」、replica 按「原路径|替换路径」
// 5. 耗尽源沿用上轮；无沿用基础 → 快速失败
class RetryLoop {
  constructor({ maxAttempts = 45, firstFixed = true } = {}) {
    this.maxAttempts = maxAttempts;
    this.firstFixed = firstFixed;
    this._attempt = 0;
    this._failureMemory = new Set(); // 键由调用方构造（位置索引|路径 or 原路径|替换路径）
    this._exhausted = new Set();     // 已无可替换候选的源标识
  }

  get attempt() { return this._attempt; }
  get exhausted() { return this._exhausted; }

  markFailed(key) { this._failureMemory.add(key); }
  isTried(key) { return this._failureMemory.has(key); }
  markExhausted(key) { this._exhausted.add(key); }

  next() { return this._attempt++ < this.maxAttempts; }

  // 选择第 idx 个位置的候选：首个位置锁定（firstFixed），后续位置按规则过滤
  pick(select, { idx, isFirstPlace, previous = null, candidates, shorterThan = null, randomizeTie = true } = {}) {
    if (isFirstPlace && this.firstFixed && previous) return previous;
    return select({ candidates, shorterThan, randomizeTie, tried: this._failureMemory, exhausted: this._exhausted });
  }
}

module.exports = { RetryLoop };