import { Redis } from 'ioredis';
import type { HotelOffer } from '../types';

// Each city is a sorted set scored by price, so price filtering is a single
// ZRANGE ... BYSCORE inside Redis. A separate meta key records that the city was
// fetched, which lets us tell "cached, zero hotels" apart from "not cached".
const offersKey = (city: string) => `hotels:${city}:offers`;
const metaKey = (city: string) => `hotels:${city}:meta`;

export interface CacheMeta {
  hotels: number;
  cachedAt: string;
  /** Suppliers that failed when this entry was written; non-empty means partial data. */
  unavailable: string[];
}

export interface PriceRange {
  minPrice?: number;
  maxPrice?: number;
}

export class HotelCache {
  constructor(
    private readonly redis: Redis,
    private readonly ttlSeconds: number,
    private readonly partialTtlSeconds: number,
  ) {}

  /** Atomically replaces the cached offers for a city. */
  async save(city: string, offers: HotelOffer[], unavailable: string[] = []): Promise<void> {
    const ttl = unavailable.length > 0 ? this.partialTtlSeconds : this.ttlSeconds;
    const meta: CacheMeta = { hotels: offers.length, cachedAt: new Date().toISOString(), unavailable };
    const tx = this.redis.multi().del(offersKey(city));
    if (offers.length > 0) {
      // The member is the whole offer, so the filter query needs no second lookup.
      const args = offers.flatMap((offer) => [offer.price, JSON.stringify(offer)]);
      tx.zadd(offersKey(city), ...args).expire(offersKey(city), ttl);
    }
    tx.set(metaKey(city), JSON.stringify(meta), 'EX', ttl);
    const results = await tx.exec();
    const failed = results?.find(([err]) => err);
    if (failed) throw failed[0];
  }

  /** Null when the city is not cached. */
  async getMeta(city: string): Promise<CacheMeta | null> {
    const raw = await this.redis.get(metaKey(city));
    return raw ? (JSON.parse(raw) as CacheMeta) : null;
  }

  /** Offers for a city within [minPrice, maxPrice], cheapest first. */
  async findByPrice(city: string, { minPrice, maxPrice }: PriceRange): Promise<HotelOffer[]> {
    const members = await this.redis.zrange(
      offersKey(city),
      minPrice === undefined ? '-inf' : String(minPrice),
      maxPrice === undefined ? '+inf' : String(maxPrice),
      'BYSCORE',
    );
    return members.map((member) => JSON.parse(member) as HotelOffer);
  }

  async ping(): Promise<void> {
    await this.redis.ping();
  }
}

export function createRedis(url: string): Redis {
  return new Redis(url, {
    maxRetriesPerRequest: 2,
    enableOfflineQueue: false,
    lazyConnect: false,
  });
}
