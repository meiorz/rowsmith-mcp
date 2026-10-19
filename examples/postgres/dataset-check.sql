-- Checks a loaded /v1/dataset answer for the documented example (customers 3, orders 5, orders.customer_id ->
-- customers.id) in Postgres: the row counts, no orphan orders, the foreign key constraint present and enforced.
-- Run after the dataset SQL: psql "$DB" -v ON_ERROR_STOP=1 -f dataset-check.sql (any failure raises an error).
DO $$
DECLARE
  n_customers bigint;
  n_orders bigint;
  n_orphans bigint;
  n_fk bigint;
BEGIN
  SELECT count(*) INTO n_customers FROM "customers";
  SELECT count(*) INTO n_orders FROM "orders";
  SELECT count(*) INTO n_orphans FROM "orders" o LEFT JOIN "customers" c ON c."id" = o."customer_id" WHERE c."id" IS NULL;
  SELECT count(*) INTO n_fk FROM information_schema.table_constraints
    WHERE table_name = 'orders' AND constraint_type = 'FOREIGN KEY';
  IF n_customers <> 3 THEN RAISE EXCEPTION 'customers: expected 3 rows, got %', n_customers; END IF;
  IF n_orders <> 5 THEN RAISE EXCEPTION 'orders: expected 5 rows, got %', n_orders; END IF;
  IF n_orphans <> 0 THEN RAISE EXCEPTION 'orders: % rows reference no customer', n_orphans; END IF;
  IF n_fk <> 1 THEN RAISE EXCEPTION 'orders: expected 1 foreign key constraint, got %', n_fk; END IF;
  BEGIN
    INSERT INTO "orders" ("id", "customer_id", "total") VALUES (99, 'no-such-customer', 1);
    RAISE EXCEPTION 'the foreign key accepted an unknown customer';
  EXCEPTION WHEN foreign_key_violation THEN
    NULL; -- refused, as it should be
  END;
  RAISE NOTICE 'ok: customers %, orders %, orphans 0, foreign key present and enforced', n_customers, n_orders;
END
$$;
