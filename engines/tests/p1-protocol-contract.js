// P1 验收（协议行契约）：用 backend.js 的真实解析正则 + PS1 基线样本，
// 断言引擎 logger 产出的每一类协议行都能被主进程正确解析（V3 附录 A 的可执行版本）。
// 运行：node engines/tests/p1-protocol-contract.js
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { Writable } = require('node:stream');
const Logger = require('../base/logger');

// ── 与 backend.js pushLine 段一致的正则（契约副本；改动 backend 时此处需同步） ──
const RE = {
  clipDuration: /成片预计时长:\s*([\d.]+)\s*秒/,
  total: /共 (\d+) 个/,
  progress: /(?:生成|复刻)第 (\d+) \/ (\d+) 个成片/,
  clipDone: /✅ 成片完成：(.+)$/,
  // batch 完成行（逗号、无路径）：backend 用通用 /成片完成/ 匹配它来固化单片进度，不用于抓路径
  batchDone: /✅ 成片完成，时长：([\d.]+) 秒/,
  outDir: /✅ 创建输出目录：(.+)$/,
  fail: /❌ 失败成片：(.+?)\|(.+)$/,
  lockWaiting: /等待获取互斥锁/,
  lockAcquired: /已获取互斥锁/,
  lockReleased: /互斥锁已释放|任务全部完成|脚本完成/,
};

const lines = [];
const sink = new Writable({ write(chunk, enc, cb) { lines.push(chunk.toString().replace(/\r?\n$/, '')); cb(); } });
const log = new Logger({ stream: sink });

// ── 1) 引擎产出全量协议行 ──
log.lockWaiting();
log.lockAcquired('开始执行拼接任务');
log.outDir('E:\\out\\0914-19时00分-配置-成片');
log.total(3);
log.progress('生成', 1, 3);
log.clipDuration(164.8);
log.clipDoneBatch('170.093537', 1.228);      // batch 完成行（逗号、无路径）
log.clipDone('E:\\out\\x\\260914-改-成片.mp4'); // replica / mask 完成行（冒号、带路径）
log.fail('260914-测试.mp4', '时长超阈值：181.2 秒');
log.maskTotal(2);
log.error('第 1 个成片', '连续 3 轮仍无法找到满足时长的组合');
log.lockReleased();
log.done();

// ── 2) 契约断言 ──
const results = [];
function check(name, ok, detail) { results.push({ name, ok, detail: detail || '' }); }

const find = (re) => lines.find((l) => re.test(l));

const lDur = find(RE.clipDuration);
check('成片预计时长行可解析', !!lDur && RE.clipDuration.exec(lDur)[1] === '164.8', lDur || '缺失');

const lTotal = find(RE.total);
check('总数行可解析（共 N 个）', !!lTotal && RE.total.exec(lTotal)[1] === '3', lTotal || '缺失');

const lProg = find(RE.progress);
check('进度行可解析（生成第 X / Y 个成片）', !!lProg && RE.progress.exec(lProg)[1] === '1', lProg || '缺失');

const lDonePath = lines.find((l) => RE.clipDone.test(l) && /\.mp4$/.test(RE.clipDone.exec(l)[1]));
check('完成行可抓路径（replica/mask）', !!lDonePath, lDonePath || '缺失');

const lDoneBatch = find(/✅ 成片完成，时长：/);
check('batch 完成行存在（逗号、无路径）', !!lDoneBatch && !RE.clipDone.test(lDoneBatch), lDoneBatch || '缺失');

const lOut = find(RE.outDir);
check('创建输出目录行可抓路径', !!lOut && /成片$/.test(RE.outDir.exec(lOut)[1]), lOut || '缺失');

const lFail = find(RE.fail);
check('失败行可解析（名|原因）', !!lFail && RE.fail.exec(lFail)[1] === '260914-测试.mp4', lFail || '缺失');

check('锁等待行存在', !!find(RE.lockWaiting), '');
check('锁获取行存在', !!find(RE.lockAcquired), '');
check('锁释放行存在', !!find(RE.lockReleased), '');
check('错误块标题存在', lines.some((l) => l === '================ 错误信息 ================'), '');

// ── 3) 与 PS1 真实基线样本比对（只统计 backend 真正解析的行） ──
// 说明：预处理/跳过/分隔线等属于"展示行"，不参与主进程解析，不计入覆盖率。
const PARSEABLE = [
  /成片预计时长/, /共 \d+ 个/, /(?:生成|复刻)第 \d+ \/ \d+ 个成片/,
  /✅ 成片完成/, /✅ 创建输出目录：/, /❌ 失败成片：/, /互斥锁/, /错误信息/,
];
// 基线来源：tests/fixtures 下随仓库固定存放的协议行夹具（PS1 真实输出、路径已归一化）；
// 兼容旧 P0 捕获目录（体积大、可能被清理，仅作补充）。两者都没有才是真异常。
const fixDir = path.join(__dirname, 'fixtures');
const baseFiles = [];
if (fs.existsSync(fixDir)) {
  for (const n of fs.readdirSync(fixDir)) if (n.endsWith('.txt')) baseFiles.push(path.join(fixDir, n));
}
const legacyBase = 'E:\\3-批量成片\\P0-基线\\baseline\\v1';
if (fs.existsSync(legacyBase)) {
  for (const sub of fs.readdirSync(legacyBase)) {
    const f = path.join(legacyBase, sub, 'stdout.txt');
    if (fs.existsSync(f)) baseFiles.push(f);
  }
}
let baseLines = 0, baseMatched = 0;
const uncovered = [];
for (const f of baseFiles) {
  for (const raw of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
    const l = raw.replace(/\r$/, '').trim();
    if (!l || l.startsWith('#') || /^frame=/.test(l)) continue;
    if (!PARSEABLE.some((re) => re.test(l))) continue;
    baseLines++;
    const hit = Object.values(RE).some((re) => { re.lastIndex = 0; return re.test(l); });
    if (hit) baseMatched++; else uncovered.push(`[${path.basename(f)}] ${l}`);
  }
}
check(`PS1 基线「可解析协议行」被契约正则完整覆盖（${baseMatched}/${baseLines}）`,
  baseLines > 0 && baseMatched === baseLines,
  baseLines ? `覆盖 ${(baseMatched / baseLines * 100).toFixed(0)}%` : '未找到基线样本');
if (uncovered.length) {
  console.log('  未覆盖的基线行：');
  for (const u of uncovered.slice(0, 10)) console.log('    ' + u);
}

// ── 4) 报告 ──
console.log('=== P1 协议行契约验收 ===');
for (const r of results) {
  console.log(`${r.ok ? '  PASS' : '  FAIL'}  ${r.name}${r.detail ? '   [' + r.detail + ']' : ''}`);
}
const failed = results.filter((r) => !r.ok);
console.log('');
console.log(failed.length === 0
  ? `P1 协议行契约验收通过（${results.length}/${results.length}）`
  : `P1 协议行契约验收未通过：${failed.length} 项失败`);
process.exit(failed.length === 0 ? 0 : 1);
