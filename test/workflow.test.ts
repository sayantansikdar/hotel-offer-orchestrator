import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ApplicationFailure, WorkflowFailedError } from '@temporalio/client';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Runtime, DefaultLogger, Worker } from '@temporalio/worker';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Activities } from '../src/temporal/activities';
import { hotelOffersWorkflow } from '../src/temporal/workflows';
import type { HotelOffer, SupplierId } from '../src/types';

const inventory: Record<SupplierId, HotelOffer[]> = {
  A: [
    { name: 'Holtin', price: 6000, supplier: 'Supplier A', commissionPct: 10 },
    { name: 'Radison', price: 5900, supplier: 'Supplier A', commissionPct: 13 },
  ],
  B: [
    { name: 'Holtin', price: 5340, supplier: 'Supplier B', commissionPct: 20 },
    { name: 'Orchid Suites', price: 4500, supplier: 'Supplier B', commissionPct: 16 },
  ],
};

let env: TestWorkflowEnvironment;

beforeAll(async () => {
  Runtime.install({ logger: new DefaultLogger('WARN') });
  env = await TestWorkflowEnvironment.createLocal();
});

afterAll(async () => {
  await env?.teardown();
});

interface Scenario {
  down?: SupplierId[];
  cacheDown?: boolean;
}

async function run({ down = [], cacheDown = false }: Scenario) {
  const calls: Record<string, number> = {};
  const cached: { offers: HotelOffer[]; unavailable: string[] }[] = [];
  const activities: Activities = {
    async fetchSupplierHotels(supplier, _city) {
      calls[supplier] = (calls[supplier] ?? 0) + 1;
      if (down.includes(supplier)) throw new Error(`Supplier ${supplier} responded with HTTP 503`);
      return inventory[supplier];
    },
    async cacheHotelOffers(_city, offers, unavailable) {
      if (cacheDown) throw new Error('Connection is closed.');
      cached.push({ offers, unavailable });
    },
  };

  const taskQueue = `test-${randomUUID()}`;
  const worker = await Worker.create({
    connection: env.nativeConnection,
    taskQueue,
    workflowsPath: path.resolve(__dirname, '../src/temporal/workflows.ts'),
    activities,
  });

  const result = worker.runUntil(
    env.client.workflow.execute(hotelOffersWorkflow, {
      taskQueue,
      workflowId: `wf-${randomUUID()}`,
      args: [{ city: 'delhi' }],
    }),
  );
  return { result, calls, cached };
}

describe('hotelOffersWorkflow', () => {
  it('merges both suppliers, keeps the cheapest offer per hotel and caches it', async () => {
    const { result, cached } = await run({});
    const { offers, suppliers, cached: wasCached } = await result;

    expect(offers).toEqual([
      { name: 'Orchid Suites', price: 4500, supplier: 'Supplier B', commissionPct: 16 },
      { name: 'Holtin', price: 5340, supplier: 'Supplier B', commissionPct: 20 },
      { name: 'Radison', price: 5900, supplier: 'Supplier A', commissionPct: 13 },
    ]);
    expect(suppliers.map((s) => s.status)).toEqual(['ok', 'ok']);
    expect(wasCached).toBe(true);
    expect(cached).toEqual([{ offers, unavailable: [] }]);
  });

  it('retries a failing supplier, then returns the other supplier’s hotels', async () => {
    const { result, calls, cached } = await run({ down: ['B'] });
    const { offers, suppliers } = await result;

    expect(offers.map((o) => o.supplier)).toEqual(['Supplier A', 'Supplier A']);
    expect(suppliers[1]).toMatchObject({ supplier: 'Supplier B', status: 'failed' });
    expect(calls.B).toBe(3);
    expect(cached[0].unavailable).toEqual(['Supplier B']);
  });

  it('fails with AllSuppliersUnavailable when every supplier is down', async () => {
    const { result } = await run({ down: ['A', 'B'] });
    const err = await result.catch((e) => e);

    expect(err).toBeInstanceOf(WorkflowFailedError);
    expect(err.cause).toBeInstanceOf(ApplicationFailure);
    expect(err.cause.type).toBe('AllSuppliersUnavailable');
  });

  it('still returns offers when caching fails', async () => {
    const { result } = await run({ cacheDown: true });
    const { offers, cached } = await result;

    expect(offers).toHaveLength(3);
    expect(cached).toBe(false);
  });
});
