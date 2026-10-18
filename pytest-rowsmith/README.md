# pytest-rowsmith

A pytest plugin with one fixture, `rowsmith`, that gives your tests reproducible fake test data (CSV, JSON or
SQL INSERTs) generated from a table schema by the Rowsmith API.

**Network use.** The plugin calls the Rowsmith API over the network (POST
https://testdata-api.re-jam620.workers.dev/v1/generate) only when a test calls `rowsmith.generate()` or
`rowsmith.fetch()` and that request is not in the cache yet: the first time a schema (with its rows, seed,
format, table and version) is used, or every schema once per run with `--rowsmith-refresh`. Importing the package,
loading the plugin and creating the fixture make no network call. Calls go to the free Rowsmith API under its terms
of use (https://testdata-api.re-jam620.workers.dev/terms) and count against your daily limit.

- Free, rate-limited, no account, no API key.
- The same schema and seed give byte-identical output for the same generator version. The plugin pins the
  version in every request (`"version": "1"` by default), so cached answers stay valid.
- Send schemas only. Never send real data.
- Identifiers come only from reserved or invalid ranges: emails use example.com, example.net, example.org and
  mail.test; phones, card numbers and SSN- and IBAN-shaped values come from reserved or invalid ranges too.
- No runtime dependency besides pytest; HTTP goes through the standard library's urllib.

## Install
```sh
pip install pytest-rowsmith
```
pytest loads the plugin automatically. Python 3.9 or later.

## Example
```python
ORDERS = [
    {"name": "order_id", "type": "sequence", "prefix": "ord_", "pad": 4},
    {"name": "email", "type": "email"},
    {"name": "total_usd", "type": "decimal", "min": 1, "max": 500},
]

def test_orders(rowsmith):
    orders = rowsmith.generate(ORDERS, rows=20, seed=42)
    assert len(orders) == 20 and orders[0]["order_id"] == "ord_0001"
    assert all(o["email"].rsplit("@", 1)[1] in ("example.com", "example.net", "example.org", "mail.test") for o in orders)
```
The column types and their options are listed at https://testdata-api.re-jam620.workers.dev/v1/types; the full
API is described at https://testdata-api.re-jam620.workers.dev/openapi.json.

## The fixture
`rowsmith` is session-scoped. Its methods take the same arguments:

| Argument | Default | Meaning |
|---|---|---|
| `columns` | (required) | list of column definitions, as in the API |
| `rows` | `10` | 1 to 500 |
| `seed` | `1` | always sent, so every call is reproducible |
| `format` | `"json"` | `"csv"`, `"json"` or `"sql"` |
| `table` | not sent | table name (used in SQL output) |
| `version` | `"1"` | generator version, always sent |

- `rowsmith.generate(columns, ...)` returns a list of dicts for `json` (values typed as in the JSON) and `csv`
  (values are strings), and the SQL text for `sql`.
- `rowsmith.fetch(columns, ...)` returns a `RowsmithResult` with `body` (the exact bytes), `text`, `sha256`,
  `headers`, `generator_version`, `seed`, `reproduce`, `from_cache` and `parsed()`. `reproduce` is the service's
  X-Reproduce line (sent with CSV and SQL answers, and kept in the cache); JSON answers carry none, so for them it
  is the request that was sent, in the same form.
- On anything other than a successful answer the call raises `pytest_rowsmith.RowsmithError`. Its message names
  the HTTP status, the service's error and `next` text, and the reproduce line. A 4xx answer is not retried; a 5xx
  answer or a network error is retried exactly once, 1 second later. There is no fallback to random or local data.
- Each request times out after 30 s.

`pytest_rowsmith.Rowsmith` is the same client outside pytest (`Rowsmith(base_url=..., cache=None)`).

## Caching and offline runs
Answers are stored in pytest's own cache (`.pytest_cache/v/rowsmith/v1/` in your project), one entry per request,
keyed by the sha256 of the exact request-body bytes. An entry holds the response bytes and four headers
(content-type, x-generator-version, x-seed, x-reproduce). A suite therefore calls the API once per distinct
request and then runs offline, as long as `.pytest_cache` is kept. A damaged entry is fetched again.

- `pytest --rowsmith-refresh` ignores the cache: each distinct request is sent once in that run and its entry is
  replaced.
- `pytest --cache-clear` removes the cache, Rowsmith entries included.
- With pytest's cache disabled (`-p no:cacheprovider`), answers are kept in memory for the run only.
- The cache key does not include the base URL.

## Configuration
| Setting | Where | Default |
|---|---|---|
| API base URL | `ROWSMITH_URL` environment variable, or `rowsmith_url` in your pytest ini file; the variable wins | `https://testdata-api.re-jam620.workers.dev` |
| Bypass the cache | `--rowsmith-refresh` | off |

Every request sends `User-Agent: pytest-rowsmith/<version>` and `x-rowsmith-tool: pytest`.

## Limits and terms
Up to 500 rows and 50 columns per call, with daily limits per caller; over a limit the call fails with the
service's 429 message. Use of the Rowsmith service is under its terms of use:
https://testdata-api.re-jam620.workers.dev/terms. Data notice: https://testdata-api.re-jam620.workers.dev/privacy.

The MIT licence covers this plugin's code only.

## Development
```sh
PYTHONPATH=src python -m pytest                    # offline: a local stub server stands in for the API
ROWSMITH_LIVE=1 PYTHONPATH=src python -m pytest    # adds the live golden test (one real API call)
```
