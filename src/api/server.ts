import { Client, Connection } from '@temporalio/client';
import { config } from '../config';
import { createRedis, HotelCache } from '../lib/hotel-cache';
import { logger } from '../lib/logger';
import { createApp } from './app';
import { HotelOffersService } from './hotel-offers-service';

const redis = createRedis(config.redisUrl);
redis.on('error', (err) => logger.error({ err: err.message }, 'redis error'));

// Lazy, so the API starts (and /health can report) even while Temporal is still booting.
const connection = Connection.lazy({ address: config.temporal.address });
const client = new Client({ connection, namespace: config.temporal.namespace });
const cache = new HotelCache(redis, config.cacheTtlSeconds, config.partialCacheTtlSeconds);

const app = createApp({
  client,
  cache,
  supplierBaseUrl: config.supplierBaseUrl,
  hotelOffers: new HotelOffersService(client, cache, config.temporal.taskQueue),
  corsOrigins: config.corsOrigins,
});

const server = app.listen(config.port, () => {
  logger.info({ port: config.port }, 'api listening');
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    logger.info({ signal }, 'shutting down api');
    server.close(async () => {
      await connection.close().catch(() => undefined);
      redis.disconnect();
      process.exit(0);
    });
  });
}
