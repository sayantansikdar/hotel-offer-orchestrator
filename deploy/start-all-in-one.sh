#!/usr/bin/env bash
# Starts Redis, the Temporal dev server, the API and the worker in one container.
# If any of them exits, the container exits so the platform restarts it.
set -euo pipefail

export PORT="${PORT:-10000}"
export REDIS_URL="${REDIS_URL:-redis://127.0.0.1:6379}"
export TEMPORAL_ADDRESS="${TEMPORAL_ADDRESS:-127.0.0.1:7233}"
export SUPPLIER_BASE_URL="${SUPPLIER_BASE_URL:-http://127.0.0.1:${PORT}}"

LD_LIBRARY_PATH=/opt/redis /opt/redis/redis-server --bind 127.0.0.1 --port 6379 --save '' --appendonly no --maxmemory 32mb --maxmemory-policy allkeys-lru &

temporal server start-dev --ip 127.0.0.1 --headless --log-level warn &

until temporal operator cluster health --address "$TEMPORAL_ADDRESS" >/dev/null 2>&1; do sleep 0.5; done
echo "temporal is up"

SERVICE_NAME=api node dist/api/server.js &
SERVICE_NAME=worker node dist/temporal/worker.js &

# The script is PID 1, so pass shutdown signals on to the children.
trap 'kill -TERM $(jobs -p) 2>/dev/null; wait; exit 0' TERM INT

wait -n
echo "a process exited; stopping container" >&2
kill -TERM $(jobs -p) 2>/dev/null || true
exit 1
