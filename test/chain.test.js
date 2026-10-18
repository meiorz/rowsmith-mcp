// Offline tests for the reproduce line (cycle 3, C1) and the tool chain in the descriptions (C2).
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { BASE_URL, createServer, generate, reproduceCurl } from "../server.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const HEADERS = { "x-generator-version": "1", "x-prng": "sfc32-splitmix32", "x-seed": "1" };
function fake(body, headers = HEADERS) {
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push({ url, init });
    return new Response(body, { status: 200, headers });
  };
  return seen;
}

// The JSON a POSIX shell passes to curl for -d '<json>' after undoing the '\'' escapes.
function bodyOf(curl) {
  const m = /-d '((?:[^']|'\\'')*)'$/.exec(curl);
  assert.ok(m, curl);
  return JSON.parse(m[1].replace(/'\\''/g, "'"));
}

test("the inline result ends with the curl that regenerates the same bytes: seed filled in, version pinned", async () => {
  fake("id\r\n1\r\n");
  const args = { rows: 2, columns: [{ name: "id", type: "sequence" }] };
  const out = await generate(args);
  const last = out.content.at(-1).text.split("\n").at(-1);
  assert.ok(last.startsWith(`Reproduce: curl -s ${BASE_URL}/v1/generate -H 'content-type: application/json' -d '`), last);
  assert.deepEqual(bodyOf(last), { ...args, seed: 1, version: "1" });
});

test("the file summary ends with the same curl, and chaos and file options are left out", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rowsmith-chain-"));
  process.env.ROWSMITH_OUT_DIR = dir;
  try {
    fake("id\r\n1\r\n", { ...HEADERS, "x-seed": "42" });
    const out = await generate({ rows: 1, seed: 42, columns: [{ name: "id", type: "uuid" }], output_path: join(dir, "x.csv"), chaos: { latency_ms: 10 } });
    const last = out.content[0].text.split("\n").at(-1);
    assert.deepEqual(bodyOf(last), { rows: 1, seed: 42, columns: [{ name: "id", type: "uuid" }], version: "1" });
  } finally {
    delete process.env.ROWSMITH_OUT_DIR;
    await rm(dir, { recursive: true, force: true });
  }
});

test("single quotes in values survive the shell quoting", () => {
  const line = reproduceCurl({ columns: [{ name: "v", type: "enum", values: ["it's"] }] }, new Headers(HEADERS));
  assert.deepEqual(bodyOf(line).columns[0].values, ["it's"]);
});

test("empty_result has no reproduce curl, and says why", async () => {
  fake("id\r\n");
  const out = await generate({ columns: [{ name: "id", type: "uuid" }], chaos: { empty_result: true } });
  assert.match(out.content.at(-1).text, /Reproduce: not available, because empty_result was requested\./);
});

async function descriptions(options) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const server = createServer(options);
  await server.connect(serverSide);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientSide);
  const { tools } = await client.listTools();
  await client.close();
  await server.close();
  return Object.fromEntries(tools.map((t) => [t.name, t.description]));
}

test("descriptions chain the tools: generate, then invalid_values, then the sandbox tools only when listed", async () => {
  const three = await descriptions();
  assert.match(three.generate_test_data, /Use it first/);
  assert.match(three.generate_test_data, /Next: invalid_values/);
  assert.doesNotMatch(three.generate_test_data, /sandbox/);
  assert.match(three.list_column_types, /Use it before generate_test_data/);
  assert.match(three.invalid_values, /Use it after generate_test_data/);
  assert.doesNotMatch(three.invalid_values, /sandbox_create/);
  const five = await descriptions({ sandbox: true });
  assert.match(five.generate_test_data, /then sandbox_create and sandbox_payments/);
  assert.match(five.invalid_values, /Next: sandbox_create, then sandbox_payments/);
  assert.match(five.sandbox_create, /next, call sandbox_payments with the returned id/);
  assert.match(five.sandbox_payments, /Use it after sandbox_create/);
});
