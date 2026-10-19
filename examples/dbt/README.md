# dbt with Rowsmith test data

A copy-paste example: a seeds-only dbt project whose seeds are two related tables from Rowsmith, `customers` and
`orders`, where every `orders.customer_id` is a `customers.id` of the same call. It runs on DuckDB in a local file,
with no server and no credentials.

- `request.json`: the request (`POST /v1/dataset`, seed 42, `"version": "1"`).
- `fetch_seeds.py`: refreshes `seeds/` from the service (Python standard library only, Python 3.9 or later). It writes
  `seeds/customers.csv`, `seeds/orders.csv` and `seeds/manifest.json`, which records the request, `X-Request-SHA256`
  and each table's `X-Dataset-Rows-SHA256`. The service answers SQL or JSON, so the script asks for JSON and writes
  the CSV itself (the format is in the script's docstring). Set `ROWSMITH_URL` to use another base URL.
- `models/orders_with_customers.sql`: orders joined to their customers.
- `seeds/schema.yml`, `models/schema.yml`, `tests/`: column types and tests (`not_null`, `unique`, `relationships`
  from `orders.customer_id` to `customers.id`, and every order keeps its customer in the join).

```sh
python -m venv .venv && . .venv/bin/activate
pip install --require-hashes --only-binary :all: -r requirements.txt
dbt seed --profiles-dir . && dbt run --profiles-dir . && dbt test --profiles-dir .
python fetch_seeds.py   # optional: refresh the seeds from the service
```

`requirements.in` pins `dbt-core` and `dbt-duckdb`; `requirements.txt` pins every package with its hashes and is
produced from it by the repository's `dbt-lock` workflow (`pip-compile --generate-hashes`).

The service is free and rate-limited: send schemas only, never real data. Every identifier comes from reserved or
invalid ranges (emails on example.com, example.net, example.org and mail.test). The same schema and seed give
byte-identical output for the same generator version; `request.json` pins `"version": "1"`.

The repository's `dbt-smoke` workflow runs `dbt seed`, `dbt run` and `dbt test` from the committed seeds, which the
service's own tests check against the Worker's answer, so CI makes no call to the service. `fetch_seeds.py` is not
run in CI.
