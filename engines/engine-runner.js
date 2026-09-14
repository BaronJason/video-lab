// 引擎执行入口：env → 识别模块 → 运行 → 输出协议行。
// ctx 注入底座能力（V3 §6.7）：{ logger, ffmpeg, probe, lock, paths, retry, repair, dedupe, cacheStore }
// 业务模块实现后自动注册；未实现的模块退回占位骨架，保证空跑（--dry）始终可用。
// 用法：node engine-runner.js --module mask [--dry]
'use strict';

const Logger = require('./base/logger');
const { registerModule, getModule, listModules } = require('./registry');

// ── 底座能力（模块通过 ctx 使用，不直接 require，便于测试替换） ──
const base = {
  ffmpeg: require('./base/ffmpeg'),
  probe: require('./base/probe'),
  lock: require('./base/lock'),
  paths: require('./base/paths'),
  retry: require('./base/retry'),
  repair: require('./base/repair'),
  dedupe: require('./base/dedupe'),
  cacheStore: require('./base/cache-store'),
};

// ── 业务模块注册（P2 mask / P3 replica / P4 batch 逐个落地） ──
const MODULE_META = {
  batch: { title: '批量拼接', envs: ['BATCH_*', 'VL_CACHE_DIR'], legacy: 'video_batch.ps1' },
  mask: { title: '遮罩叠加', envs: ['MASK_*', 'VL_CACHE_DIR'], legacy: 'video_mask.ps1' },
  replica: { title: '复刻', envs: ['REPLICA_*', 'VL_CACHE_DIR'], legacy: 'video_replica.ps1' },
};

function loadModules(logger) {
  for (const id of Object.keys(MODULE_META)) {
    const meta = MODULE_META[id];
    let mod = null;
    try {
      mod = require(`./modules/${id}`);          // 已迁移：使用真实实现
      if (!mod || typeof mod.run !== 'function') mod = null;
    } catch (e) {
      mod = null;                                 // 模块文件缺失/语法错误 → 退回占位骨架
    }
    if (mod) { registerModule(Object.assign({ envVars: meta.envs, legacyScript: meta.legacy }, mod)); continue; }
    registerModule({
      id,
      title: meta.title,
      envVars: meta.envs,
      legacyScript: meta.legacy,
      skeleton: true,
      run: async (ctx) => {
        ctx.logger.info(`[${id}] 占位骨架：尚未迁移（P2/P3/P4）`);
        ctx.logger.raw('共 1 个');
        ctx.logger.progress('生成', 1, 1);
        return 0;
      },
    });
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) { args[argv[i].slice(2)] = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : true; }
  }
  const logger = new Logger();
  loadModules(logger);

  const id = typeof args.module === 'string' ? args.module.trim() : '';
  if (!id) { logger.error('engine-runner', '缺少 --module 参数（batch/mask/replica）'); process.exit(2); }
  let mod;
  try { mod = getModule(id); } catch (e) { logger.error('engine-runner', e.message); process.exit(2); }

  logger.info('================ Video Lab Engine ================');
  logger.info('模块：' + mod.title);

  const ctx = Object.assign({ logger, registry: listModules() }, base);
  if (args.dry || mod.skeleton) {
    // 空跑：只验证分发与协议行骨架
    logger.info('（空跑模式）');
    if (typeof mod.run === 'function' && mod.skeleton) { const code = await mod.run(ctx); logger.done(); process.exit(code === 0 ? 0 : 1); }
    logger.raw('共 1 个');
    logger.progress('生成', 1, 1);
    logger.done();
    process.exit(0);
  }

  let code = 1;
  try {
    code = await mod.run(ctx);
  } catch (e) {
    logger.error('引擎异常', (e && e.message) || String(e));
    code = 1;
  }
  process.exit(code === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('引擎异常：' + ((e && e.stack) || e));
  process.exit(1);
});
