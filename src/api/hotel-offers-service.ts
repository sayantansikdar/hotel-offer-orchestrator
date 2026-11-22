import { randomUUID } from 'node:crypto';
import { ApplicationFailure, Client, WorkflowFailedError } from '@temporalio/client';
import type { HotelCache, PriceRange } from '../lib/hotel-cache';
import { hotelOffersWorkflow } from '../temporal/workflows';
import type { HotelOffer, HotelOffersResult, SupplierOutcome } from '../types';

export class AllSuppliersUnavailableError extends Error {
  constructor(readonly suppliers: SupplierOutcome[]) {
    super('All suppliers are unavailable');
  }
}

export class CacheUnavailableError extends Error {
  constructor() {
    super('Price filtering needs the Redis cache, which is unavailable');
  }
}

export interface OffersResponse {
  offers: HotelOffer[];
  suppliers?: SupplierOutcome[];
  workflowId?: string;
  cache: 'HIT' | 'MISS' | 'BYPASS';
}

export class HotelOffersService {
  constructor(
    private readonly client: Client,
    private readonly cache: HotelCache,
    private readonly taskQueue: string,
  ) {}

  /** Runs the orchestration workflow and waits for its result. */
  async fetchLive(city: string): Promise<HotelOffersResult & { workflowId: string }> {
    const workflowId = `hotel-offers-${city}-${randomUUID()}`;
    try {
      const result = await this.client.workflow.execute(hotelOffersWorkflow, {
        taskQueue: this.taskQueue,
        workflowId,
        args: [{ city }],
        workflowExecutionTimeout: '30 seconds',
      });
      return { ...result, workflowId };
    } catch (err) {
      if (
        err instanceof WorkflowFailedError &&
        err.cause instanceof ApplicationFailure &&
        err.cause.type === 'AllSuppliersUnavailable'
      ) {
        throw new AllSuppliersUnavailableError((err.cause.details?.[0] as SupplierOutcome[]) ?? []);
      }
      throw err;
    }
  }

  /** GET /api/hotels?city=x — always orchestrates, which also refreshes the cache. */
  async getOffers(city: string): Promise<OffersResponse> {
    const { offers, suppliers, workflowId } = await this.fetchLive(city);
    return { offers, suppliers, workflowId, cache: 'BYPASS' };
  }

  /**
   * GET /api/hotels?city=x&minPrice=&maxPrice= — filters inside Redis. If the
   * city is not cached yet, the workflow runs first and populates it.
   */
  async getOffersInPriceRange(city: string, range: PriceRange): Promise<OffersResponse> {
    const meta = await this.cache.getMeta(city);
    if (meta) {
      const suppliers = meta.unavailable.map((supplier): SupplierOutcome => ({ supplier, status: 'failed', hotels: 0 }));
      return { offers: await this.cache.findByPrice(city, range), suppliers, cache: 'HIT' };
    }
    const { suppliers, workflowId, cached } = await this.fetchLive(city);
    if (!cached) throw new CacheUnavailableError();
    return { offers: await this.cache.findByPrice(city, range), suppliers, workflowId, cache: 'MISS' };
  }
}
