# Hotel Offer Orchestrator

Aggregates hotel offers from two suppliers, keeps the cheapest offer per hotel, and lets you filter the result by price. The comparison runs as a **Temporal** workflow, and the deduplicated list is cached in **Redis**, where the price filtering happens.

**Stack:** Node.js 22 · TypeScript · Express 5 · Temporal · Redis · Docker Compose

```
                      ┌──────────────────────────── api (Express) ────────────────────────────┐
 GET /api/hotels ───▶ │ validate query ──▶ start workflow ──────────────▶ JSON array         │
 ?city&minPrice&max   │        │              (no price filter)                               │
                      │        └──▶ price filter? ──▶ Redis ZRANGE BYSCORE (on miss: run the  │
                      │                                 workflow first, then filter)          │
                      │ GET /supplierA/hotels   GET /supplierB/hotels   (mock suppliers)      │
                      │ GET /health                                                           │
                      └──────────────▲─────────────────────▲────────────────────────────────┘
                                     │ HTTP                │ HTTP
 ┌─ temporal ─┐      ┌──────────────── worker ─────────────┴───────────────┐      ┌─ redis ─┐
 │ dev server │◀────▶│ hotelOffersWorkflow                                 │      │ sorted  │
 │  + Web UI  │      │   ├─ fetchSupplierHotels(A) ┐ parallel, 3 attempts  │      │ set per │
 └────────────┘      │   ├─ fetchSupplierHotels(B) ┘ each with backoff     │      │  city   │
                     │   ├─ selectBestOffers  (dedupe by name, cheapest)   │      └────▲────┘
                     │   └─ cacheHotelOffers  ─────────────────────────────┼───────────┘
                     └─────────────────────────────────────────────────────┘
```

## Quick start

Requirements: Docker with Compose v2.

```bash
git clone <this-repo> && cd hotel-offer-orchestrator
docker compose up -d --build
curl "http://localhost:3000/api/hotels?city=delhi"
```

