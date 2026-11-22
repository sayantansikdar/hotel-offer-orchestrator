import type { HotelOffer } from '../types';

function hotelKey(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

function isBetter(candidate: HotelOffer, current: HotelOffer): boolean {
  if (candidate.price !== current.price) return candidate.price < current.price;
  // Same price: keep the offer that earns us more, then break ties by supplier
  // name so the result never depends on which supplier answered first.
  if (candidate.commissionPct !== current.commissionPct) {
    return candidate.commissionPct > current.commissionPct;
  }
  return candidate.supplier < current.supplier;
}

/**
 * Deduplicates offers by hotel name (case and whitespace insensitive) and keeps
 * the cheapest one per hotel. Result is sorted by price, then name.
 *
 * Pure and deterministic, so the workflow can call it directly.
 */
export function selectBestOffers(offers: HotelOffer[]): HotelOffer[] {
  const best = new Map<string, HotelOffer>();
  for (const offer of offers) {
    const key = hotelKey(offer.name);
    const current = best.get(key);
    if (!current || isBetter(offer, current)) best.set(key, offer);
  }
  return [...best.values()].sort((a, b) => a.price - b.price || a.name.localeCompare(b.name));
}
