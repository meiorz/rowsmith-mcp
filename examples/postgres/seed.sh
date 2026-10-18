#!/usr/bin/env bash
# Seed a local Postgres table with 200 fake orders: ./seed.sh "postgres://localhost/app_test"
set -euo pipefail
DB="${1:?usage: seed.sh <database-url>}"
psql "$DB" -v ON_ERROR_STOP=1 -c 'CREATE TABLE IF NOT EXISTS orders (order_id text PRIMARY KEY, email text, total_usd numeric, created_at timestamptz)'
curl -sSf https://testdata-api.re-jam620.workers.dev/v1/generate -H 'content-type: application/json' -d '{
  "rows": 200, "seed": 42, "format": "sql", "table": "orders", "version": "1",
  "columns": [
    {"name": "order_id", "type": "sequence", "prefix": "ord_", "pad": 4},
    {"name": "email", "type": "email"},
    {"name": "total_usd", "type": "decimal", "min": 1, "max": 500},
    {"name": "created_at", "type": "datetime", "from": "2026-01-01", "to": "2026-06-30"}
  ]}' | psql "$DB" -v ON_ERROR_STOP=1 -q
psql "$DB" -c 'SELECT count(*) FROM orders'
