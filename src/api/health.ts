import type { Client } from '@temporalio/client';
import type { HotelCache } from '../lib/hotel-cache';
import { SUPPLIER_IDS, supplierName } from '../types';

export interface ComponentHealth {
  status: 'up' | 'down';
  latencyMs: number;
  error?: string;
}

export interface HealthReport {
  status: 'ok' | 'degraded' | 'down';
  timestamp: string;
  suppliers: Record<string, ComponentHealth>;
  dependencies: { redis: ComponentHealth; temporal: ComponentHealth };
}

async function probe(check: () => Promise<void>): Promise<ComponentHealth> {
  const started = Date.now();
  try {
    await check();
    return { status: 'up', latencyMs: Date.now() - started };
  } catch (err) {
    return { status: 'down', latencyMs: Date.now() - started, error: (err as Error).message };
  }
}

export interface HealthDeps {
  client: Client;
  cache: HotelCache;
  supplierBaseUrl: string;
  timeoutMs?: number;
}

/**
 * Probes both suppliers the same way the workflow reaches them, plus Redis and
 * Temporal. "degraded" means requests still succeed with partial data or
 * without price filtering; "down" means GET /api/hotels cannot succeed.
 */
export async function checkHealth({ client, cache, supplierBaseUrl, timeoutMs = 2000 }: HealthDeps): Promise<HealthReport> {
  const [supplierResults, redis, temporal] = await Promise.all([
    Promise.all(
      SUPPLIER_IDS.map((id) =>
        probe(async () => {
          const res = await fetch(`${supplierBaseUrl}/supplier${id}/hotels`, {
            signal: AbortSignal.timeout(timeoutMs),
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
        }),
      ),
    ),
    probe(() => cache.ping()),
    probe(async () => {
      await client.connection.withDeadline(Date.now() + timeoutMs, () =>
        client.workflowService.getSystemInfo({}),
      );
    }),
  ]);

  const suppliers = Object.fromEntries(SUPPLIER_IDS.map((id, i) => [supplierName(id), supplierResults[i]]));
  const suppliersUp = supplierResults.filter((s) => s.status === 'up').length;

  let status: HealthReport['status'] = 'ok';
  if (temporal.status === 'down' || suppliersUp === 0) status = 'down';
  else if (redis.status === 'down' || suppliersUp < SUPPLIER_IDS.length) status = 'degraded';

  return { status, timestamp: new Date().toISOString(), suppliers, dependencies: { redis, temporal } };
}