This starts four containers: `api` (port 3000), `worker`, `temporal` (gRPC 7233, Web UI at <http://localhost:8233>) and `redis` (6379). Every workflow run can be inspected in the Temporal UI.

If port 3000 is taken, use `API_PORT=3001 docker compose up -d`.

Stop with `docker compose down`. The Temporal dev server and Redis keep data in memory, so a restart starts clean.

## API

### `GET /api/hotels?city=delhi`

Runs the workflow and returns the best offer per hotel, cheapest first:

```json
[
  { "name": "Lemon Leaf",    "price": 3200,  "supplier": "Supplier A", "commissionPct": 12 },
  { "name": "Orchid Suites", "price": 4500,  "supplier": "Supplier B", "commissionPct": 16 },
  { "name": "Holtin",        "price": 5340,  "supplier": "Supplier B", "commissionPct": 20 },
  { "name": "Radison",       "price": 5900,  "supplier": "Supplier A", "commissionPct": 13 },
  { "name": "Leela Grand",   "price": 9800,  "supplier": "Supplier B", "commissionPct": 17 },
  { "name": "Tajj Palace",   "price": 11900, "supplier": "Supplier B", "commissionPct": 10 }
]
```

Every call runs a new workflow, so it also refreshes the Redis entry for that city.

### `GET /api/hotels?city=delhi&minPrice=4000&maxPrice=6000`

Returns the cached list for the city, filtered inside Redis. Either bound may be left out, and both are inclusive. If the city isn't cached yet, the workflow runs first and fills the cache, then the filter runs.

```json
[
  { "name": "Orchid Suites", "price": 4500, "supplier": "Supplier B", "commissionPct": 16 },
  { "name": "Holtin",        "price": 5340, "supplier": "Supplier B", "commissionPct": 20 },
  { "name": "Radison",       "price": 5900, "supplier": "Supplier A", "commissionPct": 13 }
]
```

The body is always the plain array from the spec. Extra information goes in headers:

| Header | Meaning |
|---|---|
| `X-Cache` | `BYPASS` (live workflow), `HIT` (served from Redis), `MISS` (workflow ran, then Redis filtered) |
| `X-Workflow-Id` | The Temporal workflow that produced the data. Search for it in the Temporal UI |
| `X-Suppliers-Unavailable` | Present only when a supplier failed, e.g. `Supplier B`. The body holds the other supplier's hotels |

The city is trimmed and case-insensitive. A city with no hotels returns `200 []`.

| Status | When |
|---|---|
| `200` | Success, including partial results when one supplier is down |
| `400` | Missing or invalid `city`, non-numeric or negative price, `minPrice > maxPrice`. The body lists the problem fields |
| `502` | Every supplier failed after retries. The body lists each supplier's error |
| `503` | Temporal unreachable, or a price filter requested while Redis is down |

### `GET /health`

Probes both suppliers the same way the workflow reaches them, plus Redis and Temporal:

```json
{
  "status": "degraded",
  "timestamp": "2026-11-22T09:15:24.632Z",
  "suppliers": {
    "Supplier A": { "status": "up", "latencyMs": 11 },
    "Supplier B": { "status": "down", "latencyMs": 4, "error": "HTTP 503" }
  },
  "dependencies": {
    "redis":    { "status": "up", "latencyMs": 5 },
    "temporal": { "status": "up", "latencyMs": 5 }
  }
}
```

- `ok` (200): everything is up.
- `degraded` (200): one supplier or Redis is down. Requests still succeed, either with partial data or without price filtering.
- `down` (503): both suppliers or Temporal are down, so `/api/hotels` cannot succeed.

### Mock suppliers

| Endpoint | |
|---|---|
| `GET /supplierA/hotels?city=delhi` | Static inventory. Without `?city` it returns every city |
| `GET /supplierB/hotels?city=delhi` | Same for Supplier B |
| `POST /supplierA/outage` / `DELETE /supplierA/outage` | Take Supplier A down (it answers 503) or bring it back. Same for B |

Inventory lives in [`src/suppliers/data.ts`](src/suppliers/data.ts):

- **delhi** and **mumbai** overlap between the suppliers.
- **goa** is only on Supplier A, and **jaipur** only on Supplier B.
- Delhi includes one exact price tie (Leela Grand at 9800).

To start with a supplier already down, run `SUPPLIER_B_DOWN=true docker compose up -d`.

## How it works

**Workflow** ([`src/temporal/workflows.ts`](src/temporal/workflows.ts)): `hotelOffersWorkflow` calls the `fetchSupplierHotels` activity for both suppliers in parallel with `Promise.allSettled`, so one failure never cancels the other call.

- **Retries:** each activity call has a 5 s timeout and up to 3 attempts, starting with a 300 ms backoff that doubles each time.
- **Partial failure:** if one supplier still fails after the retries, the workflow logs it and continues with the other supplier's hotels.
- **Total failure:** if both fail, the workflow raises a non-retryable `AllSuppliersUnavailable` failure, and the API maps it to 502.

**Deduplication** ([`src/lib/select-best-offers.ts`](src/lib/select-best-offers.ts)): hotels are matched by name, ignoring case and extra whitespace.

- The lowest price wins.
- On a price tie, the higher `commissionPct` wins, since that offer earns more.
- On a full tie, the result is ordered by supplier name, so it never depends on which supplier answered first.
- A hotel that only one supplier returns is kept as is.

The function is pure, so it runs inside the workflow without breaking determinism. The output is sorted by price.

**Activities** ([`src/temporal/activities.ts`](src/temporal/activities.ts)): the worker calls the suppliers over HTTP, as it would call real external APIs.

- Network errors and 5xx responses are retryable.
- 4xx responses and payloads that fail schema validation (zod) are non-retryable, since retrying won't fix them.

**Redis** ([`src/lib/hotel-cache.ts`](src/lib/hotel-cache.ts)): each city is a sorted set `hotels:{city}:offers`, scored by price. The member is the whole offer as JSON, so a price filter is a single `ZRANGE key min max BYSCORE` with no second lookup.

- Writes run in one `MULTI` transaction (delete, add, expire), so a reader never sees a half-written list.
- A companion key `hotels:{city}:meta` records that the city was fetched. This tells "cached, zero hotels" apart from "not cached".
- Entries expire after `CACHE_TTL_SECONDS` (default 300).
- Partial results, written while a supplier is down, expire after `PARTIAL_CACHE_TTL_SECONDS` (default 30), so the cache recovers quickly once the supplier is back.
- If Redis is down, `GET /api/hotels?city=` still answers from the workflow. Only the price filter returns 503.

**Logging and errors:** the API logs structured JSON with pino, one line per request plus errors. The worker and workflow log through Temporal's logger, which includes the workflow and run IDs automatically. Unexpected errors return a generic 503 and are logged in full on the server, not exposed to the client.

## Testing

```bash
npm ci
npm test                 # vitest: dedupe rules, workflow, HTTP layer
```

- `test/select-best-offers.test.ts` covers the dedupe rules: cheapest wins, single-supplier hotels, name normalisation and tie-breaks.
- `test/workflow.test.ts` runs the real workflow on a local Temporal test server with stubbed activities. It covers both suppliers up, one supplier failing (retried 3 times, then a partial result), both failing, and the Redis write failing. The first run downloads the Temporal test server.
- `test/api.test.ts` covers query validation, routing to the Redis path, status code mapping and the mock supplier outage switch.

**Postman:** import [`postman/hotel-offer-orchestrator.postman_collection.json`](postman/hotel-offer-orchestrator.postman_collection.json) and set `baseUrl` (default `http://localhost:3000`). Run the folders in order, because folder 5 takes suppliers down and brings them back. The collection has 23 requests and 57 assertions, covering:

- health
- the mock suppliers and their overlap
- delhi, with the cheapest supplier chosen per hotel
- price ranges (both bounds, one bound, no matches)
- a city with no results
- validation errors
- one supplier down, both down, and recovery

To run it from the command line against the running stack:

```bash
npm run test:postman                                   # baseUrl http://localhost:3000
npx newman run postman/*.json --env-var baseUrl=http://localhost:3001
```

## Running without Docker (development)

```bash
npm ci
docker compose up -d temporal redis  # or run `temporal server start-dev` plus a local Redis
cp .env.example .env                 # defaults point at localhost
set -a; source .env; set +a
npm run dev:api                      # terminal 1
npm run dev:worker                   # terminal 2
```

## Configuration

| Variable | Default | |
|---|---|---|
| `PORT` | `3000` | API port inside the container |
| `API_PORT` | `3000` | Host port Compose publishes the API on |
| `SUPPLIER_BASE_URL` | `http://localhost:3000` | Where the worker and health check reach the suppliers (`http://api:3000` in Compose) |
| `SUPPLIER_TIMEOUT_MS` | `3000` | Per-request supplier timeout |
| `TEMPORAL_ADDRESS` | `localhost:7233` | Temporal frontend |
| `TEMPORAL_NAMESPACE` | `default` | |
| `TEMPORAL_TASK_QUEUE` | `hotel-offers` | |
| `REDIS_URL` | `redis://localhost:6379` | |
| `CACHE_TTL_SECONDS` | `300` | TTL for a complete result |
| `PARTIAL_CACHE_TTL_SECONDS` | `30` | TTL when a supplier was unavailable |
| `SUPPLIER_A_DOWN` / `SUPPLIER_B_DOWN` | `false` | Start with a supplier simulated as down |
| `LOG_LEVEL` | `info` | pino level |

## Deployment

The app ships as a single image ([`Dockerfile`](Dockerfile)): a multi-stage build on `node:22-bookworm-slim` that runs as a non-root user with production dependencies only. The image runs either role:

- API: `node dist/api/server.js` (the default command)
- Worker: `node dist/temporal/worker.js`

**On any Docker host (VM, EC2, Droplet):**

```bash
git clone <this-repo> && cd hotel-offer-orchestrator
docker compose up -d --build
docker compose ps                     # api should be (healthy)
curl http://<host>:3000/health
```

**For production**, replace the two dev-grade dependencies and keep the app containers as they are:

- **Temporal:** point `TEMPORAL_ADDRESS` and `TEMPORAL_NAMESPACE` at Temporal Cloud or a self-hosted cluster backed by Postgres. Temporal Cloud also needs TLS or API-key settings on the client connection. The bundled `start-dev` server keeps data in memory.
- **Redis:** set `REDIS_URL` to a managed Redis.

**Live demo on Render (single container):** Render's free tier runs one container per service and has no place for a Temporal server, so [`deploy/Dockerfile.all-in-one`](deploy/Dockerfile.all-in-one) packs the Temporal dev server and Redis next to the API and the worker. [`deploy/start-all-in-one.sh`](deploy/start-all-in-one.sh) starts Redis and Temporal, waits for Temporal to be healthy, then starts the API and the worker. If any process exits, the container exits and Render restarts it. The whole container stays under about 300 MB, which fits the free 512 MB instance.

1. Fork or push this repo to GitHub.
2. In the Render dashboard, choose **New → Blueprint** and pick the repo. Render reads [`render.yaml`](render.yaml) and creates the `hotel-offer-orchestrator` web service.
3. Once the deploy finishes, open `https://<service>.onrender.com/health`.

On the free plan the service sleeps after 15 minutes without traffic, so the first request after a pause takes about a minute while it wakes up. Temporal and Redis run in memory, so their state resets on every restart or deploy. That's fine here, because a request rebuilds the cache from the suppliers.

To try the single container locally: `docker build -f deploy/Dockerfile.all-in-one -t hoo-aio . && docker run -p 3000:10000 hoo-aio`.

Workers scale horizontally. Every worker polls the same task queue, so you can add replicas with `docker compose up -d --scale worker=3`, or the equivalent on your orchestrator.

## Project structure

```
src/
  api/          server.ts (entry), app.ts (routes, validation, error mapping),
                hotel-offers-service.ts (workflow + cache logic), health.ts
  temporal/     workflows.ts, activities.ts, worker.ts (entry),
                bundle.ts (pre-bundles workflow code at build time)
  suppliers/    router.ts (mock endpoints + outage switch), data.ts (inventory)
  lib/          select-best-offers.ts, hotel-cache.ts, logger.ts
  config.ts, types.ts
test/           vitest suites
postman/        Postman collection
deploy/         single-container image and start script for Render
render.yaml     Render blueprint
```
