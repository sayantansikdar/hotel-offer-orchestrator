function bool(value: string | undefined): boolean {
  return value === 'true' || value === '1';
}

function int(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export const config = {
  port: int(process.env.PORT, 3000),
  logLevel: process.env.LOG_LEVEL ?? 'info',
  supplierBaseUrl: process.env.SUPPLIER_BASE_URL ?? 'http://localhost:3000',
  supplierTimeoutMs: int(process.env.SUPPLIER_TIMEOUT_MS, 3000),
  temporal: {
    address: process.env.TEMPORAL_ADDRESS ?? 'localhost:7233',
    namespace: process.env.TEMPORAL_NAMESPACE ?? 'default',
    taskQueue: process.env.TEMPORAL_TASK_QUEUE ?? 'hotel-offers',
  },
  redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379',
  cacheTtlSeconds: int(process.env.CACHE_TTL_SECONDS, 300),
  // Results missing a supplier expire sooner, so the cache recovers with the supplier.
  partialCacheTtlSeconds: int(process.env.PARTIAL_CACHE_TTL_SECONDS, 30),
  supplierADown: bool(process.env.SUPPLIER_A_DOWN),
  supplierBDown: bool(process.env.SUPPLIER_B_DOWN),
};
