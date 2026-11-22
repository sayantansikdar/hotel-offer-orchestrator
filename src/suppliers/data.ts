import type { SupplierHotel, SupplierId } from '../types';

// Static inventory. Delhi and Mumbai overlap between the suppliers so the
// comparison has something to do; Goa is only on Supplier A and Jaipur only on B.
export const supplierInventory: Record<SupplierId, SupplierHotel[]> = {
  A: [
    { hotelId: 'a1', name: 'Holtin', price: 6000, city: 'delhi', commissionPct: 10 },
    { hotelId: 'a2', name: 'Radison', price: 5900, city: 'delhi', commissionPct: 13 },
    { hotelId: 'a3', name: 'Tajj Palace', price: 12500, city: 'delhi', commissionPct: 8 },
    { hotelId: 'a4', name: 'Leela Grand', price: 9800, city: 'delhi', commissionPct: 15 },
    { hotelId: 'a5', name: 'Lemon Leaf', price: 3200, city: 'delhi', commissionPct: 12 },
    { hotelId: 'a6', name: 'Sea Breeze', price: 7400, city: 'mumbai', commissionPct: 11 },
    { hotelId: 'a7', name: 'Marine Inn', price: 4100, city: 'mumbai', commissionPct: 9 },
    { hotelId: 'a8', name: 'Palm Shore', price: 5600, city: 'goa', commissionPct: 14 },
  ],
  B: [
    { hotelId: 'b1', name: 'Holtin', price: 5340, city: 'delhi', commissionPct: 20 },
    { hotelId: 'b2', name: 'Radison', price: 6150, city: 'delhi', commissionPct: 18 },
    { hotelId: 'b3', name: 'Tajj Palace', price: 11900, city: 'delhi', commissionPct: 10 },
    // Same price as Supplier A: the higher commission wins the tie.
    { hotelId: 'b4', name: 'Leela Grand', price: 9800, city: 'delhi', commissionPct: 17 },
    { hotelId: 'b5', name: 'Orchid Suites', price: 4500, city: 'delhi', commissionPct: 16 },
    { hotelId: 'b6', name: 'Sea Breeze', price: 6900, city: 'mumbai', commissionPct: 12 },
    { hotelId: 'b7', name: 'Gateway Residency', price: 8200, city: 'mumbai', commissionPct: 10 },
    { hotelId: 'b8', name: 'Pink City Haveli', price: 4800, city: 'jaipur', commissionPct: 15 },
  ],
};
