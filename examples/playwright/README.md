# Playwright with Rowsmith test data

A copy-paste example: a `rowsmith` fixture for Playwright that gives each test fake rows from a schema. Answers are
cached by the request's sha256 under `node_modules/.cache/rowsmith`, so later runs work offline, and a failing test
shows the curl command that reproduces each answer it used.

- `rowsmith.fixture.ts`: the fixture. Copy it into your tests; it needs only `@playwright/test` (Node 20 or later).
- `form.spec.ts`: fills a signup form with generated customers (needs a browser:
  `npx playwright install chromium`, then `ROWSMITH_PW_BROWSER=1 npx playwright test`).
- `data.spec.ts`: checks the golden request's rows by their sha256, with no browser.

```sh
npm ci
npx playwright install chromium
ROWSMITH_PW_BROWSER=1 npx playwright test
```

The service is free and rate-limited: send schemas only, never real data. Every identifier comes from reserved or
invalid ranges (emails on example.com, example.net, example.org and mail.test). The same schema and seed give
byte-identical output for the same generator version; the fixture pins `"version": "1"`.

The repository's `playwright-smoke` workflow runs `data.spec.ts` against `stub-server.mjs`, a local stand-in that
serves the Worker's recorded answer (`fixtures/golden-json.json`), so CI makes no call to the service.
