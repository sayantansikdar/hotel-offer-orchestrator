import { existsSync } from 'node:fs';
import { NativeConnection, Worker } from '@temporalio/worker';
import { config } from '../config';
import { createRedis, HotelCache } from '../lib/hotel-cache';
import { logger } from '../lib/logger';
import { createActivities } from './activities';
import { workflowBundlePath } from './bundle';

async function main(): Promise<void> {
  const redis = createRedis(config.redisUrl);
  redis.on('error', (err) => logger.error({ err: err.message }, 'redis error'));

  const connection = await NativeConnection.connect({ address: config.temporal.address });
  const worker = await Worker.create({
    connection,
    namespace: config.temporal.namespace,
    taskQueue: config.temporal.taskQueue,
    // Use the bundle from `npm run build` when present; bundle on the fly in dev.
    ...(existsSync(workflowBundlePath)
      ? { workflowBundle: { codePath: workflowBundlePath } }
      : { workflowsPath: require.resolve('./workflows') }),
    activities: createActivities({
      cache: new HotelCache(redis, config.cacheTtlSeconds, config.partialCacheTtlSeconds),
      supplierBaseUrl: config.supplierBaseUrl,
      supplierTimeoutMs: config.supplierTimeoutMs,
    }),
  });

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      logger.info({ signal }, 'shutting down worker');
      worker.shutdown();
    });
  }

  logger.info({ taskQueue: config.temporal.taskQueue, temporal: config.temporal.address }, 'worker started');
  await worker.run();
  await connection.close();
  redis.disconnect();
}

main().catch((err) => {
  logger.fatal({ err }, 'worker crashed');
  process.exit(1);
});
