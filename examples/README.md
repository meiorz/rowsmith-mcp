# Examples

Each example calls the free Rowsmith API (no account, no key) and generates fake test data only. Send schemas,
never real data.

| Folder | What it shows |
|---|---|
| `quickstart-schema.json` | the schema used by the quickstart and the fixtures smoke workflow |
| `pytest/` | a session fixture that loads reproducible orders, cached on disk by request |
| `node/` | `node --test` with built-in `fetch`: the same request twice gives the same data |
| `postgres/` | seed a local table from `format: sql` INSERTs |
| `payment-sandbox/` | a checkout test: one charge that succeeds (201), one that is declined (422) |
| `github-actions/` | the fixtures Action writing a file before `npm test` |

Pin `"version"` in the request to keep the bytes fixed when the generator changes. A pinned version is served as long as the service runs; a retired version answers 409. A version's output is not changed in place: a golden test checks its bytes on every build.

Pin the fixtures Action to a release tag (`meiorz/rowsmith-mcp/fixtures@v0.2.3`), not `@main`, so later changes to
the Action reach your workflow only when you move the pin.

Set a User-Agent header on your requests. Python's standard-library urllib is blocked by Cloudflare before it reaches
the API (403, error code 1010) when it sends its default User-Agent; the pytest example sets its own.
