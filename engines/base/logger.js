// 结构化日志 → 兼容行输出：字节级保持 backend.js 已解析的协议行。
// Node 引擎内部用结构化对象流转业务状态，stdout 仅作为展示与兼容层。
'use strict';

class Logger {
  constructor({ stream = process.stdout } = {}) {
    this._out = stream;
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

  // 失败成片协议行：failedVideos + 续跑
  fail(name, reason) {
    const clean = String(reason == null ? '' : reason).replace(/[|\r\n]+/g, ' ').trim();
    this.raw('❌ 失败成片：' + name + '|' + clean);
  }

  // 锁状态
  lockWaiting() { this.raw('等待获取互斥锁'); }
  lockAcquired(msg) { this.raw('🔒 已获取互斥锁' + (msg ? '，' + msg : '')); }
  lockReleased() { this.raw('🔓 互斥锁已释放'); }

  // 错误块（对齐 PS1 Invoke-ErrorAction 输出）
  error(step, msg) {
    this.raw('');
    this.raw('================ 错误信息 ================');
    this.raw('出错步骤: ' + step);
    this.raw('错误详情: ' + msg);
    this.raw('==========================================');
  }

  done() { this.raw('脚本完成'); }
}

module.exports = Logger;