import express, { type NextFunction, type Request, type Response } from 'express';
import { pinoHttp } from 'pino-http';
import { z } from 'zod';
import { logger } from '../lib/logger';
import { supplierRouter } from '../suppliers/router';
import { checkHealth, type HealthDeps } from './health';
import { AllSuppliersUnavailableError, CacheUnavailableError, type HotelOffersService, type OffersResponse } from './hotel-offers-service';

const price = z.coerce.number({ error: 'must be a number' }).finite().nonnegative('must be 0 or more');

const hotelsQuery = z
  .object({
    city: z
      .string({ error: 'city is required' })
      .trim()
      .toLowerCase()
      .regex(/^[a-z][a-z .-]{0,49}$/, 'city must be 1-50 letters'),
    minPrice: price.optional(),
    maxPrice: price.optional(),
  })
  .refine((q) => q.minPrice === undefined || q.maxPrice === undefined || q.minPrice <= q.maxPrice, {
    message: 'minPrice must not exceed maxPrice',
    path: ['minPrice'],
  });

export interface AppDeps extends HealthDeps {
  hotelOffers: HotelOffersService;
}

function setOffersHeaders(res: Response, result: OffersResponse): void {
  res.setHeader('X-Cache', result.cache);
  if (result.workflowId) res.setHeader('X-Workflow-Id', result.workflowId);
  const failed = result.suppliers?.filter((s) => s.status === 'failed').map((s) => s.supplier) ?? [];
  if (failed.length > 0) res.setHeader('X-Suppliers-Unavailable', failed.join(', '));
}

export function createApp(deps: AppDeps): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(
    pinoHttp({
      logger,
      // Health probes and the worker's supplier calls would drown out the useful lines.
      autoLogging: { ignore: (req) => req.url === '/health' },
      customLogLevel: (_req, res, err) => (err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info'),
    }),
  );

  app.use(supplierRouter());

  app.get('/api/hotels', async (req, res) => {
    const parsed = hotelsQuery.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({
        error: 'Invalid query',
        details: parsed.error.issues.map((i) => ({ field: i.path.join('.'), message: i.message })),
      });
      return;
    }

    const { city, minPrice, maxPrice } = parsed.data;
    const filtering = minPrice !== undefined || maxPrice !== undefined;
    const result = filtering
      ? await deps.hotelOffers.getOffersInPriceRange(city, { minPrice, maxPrice })
      : await deps.hotelOffers.getOffers(city);

    setOffersHeaders(res, result);
    res.json(result.offers);
  });

  app.get('/health', async (_req, res) => {
    const report = await checkHealth(deps);
    res.status(report.status === 'down' ? 503 : 200).json(report);
  });

  app.use((_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  app.use((err: Error, req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof AllSuppliersUnavailableError) {
      res.status(502).json({ error: err.message, suppliers: err.suppliers });
      return;
    }
    if (err instanceof CacheUnavailableError) {
      res.status(503).json({ error: err.message });
      return;
    }
    req.log.error({ err }, 'request failed');
    res.status(503).json({ error: 'Service temporarily unavailable' });
  });

  return app;
}
