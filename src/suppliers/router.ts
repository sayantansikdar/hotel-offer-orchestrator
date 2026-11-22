import { Router } from 'express';
import { config } from '../config';
import { logger } from '../lib/logger';
import { SUPPLIER_IDS, supplierName, type SupplierId } from '../types';
import { supplierInventory } from './data';

// In-memory outage switches, so a test run can take a supplier down and bring
// it back without restarting anything.
const outage: Record<SupplierId, boolean> = {
  A: config.supplierADown,
  B: config.supplierBDown,
};

export function isSupplierDown(id: SupplierId): boolean {
  return outage[id];
}

/**
 * Mock supplier APIs, mounted at /supplierA and /supplierB:
 *   GET    /supplierX/hotels?city=delhi   static inventory (all cities without ?city)
 *   POST   /supplierX/outage              simulate the supplier being down (503)
 *   DELETE /supplierX/outage              bring it back
 */
export function supplierRouter(): Router {
  const router = Router();

  for (const id of SUPPLIER_IDS) {
    const base = `/supplier${id}`;

    router.get(`${base}/hotels`, (req, res) => {
      if (outage[id]) {
        res.status(503).json({ error: `${supplierName(id)} is unavailable` });
        return;
      }
      const city = typeof req.query.city === 'string' ? req.query.city.trim().toLowerCase() : '';
      const hotels = city
        ? supplierInventory[id].filter((hotel) => hotel.city === city)
        : supplierInventory[id];
      res.json(hotels);
    });

    router.post(`${base}/outage`, (_req, res) => {
      outage[id] = true;
      logger.warn({ supplier: supplierName(id) }, 'supplier outage simulated');
      res.json({ supplier: supplierName(id), down: true });
    });

    router.delete(`${base}/outage`, (_req, res) => {
      outage[id] = false;
      logger.info({ supplier: supplierName(id) }, 'supplier outage cleared');
      res.json({ supplier: supplierName(id), down: false });
    });
  }

  return router;
}
