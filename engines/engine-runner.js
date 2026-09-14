// 引擎执行入口：env → 识别模块 → 运行 → 输出协议行。
// P1 骨架版：只做「空 job 空跑」验证协议行与模块分发，不执行真实业务（业务迁移在 P2~P4）。
// 用法：node engine-runner.js --module mask --dry (空跑)
'use strict';

const Logger = require('./base/logger');

async function main() {
  const argv = process.argv.slice(2);
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) { args[argv[i].slice(2)] = argv[i + 1]; i++; }
  }
  const logger = new Logger();
  const { getModule, registry } = require('./registry');

  // 注册三个模块（P1：每个模块先注册，run 逻辑后续迁移）
  const { registerModule } = require('./registry');
  registerModule({
    id: 'batch', title: '批量拼接', envVars: ['BATCH_*', 'VL_CACHE_DIR'], legacyScript: 'video_batch.ps1',
    run: async (ctx) => { ctx.logger.raw('[batch] P1 骨架：空跑通过'); return 0; },
  });
  registerModule({
    id: 'mask', title: '遮罩叠加', envVars: ['MASK_*', 'VL_CACHE_DIR'], legacyScript: 'video_mask.ps1',
    run: async (ctx) => { ctx.logger.raw('[mask] P1 骨架：空跑通过'); return 0; },
  });
  registerModule({
    id: 'replica', title: '复刻', envVars: ['REPLICA_*', 'VL_CACHE_DIR'], legacyScript: 'video_replica.ps1',
    run: async (ctx) => { ctx.logger.raw('[replica] P1 骨架：空跑通过'); return 0; },
  });

  const id = args.module || (args['module'] && args['module'].trim());
  const dry = !!args.dry;
  if (!id) { logger.error('engine-runner', '缺少 --module 参数（batch/mask/replica）'); process.exit(2); }

  const mod = getModule(id);
  logger.info('================ Video Lab Engine ================');
  logger.info('模块：' + mod.title);
  logger.raw('共 1 个');
  logger.progress('生成', 1, 1);
  if (dry) logger.info('（P1 骨架空跑模式）');

  // ctx 提供底座能力，业务模块 run 内使用
  const ctx = { logger, registry: Array.from(registry.keys()) };
  const code = await mod.run(ctx);

  logger.raw('脚本完成');
  process.exit(code === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('引擎异常：' + (e && e.stack || e));
  process.exit(1);
});