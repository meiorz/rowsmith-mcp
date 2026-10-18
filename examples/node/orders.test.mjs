// node --test examples/node/orders.test.mjs  (Node 18+, no dependencies)
import { test } from 'node:test';
import assert from 'node:assert/strict';

const API = 'https://testdata-api.re-jam620.workers.dev/v1/generate';

async function generate(request) {
  const res = await fetch(API, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
  });
  if (!res.ok) throw new Error(`Rowsmith ${res.status}: ${(await res.json()).next ?? ''}`);
  return res.json();
}

test('orders fixture is reproducible', async () => {
  const request = {
    rows: 10, seed: 42, format: 'json', version: '1',
    columns: [
      { name: 'order_id', type: 'sequence', prefix: 'ord_', pad: 4 },
      { name: 'email', type: 'email' },
    ],
  };
  const a = await generate(request);
  const b = await generate(request);
  assert.deepEqual(a, b);
});
