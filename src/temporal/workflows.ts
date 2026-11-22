import { ApplicationFailure, log, proxyActivities } from '@temporalio/workflow';
import { selectBestOffers } from '../lib/select-best-offers';
import {
  SUPPLIER_IDS,
  supplierName,
  type HotelOffersInput,
  type HotelOffersResult,
  type SupplierOutcome,
} from '../types';
import type { Activities } from './activities';

const { fetchSupplierHotels } = proxyActivities<Activities>({
  startToCloseTimeout: '5 seconds',
  retry: {
    initialInterval: '300 milliseconds',
    backoffCoefficient: 2,
    maximumAttempts: 3,
  },
});

const { cacheHotelOffers } = proxyActivities<Activities>({
  startToCloseTimeout: '5 seconds',
  retry: { initialInterval: '200 milliseconds', maximumAttempts: 3 },
});

function failureMessage(err: unknown): string {
  // Activity failures wrap the real error in `cause`.
  const cause = (err as { cause?: Error }).cause;
  return cause?.message ?? (err as Error).message ?? String(err);
}

/**
 * Calls every supplier in parallel, keeps the cheapest offer per hotel name and
 * caches the result in Redis. One supplier failing still returns the other's
 * hotels; only when every supplier fails does the workflow fail.
 */
export async function hotelOffersWorkflow({ city }: HotelOffersInput): Promise<HotelOffersResult> {
  const settled = await Promise.allSettled(SUPPLIER_IDS.map((id) => fetchSupplierHotels(id, city)));

  const suppliers: SupplierOutcome[] = settled.map((result, i) => {
    const supplier = supplierName(SUPPLIER_IDS[i]);
    if (result.status === 'fulfilled') {
      return { supplier, status: 'ok', hotels: result.value.length };
    }
    const error = failureMessage(result.reason);
    log.warn('supplier failed after retries', { supplier, city, error });
    return { supplier, status: 'failed', hotels: 0, error };
  });

  if (suppliers.every((s) => s.status === 'failed')) {
    throw ApplicationFailure.nonRetryable('All suppliers are unavailable', 'AllSuppliersUnavailable', suppliers);
  }

  const offers = selectBestOffers(settled.flatMap((r) => (r.status === 'fulfilled' ? r.value : [])));

  // A cache outage should not cost the caller their answer; the price-filter
  // endpoint notices the missing cache entry and reports it instead.
  const unavailable = suppliers.filter((s) => s.status === 'failed').map((s) => s.supplier);
  let cached = true;
  try {
    await cacheHotelOffers(city, offers, unavailable);
  } catch (err) {
    cached = false;
    log.error('caching offers failed', { city, error: failureMessage(err) });
  }

  log.info('hotel offers selected', { city, hotels: offers.length, cached });
  return { city, offers, suppliers, cached };
}
