import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { Client } from '@temporalio/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/api/app';
import { AllSuppliersUnavailableError, type HotelOffersService, type OffersResponse } from '../src/api/hotel-offers-service';
import type { HotelCache } from '../src/lib/hotel-cache';

const offers = [{ name: 'Holtin', price: 5340, supplier: 'Supplier B', commissionPct: 20 }];

let next: () => Promise<OffersResponse>;
const calls: { method: string; args: unknown[] }[] = [];

const hotelOffers = {
  async getOffers(...args: unknown[]) {
    calls.push({ method: 'getOffers', args });
    return next();
  },
  async getOffersInPriceRange(...args: unknown[]) {
    calls.push({ method: 'getOffersInPriceRange', args });
    return next();
  },
} as unknown as HotelOffersService;

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = createApp({
    hotelOffers,
    client: {} as Client,
    cache: {} as HotelCache,
    supplierBaseUrl: 'http://unused',
  });
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.close();
});

beforeEach(() => {
  calls.length = 0;
  next = async () => ({ offers, cache: 'BYPASS' });
});

describe('GET /api/hotels', () => {
  it('returns the offers array and normalises the city', async () => {
    const res = await fetch(`${baseUrl}/api/hotels?city=%20Delhi%20`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(offers);
    expect(calls).toEqual([{ method: 'getOffers', args: ['delhi'] }]);
  });

  it('routes price filters to the Redis path', async () => {
    next = async () => ({ offers, cache: 'HIT' });
    const res = await fetch(`${baseUrl}/api/hotels?city=delhi&minPrice=5000`);
    expect(res.headers.get('x-cache')).toBe('HIT');
    expect(calls).toEqual([{ method: 'getOffersInPriceRange', args: ['delhi', { minPrice: 5000, maxPrice: undefined }] }]);
  });

  it.each([
    ['', 'city'],
    ['?city=', 'city'],
    ['?city=d3lhi', 'city'],
    ['?city=delhi&minPrice=abc', 'minPrice'],
    ['?city=delhi&maxPrice=-1', 'maxPrice'],
    ['?city=delhi&minPrice=9000&maxPrice=5000', 'minPrice'],
  ])('rejects %s with 400', async (query, field) => {
    const res = await fetch(`${baseUrl}/api/hotels${query}`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { details: { field: string }[] };
    expect(body.details.map((d) => d.field)).toContain(field);
    expect(calls).toHaveLength(0);
  });

  it('flags a partially failed request in a header', async () => {
    next = async () => ({
      offers,
      cache: 'BYPASS',
      suppliers: [
        { supplier: 'Supplier A', status: 'ok', hotels: 1 },
        { supplier: 'Supplier B', status: 'failed', hotels: 0, error: 'HTTP 503' },
      ],
    });
    const res = await fetch(`${baseUrl}/api/hotels?city=delhi`);
    expect(res.status).toBe(200);
    expect(res.headers.get('x-suppliers-unavailable')).toBe('Supplier B');
  });

  it('maps every supplier failing to 502', async () => {
    next = async () => {
      throw new AllSuppliersUnavailableError([]);
    };
    const res = await fetch(`${baseUrl}/api/hotels?city=delhi`);
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toBe('All suppliers are unavailable');
  });

  it('maps unexpected errors to 503 without leaking details', async () => {
    next = async () => {
      throw new Error('14 UNAVAILABLE: connect ECONNREFUSED 127.0.0.1:7233');
    };
    const res = await fetch(`${baseUrl}/api/hotels?city=delhi`);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Service temporarily unavailable' });
  });
});

describe('mock suppliers', () => {
  it('serve city-filtered inventory with overlapping names', async () => {
    const [a, b] = await Promise.all(
      ['A', 'B'].map((id) =>
        fetch(`${baseUrl}/supplier${id}/hotels?city=delhi`).then((r) => r.json() as Promise<{ name: string }[]>),
      ),
    );
    const namesA = new Set(a.map((h) => h.name));
    expect(b.some((h) => namesA.has(h.name))).toBe(true);
  });

  it('can be taken down and brought back', async () => {
    await fetch(`${baseUrl}/supplierA/outage`, { method: 'POST' });
    expect((await fetch(`${baseUrl}/supplierA/hotels`)).status).toBe(503);
    await fetch(`${baseUrl}/supplierA/outage`, { method: 'DELETE' });
    expect((await fetch(`${baseUrl}/supplierA/hotels`)).status).toBe(200);
  });
});

describe('browser access', () => {
  it('allows cross-origin calls and exposes the custom headers', async () => {
    const res = await fetch(`${baseUrl}/api/hotels?city=delhi`, { headers: { Origin: 'https://example.github.io' } });
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('access-control-expose-headers')).toContain('X-Suppliers-Unavailable');
  });

  it('answers preflight requests', async () => {
    const res = await fetch(`${baseUrl}/supplierB/outage`, {
      method: 'OPTIONS',
      headers: { Origin: 'https://example.github.io', 'Access-Control-Request-Method': 'DELETE' },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-methods')).toContain('DELETE');
  });

  it('rejects workflow ids that are not hotel offer runs', async () => {
    const res = await fetch(`${baseUrl}/api/workflows/some-other-workflow`);
    expect(res.status).toBe(400);
  });
});
