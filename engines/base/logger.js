// 结构化日志 → 兼容行输出：字节级保持 backend.js 已解析的协议行。
// Node 引擎内部用结构化对象流转业务状态，stdout 仅作为展示与兼容层。
'use strict';

// 诊断通道前缀：后端据此把「过程信息」从用户视图里剥离出来（见 backend.js 的 pushLine）
const DIAG_PREFIX = '@@VLDIAG@@';

class Logger {
  constructor({ stream = process.stdout, diagLimit = 3000 } = {}) {
    this._out = stream;
    // 诊断环形缓冲：只驻内存，不进 stdout —— 任务窗口（用户视图）保持简洁；
    // 任务失败时由 dumpDiag() 一次性交给后端，落进运行日志（诊断视图，完整过程）。
    this._diag = [];
    this._diagLimit = diagLimit;
  }

  /** 记录一条「过程」事件（与面向用户的结论分开）。
   *  用于回答「怎么走到这个结论的」：每轮尝试、候选选取、被排除的原因、参数档位等。
   *  @param {string} ev   事件名，如 combo.round / pick / exclude / ladder.switch / fail
   *  @param {*} [data]    结构化数据（保持短小，避免缓冲膨胀） */
  diag(ev, data) {
    try {
      const rec = { t: Date.now(), ev: String(ev) };
      if (data !== undefined) rec.d = data;
      this._diag.push(rec);
      if (this._diag.length > this._diagLimit) this._diag.shift();
    } catch (e) { /* 诊断失败绝不影响主流程 */ }
  }

  /** 把「上次交出之后新增」的过程事件交给后端（取走即清空，避免重复；环形上限仍生效） */
  dumpDiag() {
    try {
      const slice = this._diag.splice(0, this._diag.length);
      if (!slice.length) return;
      const CHUNK = 200;   // 分批，避免单行过长
      for (let i = 0; i < slice.length; i += CHUNK) {
        this.raw(DIAG_PREFIX + JSON.stringify(slice.slice(i, i + CHUNK)));
      }
    } catch (e) { /* 静默 */ }
  }

  raw(line) { this._out.write(line + '\n'); }

  // 分割线（对齐 PS1 的 ================ 46 宽）
  section() { this.raw('='.repeat(46)); }

  info(text) { this.raw(text); }

  warn(text) { this.raw('⚠️  ' + text); }

  // 成片预计时长：驱动前端单成片进度分母 clipTarget
  // 格式对齐 PS 的 [math]::Round($v,2)：两位小数并去掉尾随零（164.8 而非 164.80）
  clipDuration(sec) {
    const v = Math.round(Number(sec) * 100) / 100;
    this.raw('成片预计时长: ' + String(v) + ' 秒');
  }

  // 任务总进度
  total(n) { this.raw('共 ' + n + ' 个'); }
  progress(kind, cur, total) { this.raw(`${kind}第 ${cur} / ${total} 个成片`); }

  // 视频处理工具：与成片任务共用同一套进度解析（backend 两种措辞都认），
  // 但措辞如实描述工具的场景 —— 工具处理的是"视频文件"，不是"成片"
  toolProgress(cur, total) { this.raw(`处理第 ${cur} / ${total} 个视频`); }

  // 单文件进度分母（字段语义与成片相同：驱动前端单条进度条）
  fileDuration(sec) {
    const v = Math.round(Number(sec) * 100) / 100;
    this.raw('当前文件时长: ' + String(v) + ' 秒');
  }

  // 创建输出目录：标记 batchOutDir（batch 专属，供 marker 记录）
  outDir(p) { this.raw('✅ 创建输出目录：' + p); }

  // 成片完成（带路径）：marker videos 记录依据（replica / mask 用）
  clipDone(p) { this.raw('✅ 成片完成：' + p); }

  // batch 的完成行是「逗号分隔、无路径」（差异表 #4：backend 用冒号行抓 videos，batch 靠创建输出目录记 batchOutDir）
  clipDoneBatch(sec, speedRatio) {
    const r = Number(speedRatio || 1);
    if (r > 1.0001) {
      this.raw('✅ 成片完成，时长：' + sec + ' 秒 (加速倍率 ' + r.toFixed(3) + 'x)');
    } else {
      this.raw('✅ 成片完成，时长：' + sec + ' 秒');
    }
  }

  // mask 的总数行（原文为「开始遮罩叠加，共 N 个成片」，backend 用 /共 (\d+) 个/ 抓取）
  maskTotal(n) { this.raw(''); this.raw('开始遮罩叠加，共 ' + n + ' 个成片'); }

  // 失败成片【序号】协议行：用于「失败发生在成片命名之前」的场景（如批量组合凑不出时长），
  // 那一刻还没有输出文件名可用，只能以序号标识 → 续跑据此按序号补做（BATCH_ONLY_INDEX）。
  failIndex(index, reason) {
    const clean = String(reason == null ? '' : reason).replace(/[|\r\n]+/g, ' ').trim();
    this.raw('❌ 失败成片序号：' + index + '|' + clean);
  }

  // 失败成片协议行：failedVideos + 续跑
  fail(name, reason) {
    const clean = String(reason == null ? '' : reason).replace(/[|\r\n]+/g, ' ').trim();
    this.raw('❌ 失败成片：' + name + '|' + clean);
  }

  // 锁状态
  // suffix 用于对齐各脚本原文（如 batch 的「等待获取互斥锁，准备拼接...」）；
  // backend 用 /等待获取互斥锁/ 匹配，故三模块统一走本方法、仅 suffix 不同
  lockWaiting(suffix) { this.raw('等待获取互斥锁' + (suffix ? '，' + suffix : '')); }
  lockAcquired(msg) { this.raw('🔒 已获取互斥锁' + (msg ? '，' + msg : '')); }
  lockReleased() { this.raw('🔓 互斥锁已释放'); }

  // 错误块（对齐 PS1 Invoke-ErrorAction 输出）
  // 出错误块时自动附带过程诊断：让后端拿到「怎么走到这个错误」而不只是结论
  error(step, msg) {
    this.dumpDiag();
    this.raw('');
    this.raw('================ 错误信息 ================');
    this.raw('出错步骤: ' + step);
    this.raw('错误详情: ' + msg);
    this.raw('==========================================');
  }

  done() { this.raw('任务完成'); }
}

module.exports = Logger;
module.exports.DIAG_PREFIX = DIAG_PREFIX;