import { ApplicationFailure, log } from '@temporalio/activity';
import { z } from 'zod';
import type { HotelCache } from '../lib/hotel-cache';
import { supplierName, type HotelOffer, type SupplierId } from '../types';

const supplierResponse = z.array(
  z.object({
    hotelId: z.string(),
    name: z.string().min(1),
    price: z.number().nonnegative(),
    city: z.string(),
    commissionPct: z.number().min(0).max(100),
  }),
);

export interface ActivityDeps {
  cache: HotelCache;
  supplierBaseUrl: string;
  supplierTimeoutMs: number;
}

export function createActivities({ cache, supplierBaseUrl, supplierTimeoutMs }: ActivityDeps) {
  return {
    /**
     * Fetches one supplier's hotels for a city and normalises them to offers.
     * Network errors and 5xx are thrown as plain errors so Temporal retries them;
     * a malformed payload will not fix itself, so that one is non-retryable.
     */
    async fetchSupplierHotels(supplier: SupplierId, city: string): Promise<HotelOffer[]> {
      const name = supplierName(supplier);
      const url = `${supplierBaseUrl}/supplier${supplier}/hotels?city=${encodeURIComponent(city)}`;
      const started = Date.now();

      let response: Response;
      try {
        response = await fetch(url, { signal: AbortSignal.timeout(supplierTimeoutMs) });
      } catch (err) {
        log.warn('supplier request failed', { supplier: name, city, error: String(err) });
        throw new Error(`${name} unreachable: ${(err as Error).message}`);
      }

      if (!response.ok) {
        log.warn('supplier returned an error', { supplier: name, city, status: response.status });
        const message = `${name} responded with HTTP ${response.status}`;
        if (response.status >= 400 && response.status < 500) {
          throw ApplicationFailure.nonRetryable(message, 'SupplierClientError');
        }
        throw new Error(message);
      }

      const parsed = supplierResponse.safeParse(await response.json().catch(() => null));
      if (!parsed.success) {
        throw ApplicationFailure.nonRetryable(`${name} returned an invalid payload`, 'InvalidSupplierResponse');
      }

      const offers = parsed.data
        .filter((hotel) => hotel.city.toLowerCase() === city)
        .map((hotel) => ({
          name: hotel.name,
          price: hotel.price,
          supplier: name,
          commissionPct: hotel.commissionPct,
        }));
      log.info('supplier responded', { supplier: name, city, hotels: offers.length, ms: Date.now() - started });
      return offers;
    },

    async cacheHotelOffers(city: string, offers: HotelOffer[], unavailable: string[]): Promise<void> {
      await cache.save(city, offers, unavailable);
      log.info('offers cached', { city, hotels: offers.length, partial: unavailable.length > 0 });
    },
  };
}

export type Activities = ReturnType<typeof createActivities>;
