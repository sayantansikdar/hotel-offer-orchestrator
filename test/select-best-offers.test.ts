import { describe, expect, it } from 'vitest';
import { selectBestOffers } from '../src/lib/select-best-offers';
import type { HotelOffer } from '../src/types';

const offer = (name: string, price: number, supplier: string, commissionPct = 10): HotelOffer => ({
  name,
  price,
  supplier,
  commissionPct,
});

describe('selectBestOffers', () => {
  it('keeps the cheaper offer when both suppliers list a hotel', () => {
    const result = selectBestOffers([
      offer('Holtin', 6000, 'Supplier A', 10),
      offer('Holtin', 5340, 'Supplier B', 20),
      offer('Radison', 5900, 'Supplier A', 13),
      offer('Radison', 6150, 'Supplier B', 18),
    ]);
    expect(result).toEqual([offer('Holtin', 5340, 'Supplier B', 20), offer('Radison', 5900, 'Supplier A', 13)]);
  });

  it('keeps hotels that only one supplier returns', () => {
    const result = selectBestOffers([offer('Lemon Leaf', 3200, 'Supplier A'), offer('Orchid Suites', 4500, 'Supplier B')]);
    expect(result.map((o) => o.name)).toEqual(['Lemon Leaf', 'Orchid Suites']);
  });

  it('treats names as the same hotel regardless of case and spacing', () => {
    const result = selectBestOffers([offer('Tajj  Palace', 12500, 'Supplier A'), offer(' tajj palace', 11900, 'Supplier B')]);
    expect(result).toHaveLength(1);
    expect(result[0].price).toBe(11900);
  });

  it('breaks a price tie by higher commission, independent of input order', () => {
    const a = offer('Leela Grand', 9800, 'Supplier A', 15);
    const b = offer('Leela Grand', 9800, 'Supplier B', 17);
    expect(selectBestOffers([a, b])).toEqual([b]);
    expect(selectBestOffers([b, a])).toEqual([b]);
  });

  it('breaks a full tie by supplier name so the result is deterministic', () => {
    const a = offer('Holtin', 5000, 'Supplier A', 10);
    const b = offer('Holtin', 5000, 'Supplier B', 10);
    expect(selectBestOffers([b, a])).toEqual([a]);
  });

  it('sorts by price ascending and returns [] for no offers', () => {
    const result = selectBestOffers([offer('C', 300, 'Supplier A'), offer('A', 100, 'Supplier B'), offer('B', 200, 'Supplier A')]);
    expect(result.map((o) => o.price)).toEqual([100, 200, 300]);
    expect(selectBestOffers([])).toEqual([]);
  });
});
