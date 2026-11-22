// Shared between the API, activities and the workflow. Keep this file free of
// runtime imports: the workflow bundle must stay deterministic.

export type SupplierId = 'A' | 'B';

export const SUPPLIER_IDS: readonly SupplierId[] = ['A', 'B'];

export function supplierName(id: SupplierId): string {
  return `Supplier ${id}`;
}

/** What a supplier API returns. */
export interface SupplierHotel {
  hotelId: string;
  name: string;
  price: number;
  city: string;
  commissionPct: number;
}

/** What our API returns: one best offer per hotel. */
export interface HotelOffer {
  name: string;
  price: number;
  supplier: string;
  commissionPct: number;
}

export interface SupplierOutcome {
  supplier: string;
  status: 'ok' | 'failed';
  hotels: number;
  error?: string;
}

export interface HotelOffersInput {
  city: string;
}

export interface HotelOffersResult {
  city: string;
  offers: HotelOffer[];
  suppliers: SupplierOutcome[];
  cached: boolean;
}
