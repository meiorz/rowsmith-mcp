# rowsmith-mcp

Seeded test data that does not change when you upgrade: pin the output version, and Rowsmith returns the same bytes for the same request and seed for as long as the service runs, checked by a golden test on every build. Fake test data from a schema, reproducible by seed. Free, no key. CSV, JSON or SQL, plus an MCP server for your agent.

```sh
curl -s https://testdata-api.re-jam620.workers.dev/v1/generate -H 'content-type: application/json' \
  -d '{"rows":20,"seed":42,"format":"csv","columns":[{"name":"order_id","type":"sequence","prefix":"ord_","pad":4},{"name":"email","type":"email"},{"name":"total_usd","type":"decimal","min":1,"max":500}]}'
```
First lines of the output (20 rows):
```csv
order_id,email,total_usd
ord_0001,amara.weber561@mail.test,230.25
ord_0002,maya.wang873@mail.test,17.04
```
Works in: [pytest](https://github.com/meiorz/rowsmith-mcp/tree/main/pytest-rowsmith), [Playwright](https://github.com/meiorz/rowsmith-mcp/tree/main/examples/playwright), [dbt](https://github.com/meiorz/rowsmith-mcp/tree/main/examples/dbt), [Postgres](https://github.com/meiorz/rowsmith-mcp/tree/main/examples/postgres)

[![pytest-rowsmith-test](https://github.com/meiorz/rowsmith-mcp/actions/workflows/pytest-rowsmith-test.yml/badge.svg)](https://github.com/meiorz/rowsmith-mcp/actions/workflows/pytest-rowsmith-test.yml) [![playwright-smoke](https://github.com/meiorz/rowsmith-mcp/actions/workflows/playwright-smoke.yml/badge.svg)](https://github.com/meiorz/rowsmith-mcp/actions/workflows/playwright-smoke.yml) [![dbt-smoke](https://github.com/meiorz/rowsmith-mcp/actions/workflows/dbt-smoke.yml/badge.svg)](https://github.com/meiorz/rowsmith-mcp/actions/workflows/dbt-smoke.yml) [![postgres-smoke](https://github.com/meiorz/rowsmith-mcp/actions/workflows/postgres-smoke.yml/badge.svg)](https://github.com/meiorz/rowsmith-mcp/actions/workflows/postgres-smoke.yml) [![rowsmith-mcp-test](https://github.com/meiorz/rowsmith-mcp/actions/workflows/rowsmith-mcp-test.yml/badge.svg)](https://github.com/meiorz/rowsmith-mcp/actions/workflows/rowsmith-mcp-test.yml) [![License: MIT](https://img.shields.io/github/license/meiorz/rowsmith-mcp)](https://github.com/meiorz/rowsmith-mcp/blob/main/LICENSE)

An MCP server for **Rowsmith**: fake test data (CSV, JSON or SQL INSERTs) generated from a table schema.
It is a thin client of the public Rowsmith API, free and rate-limited.

## Quickstart (60 seconds)
1. Add Rowsmith to Claude Desktop, Cursor or another MCP client:
   ```json
   {"mcpServers":{"rowsmith":{"command":"npx","args":["-y","rowsmith-mcp"]}}}
   ```
2. Ask: "Generate 20 orders with a fixed seed as CSV"
3. Or call the API directly:
   ```sh
   curl -s https://testdata-api.re-jam620.workers.dev/v1/generate -H 'content-type: application/json' \
     -d '{"rows":20,"seed":42,"format":"csv","columns":[{"name":"order_id","type":"sequence","prefix":"ord_","pad":4},{"name":"email","type":"email"},{"name":"total_usd","type":"decimal","min":1,"max":500}]}'
   curl -s 'https://testdata-api.re-jam620.workers.dev/v1/invalid?kind=email&count=5&seed=42'
   ID=$(curl -s https://testdata-api.re-jam620.workers.dev/v1/sandbox -H 'content-type: application/json' -d '{"seed":42}' | sed -E 's/.*"id":"([^"]+)".*/\1/')
   curl -s https://testdata-api.re-jam620.workers.dev/v1/sandbox/$ID/charges -H 'content-type: application/json' \
     -d '{"amount":1999,"currency":"usd","card":"4242424242424242"}'
   ```
   Python's standard-library urllib is blocked by Cloudflare before it reaches the API (403, error code 1010) when it sends its default User-Agent. Set your own, e.g. `User-Agent: my-tests/1.0`. In our tests on 2026-10-18, requests, httpx, aiohttp, Node and curl worked with their defaults.

- Free, rate-limited, no account, no API key.
- Paid plans with higher limits (Pro, Team): https://testdata-api.re-jam620.workers.dev/pricing. The free tier stays.
- The same schema and seed give byte-identical output for the same generator version.
- An invalid-values catalogue with the reason each value is invalid.
- A payment sandbox that never moves money: a sandbox and everything in it is deleted 1 hour after it is created. It accepts only card numbers from Stripe's published testing list and stores no free text you send.
- Listed on the official MCP Registry as io.github.meiorz/rowsmith.

## What the data is
- No real person's data is used as input, and no record is derived from a real person. Emails, phone numbers,
  card numbers, SSN-shaped and IBAN-shaped values come only from reserved or invalid ranges.
- The same schema and seed give byte-identical output for the same generator version (sent as
  `x-generator-version`), so fixtures are reproducible.
- Send schemas only. Never send real data.

## Tools
| Tool | What it does |
|---|---|
| `generate_test_data` | `columns` (1-50) or `schema` (a JSON Schema object, or `{openapi, component}`), optional `rows` (1-500), `seed`, `format` (`csv`, `json`, `sql`), `table`, `output_path`, `overwrite`, `chaos`; or `tables` instead, for related tables in one call (see below) |
| `list_column_types` | the supported column types and their options |
| `invalid_values` | invalid-on-purpose TEST DATA values with the reason each is invalid: `kind` (`email`, `card`, `address`, `unicode`, `iban`, `ssn`, `all`), `count`, `seed`, `fields`, `chaos` |
| `sandbox_create` (listed only when the service advertises the sandbox) | create a payment sandbox (TEST DATA; deleted 1 hour after creation): optional `seed` |
| `sandbox_payments` (listed only when the service advertises the sandbox) | `sandbox_id`, `action` (`charge`, `refund`, `list`, `get`, `reset`), `amount`, `currency`, `card`, `charge`, `reference`, `limit`, `fields`, `chaos` |

At startup the server reads `/pricing.json` once (30 s timeout, cached for the process) and lists the
two sandbox tools only if the service advertises `/v1/sandbox` there. If that request fails, the sandbox tools stay
hidden and the server's instructions and `list_column_types` output say why; restart to check again. Tool-definition size, measured as characters of
the `tools/list` JSON (names, titles, descriptions and input schemas) divided by 4: 3 tools, about 1370 tokens
(5477 characters); 5 tools, about 1978 tokens (7910 characters). Measure with `node scripts/tool-tokens.js`.

For more than about 50 rows, pass `output_path`: the server writes the file and returns a summary (rows, bytes,
sha256, the header line) instead of putting the data in the model's context. Files can only be written inside the
write root: the server's working directory by default, or `ROWSMITH_OUT_DIR` when set (which moves or narrows it).
Paths with `..` segments or outside the root are refused, and an existing file is replaced only with
`overwrite: true`.

Instead of `columns`, `generate_test_data` takes `schema`: a JSON Schema object (type object with properties), such
as a Pydantic (`model_json_schema()`) or Zod export, or an OpenAPI component as `{"openapi": <document>,
"component": "Order"}`. The service maps it to columns and names the properties it could not map (arrays, patterns
and other unsupported forms) at the end of the result; nothing is guessed. Before sending, the server removes
`example`, `examples`, `default`, `const` and `x-*` keys from the schema, so their values do not leave your machine
and are not in the reproduce curl; the service ignores them too. For an OpenAPI component, only the named component and the schemas it
references are sent. The mapping is described at
https://testdata-api.re-jam620.workers.dev/openapi.json.

The tools form a chain, and each description says which comes next: `generate_test_data` first (with
`list_column_types` for a type's options), then `invalid_values` for values your code should reject, then
`sandbox_create` and `sandbox_payments` for a payment flow when they are listed.

Every `generate_test_data` result ends with a reproduce line: the exact curl, with the seed the service used and
the generator version pinned, that regenerates the same bytes. Chaos options are left out of it. A pinned version is served as long as the service runs; a retired version answers 409. A version's output is not changed in place: a golden test checks its bytes on every build. Above the reproduce line, a result that returns
the data carries `Output sha256 <hex>`, the sha256 of the data's bytes (the service's `X-Output-SHA256`); with
`output_path` the summary's sha256 line is that value. Pin it in a golden manifest to detect drift (format:
https://testdata-api.re-jam620.workers.dev/llms.txt).

`chaos` makes the service misbehave on purpose, to test error handling: `fail` (e.g. `"429@0.2"`; also 500, 503),
`latency_ms` (at most 3000), `empty_result`, `attempt`. Outcomes are fixed by seed and attempt.

The payment sandbox is a fake card processor: it moves no money and contacts no payment provider. It accepts only
card numbers from Stripe's published testing list (`4242424242424242` succeeds; `invalid_values` with kind `card`
lists the declining numbers and their codes), and refuses any other card-like number in any field. Every object is
marked `"livemode": false`, `"sandbox": true` and TEST DATA.

Column types: `uuid`, `sequence`, `integer`, `decimal`, `boolean`, `enum`, `date`, `datetime`, `first_name`,
`last_name`, `full_name`, `email`, `phone`, `test_card`, `ssn_invalid`, `iban_invalid`, `text`.

## Use
```json
{
  "mcpServers": {
    "rowsmith": {
      "command": "npx",
      "args": ["-y", "rowsmith-mcp"],
      "env": { "ROWSMITH_OUT_DIR": "/path/to/your/project/fixtures" }
    }
  }
}
```

`ROWSMITH_OUT_DIR` is optional. Without it, files can only be written inside the directory the server runs in; set
it to choose a specific folder, such as your project's fixtures directory.

Example call:
```json
{ "rows": 3, "seed": 42, "format": "csv",
  "columns": [ { "name": "order_id", "type": "sequence", "prefix": "ord_", "pad": 4 },
               { "name": "email", "type": "email" },
               { "name": "total_usd", "type": "decimal", "min": 1, "max": 500 } ] }
```

Related tables in one call: pass `tables` instead of `columns` (it calls `POST /v1/dataset`). A column
`{"name": "customer_id", "type": "ref", "table": "customers", "column": "id"}` takes its values from the primary key
generated for an earlier table in the same call, so the keys agree; refs resolve only inside the request and nothing
is stored. `format` is `sql` (CREATE TABLE and INSERTs) or `json`; at most 10 tables and 500 rows in total.
Written in the dialect common to PostgreSQL and SQLite 3.23 or later; CI executes it in SQLite with foreign keys enforced and in PostgreSQL 16. The result adds `Rows sha256 per table`, the same for the SQL and the JSON form of
one request, and the reproduce curl pins the dataset version too. Example call (the tool's arguments):
```json
{"seed":42,"format":"sql","tables":[{"name":"customers","rows":3,"columns":[{"name":"id","type":"uuid"},{"name":"email","type":"email"}]},{"name":"orders","rows":5,"columns":[{"name":"id","type":"sequence"},{"name":"customer_id","type":"ref","table":"customers","column":"id"},{"name":"total","type":"decimal","min":5,"max":500}]}]}
```

## GitHub Action: fixtures in CI
`fixtures/action.yml` is a composite action that writes a fixture file with one call to `/v1/generate`. Inputs:
`schema` (path to a JSON file holding a columns array or a full request), `out` (the file to write), and optional
`seed`, `rows` and `format` (csv, json or sql), which replace the file's values when given. On any answer other
than 200 the step fails with the service's error and its `next` step. Nothing is cached, and no key is needed.
Use the tag `meiorz/rowsmith-mcp/fixtures@v0.2.3` (or @main to try the latest).

```yaml
name: fixtures
on: [push]
jobs:
  fixtures:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: meiorz/rowsmith-mcp/fixtures@v0.2.3
        with:
          schema: test/fixtures/orders.schema.json
          seed: "42"
          rows: "200"
          format: csv
          out: test/fixtures/orders.csv
      - run: npm test
```

with `test/fixtures/orders.schema.json`:
```json
[{ "name": "order_id", "type": "sequence", "prefix": "ord_", "pad": 4 },
 { "name": "email", "type": "email" },
 { "name": "total_usd", "type": "decimal", "min": 1, "max": 500 }]
```

The same schema and seed give byte-identical output for the same generator version, so the file is the same on
every run until the generator version changes. The step's `generator-version` output reports the version used.
Each run counts against the daily limit of the runner's address. GitHub-hosted runners share addresses, so the limit can be reached by other users' runs.

Optional `extra-header` (since v0.2.3; not in v0.2.2) adds one request header, as `Name: value` in printable ASCII. It
is empty by default, which sends no extra header.

`.github/workflows/canary.yml` is our hourly uptime check: it sends the fixed canary request (the golden request,
exactly these body bytes) with `x-rowsmith-canary: 1` and fails unless the answer's sha256 is
`50db558e2e8c54353ac38a3125deb91642895db302eec334afeec2406537f821`. The service treats a call as its canary only with
that header and that exact body; any other call with the header is an ordinary call. The workflow also probes
Python's urllib with its default User-Agent (an ordinary call, without the canary header) and writes the result
(blocked or passing) to the job summary, without failing the job.

## Limits and terms
Up to 500 rows and 50 columns per call, with daily limits per caller; over a limit the tool returns the service's
429 message with the retry time. Calls time out after 30 s. The server holds no keys and writes nothing unless you
pass `output_path`. Calls go to https://testdata-api.re-jam620.workers.dev (override with `ROWSMITH_URL`).

The MIT licence covers this wrapper's code only. Use of the Rowsmith service stays under its terms of use, which bind
whoever runs the agent.

Terms of use: https://testdata-api.re-jam620.workers.dev/terms · Data notice:
https://testdata-api.re-jam620.workers.dev/privacy · Published by meiorz · Contact: business@meiorz.tech

Privacy, data and deletion requests: business@meiorz.tech only, never in a public issue.
