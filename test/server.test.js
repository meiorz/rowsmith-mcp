// Offline tests: fetch is replaced, so nothing reaches the live service and no call record is created.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { BASE_URL, createServer, generate, invalidValues, minimalOpenapi, listTypes, resolveOutputPath, SANDBOX_CHECK_FAILED_NOTE, resetSandboxStatus, sandboxAdvertised, sandboxCreate, sandboxPayments, sandboxStatus } from "../server.js";
import { measureTools } from "../scripts/tool-tokens.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const OK_HEADERS = { "x-generator-version": "1", "x-prng": "sfc32-splitmix32", "x-seed": "7" };

function fake(status, body, headers = {}) {
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push({ url, init });
    return new Response(body, { status, headers });
  };
  return seen;
}

test("generate posts the tool arguments unchanged and returns the data plus a provenance line", async () => {
  const seen = fake(200, "id\r\nord_0001\r\n", OK_HEADERS);
  const args = { rows: 1, seed: 7, columns: [{ name: "id", type: "sequence", prefix: "ord_", pad: 4 }] };
  const out = await generate(args);
  assert.equal(seen[0].url, `${BASE_URL}/v1/generate`);
  assert.equal(seen[0].init.method, "POST");
  assert.ok(seen[0].init.signal instanceof AbortSignal, "every call carries a timeout signal");
  assert.deepEqual(JSON.parse(seen[0].init.body), args);
  assert.equal(out.isError, undefined);
  assert.equal(out.content[0].text, "id\r\nord_0001\r\n");
  assert.match(out.content[1].text, /generator 1, sfc32-splitmix32, seed 7/);
});

test("the result carries one Output sha256 line: the service's X-Output-SHA256, else the sha256 of the data", async () => {
  const body = "id\r\nord_0001\r\n";
  const local = createHash("sha256").update(body).digest("hex");
  const args = { rows: 1, seed: 7, columns: [{ name: "id", type: "sequence" }] };
  fake(200, body, { ...OK_HEADERS, "x-output-sha256": local });
  const lines = (await generate(args)).content[1].text.split("\n");
  assert.equal(lines.filter((l) => l.startsWith("Output sha256 ")).length, 1);
  assert.equal(lines[1], `Output sha256 ${local}`);
  assert.ok(lines.at(-1).startsWith("Reproduce: curl "), "the reproduce curl stays last");
  fake(200, body, OK_HEADERS);
  assert.equal((await generate(args)).content[1].text.split("\n")[1], `Output sha256 ${local}`);
  fake(200, body, { ...OK_HEADERS, "x-output-sha256": "f".repeat(64) });
  assert.match((await generate(args)).content[1].text, new RegExp(`^Output sha256 ${"f".repeat(64)}$`, "m"));
});

test("a refusal becomes a tool error with the service's message and Retry-After", async () => {
  fake(429, JSON.stringify({ error: "Daily limit reached." }), { "retry-after": "3600" });
  const out = await generate({ columns: [{ name: "a", type: "uuid" }] });
  assert.equal(out.isError, true);
  assert.match(out.content[0].text, /HTTP 429\): Daily limit reached\. Retry after 3600 s\./);
});

test("a network failure and a timeout become tool errors", async () => {
  globalThis.fetch = async () => {
    throw new Error("offline");
  };
  assert.match((await listTypes()).content[0].text, /Could not reach Rowsmith: offline/);
  globalThis.fetch = async () => {
    throw Object.assign(new Error("aborted"), { name: "TimeoutError" });
  };
  assert.match((await listTypes()).content[0].text, /no response within 30 s/);
});

test("output_path writes the file, returns a summary instead of the data, and never overwrites silently", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rowsmith-mcp-"));
  process.env.ROWSMITH_OUT_DIR = dir;
  try {
    const body = "id,email\r\n1,a.b1@example.com\r\n";
    const seen = fake(200, body, OK_HEADERS);
    const file = join(dir, "out.csv");
    const args = { rows: 1, columns: [{ name: "id", type: "sequence" }], output_path: file };
    const out = await generate(args);
    assert.equal(out.isError, undefined);
    assert.equal(await readFile(file, "utf8"), body);
    assert.ok(!("output_path" in JSON.parse(seen[0].init.body)), "output_path is not sent to the service");
    const text = out.content[0].text;
    assert.ok(!text.includes("a.b1@example.com"), "the data itself is not returned");
    assert.match(text, /Wrote 1 rows \(\d+ bytes\)/);
    assert.match(text, /sha256 [0-9a-f]{64}/);
    assert.equal(text.match(/sha256 [0-9a-f]{64}/g).length, 1, "one sha256 line in the file summary");
    assert.ok(text.includes(`sha256 ${createHash("sha256").update(body).digest("hex")}`));
    assert.match(text, /^id,email$/m);

    const again = await generate(args);
    assert.equal(again.isError, true);
    assert.match(again.content[0].text, /already exists; pass overwrite: true/);

    await writeFile(file, "old");
    assert.equal((await generate({ ...args, overwrite: true })).isError, undefined);
    assert.equal(await readFile(file, "utf8"), body);
  } finally {
    delete process.env.ROWSMITH_OUT_DIR;
    await rm(dir, { recursive: true, force: true });
  }
});

test("output_path stays inside ROWSMITH_OUT_DIR, refusing '..', siblings, the root itself and other drives", () => {
  const root = join(tmpdir(), "allowed");
  assert.ok(resolveOutputPath("../x.csv", root).error);
  assert.ok(resolveOutputPath("a/../../x.csv", root).error);
  assert.ok(resolveOutputPath(join(tmpdir(), "elsewhere", "x.csv"), root).error);
  assert.ok(resolveOutputPath(join(tmpdir(), "allowed-sibling", "x.csv"), root).error, "a sibling sharing the prefix is outside");
  assert.ok(resolveOutputPath(root, root).error, "the directory itself is not a file");
  assert.equal(resolveOutputPath(join(root, "sub", "x.csv"), root).error, undefined);
  if (process.platform === "win32") assert.ok(resolveOutputPath("Z:\\x.csv", "C:\\out").error, "another drive is outside");
});

test("without ROWSMITH_OUT_DIR the write root is the working directory (CTO C5)", () => {
  delete process.env.ROWSMITH_OUT_DIR;
  assert.equal(resolveOutputPath("fixtures/x.csv").error, undefined);
  assert.equal(resolveOutputPath(join(process.cwd(), "x.csv")).error, undefined);
  const outside = resolveOutputPath(process.platform === "win32" ? "C:\\Windows\\Temp\\x.csv" : "/etc/x.csv");
  assert.match(outside.error, /must be inside the working directory \(or ROWSMITH_OUT_DIR when set\)/);
  assert.ok(resolveOutputPath(join(tmpdir(), "x.csv")).error, "an absolute path elsewhere is refused");
});

async function listed(options) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const server = createServer(options);
  await server.connect(serverSide);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientSide);
  const { tools } = await client.listTools();
  await client.close();
  await server.close();
  return tools;
}

test("without the sandbox advertised, a client sees exactly the three non-sandbox tools", async () => {
  const tools = await listed();
  assert.deepEqual(tools.map((t) => t.name).sort(), ["generate_test_data", "invalid_values", "list_column_types"]);
});

test("with the sandbox advertised, a client sees five tools (at most 6)", async () => {
  const tools = await listed({ sandbox: true });
  assert.deepEqual(tools.map((t) => t.name).sort(), ["generate_test_data", "invalid_values", "list_column_types", "sandbox_create", "sandbox_payments"]);
  assert.ok(tools.length <= 6);
});

const pricing = (endpoints) => JSON.stringify({ tiers: [{ name: "free", endpoints }] });

test("startup check, advertised: one GET of /pricing.json, cached for the process; sandbox tools listed", async () => {
  resetSandboxStatus();
  const seen = fake(200, pricing(["POST /v1/generate", "/v1/sandbox"]));
  assert.equal(await sandboxStatus(), "advertised");
  assert.equal(await sandboxAdvertised(), true);
  assert.equal(await sandboxStatus(), "advertised");
  assert.equal(seen.length, 1, "fetched once, then cached");
  assert.equal(seen[0].url, `${BASE_URL}/pricing.json`);
  assert.ok(seen[0].init.signal instanceof AbortSignal, "the check carries a timeout");
  assert.equal((await listed({ sandbox: true })).length, 5);
  resetSandboxStatus();
});

test("startup check, not advertised: sandbox tools hidden, no failure note", async () => {
  resetSandboxStatus();
  fake(200, pricing(["POST /v1/generate", "GET /v1/invalid", "GET /v1/types"]));
  assert.equal(await sandboxStatus(), "not_advertised");
  assert.equal((await listed({ sandbox: false })).length, 3);
  fake(200, '{"types":{}}');
  const out = await createServerTool({ sandboxCheckFailed: false }, "list_column_types");
  assert.ok(!out.content.some((c) => c.text === SANDBOX_CHECK_FAILED_NOTE));
  resetSandboxStatus();
});

test("startup check, fetch failed: sandbox tools hidden (fail closed) and the server says why", async () => {
  for (const failure of [
    () => fake(500, "oops"),
    () => fake(200, "not json"),
    () => {
      globalThis.fetch = async () => {
        throw Object.assign(new Error("aborted"), { name: "TimeoutError" });
      };
    },
  ]) {
    resetSandboxStatus();
    failure();
    assert.equal(await sandboxStatus(), "failed");
    assert.equal(await sandboxAdvertised(), false);
  }
  resetSandboxStatus();
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const server = createServer({ sandbox: false, sandboxCheckFailed: true });
  await server.connect(serverSide);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientSide);
  assert.equal(client.getInstructions(), SANDBOX_CHECK_FAILED_NOTE);
  const { tools } = await client.listTools();
  assert.equal(tools.length, 3);
  fake(200, '{"types":{}}');
  const out = await client.callTool({ name: "list_column_types", arguments: {} });
  assert.equal(out.content.at(-1).text, SANDBOX_CHECK_FAILED_NOTE);
  await client.close();
  await server.close();
});

async function createServerTool(options, name) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const server = createServer(options);
  await server.connect(serverSide);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientSide);
  const out = await client.callTool({ name, arguments: {} });
  await client.close();
  await server.close();
  return out;
}

test("generate_test_data keeps its schema, with columns or schema (neither required by the tool; the service refuses both or neither)", async () => {
  const tools = await listed();
  const gen = tools.find((t) => t.name === "generate_test_data");
  assert.equal(gen.inputSchema.required, undefined);
  for (const k of ["columns", "schema", "rows", "seed", "format", "table", "output_path", "overwrite", "chaos"]) assert.ok(k in gen.inputSchema.properties, k);
  assert.equal(gen.inputSchema.properties.schema.type, "object");
});

test("a schema is sent without example, examples, default, const or x-* keys; property and schema names are kept", async () => {
  const seen = fake(200, "id\r\n1\r\n", { ...OK_HEADERS, "x-schema-version": "1", "x-schema-unmapped": "tags,address.zip" });
  const schema = {
    type: "object",
    examples: [{ email: "jane.realperson@mail.example" }],
    "x-internal": "Janet Realperson",
    properties: {
      email: { type: "string", format: "email", example: "jane.realperson@mail.example", default: "jane@mail.example" },
      default: { type: "string", const: "fixed" },
      example: { $ref: "#/$defs/Example" },
      "x-trace": { type: "string", "x-faker": "name.fullName" },
      tags: { type: "array", items: { type: "string", examples: ["vip"] } },
    },
    $defs: { Example: { type: "boolean", default: true }, examples: { type: "integer" } },
  };
  const before = JSON.stringify(schema);
  const out = await generate({ rows: 1, seed: 7, schema });
  assert.equal(JSON.stringify(schema), before, "the caller's object is not changed");
  const sent = JSON.parse(seen[0].init.body);
  assert.deepEqual(sent, {
    rows: 1,
    seed: 7,
    schema: {
      type: "object",
      properties: {
        email: { type: "string", format: "email" },
        default: { type: "string" },
        example: { $ref: "#/$defs/Example" },
        "x-trace": { type: "string" },
        tags: { type: "array", items: { type: "string" } },
      },
      $defs: { Example: { type: "boolean" }, examples: { type: "integer" } },
    },
  });
  const text = out.content.map((c) => c.text).join("\n");
  assert.doesNotMatch(text, /realperson|Realperson|vip|fixed|faker/);
  assert.match(text, /Schema mapping 1; left out \(not mappable\): tags,address\.zip\.\n/);
  const curl = text.split("\n").at(-1);
  assert.ok(curl.startsWith("Reproduce: curl "), curl);
  assert.deepEqual(JSON.parse(curl.slice(curl.indexOf("-d '") + 4, -1)).schema, sent.schema);
});

test("the schema argument passes through the MCP client unchanged apart from the removed keys", async () => {
  const seen = fake(200, "a\r\ntrue\r\n", { ...OK_HEADERS, "x-schema-version": "1" });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const server = createServer();
  await server.connect(serverSide);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientSide);
  const schema = { type: "object", properties: { a: { type: "boolean", default: false } }, required: ["a"] };
  const out = await client.callTool({ name: "generate_test_data", arguments: { rows: 1, schema } });
  await client.close();
  await server.close();
  assert.equal(out.isError, undefined);
  assert.deepEqual(JSON.parse(seen[0].init.body), { rows: 1, schema: { type: "object", properties: { a: { type: "boolean" } }, required: ["a"] } });
  assert.match(out.content.at(-1).text, /Schema mapping 1; every property mapped\./);
});

// src/agentdocs.ts and the root README live in the private monorepo; the public repo (a copy of mcp/) has neither.
const AGENTDOCS = new URL("../../src/agentdocs.ts", import.meta.url);
const inMonorepo = existsSync(AGENTDOCS);
test("the published tool-definition sizes match the measurement (characters / 4), for 3 and 5 tools", { skip: inMonorepo ? false : "needs ../../src/agentdocs.ts, which exists only in the private monorepo" }, async () => {
  const docs = await readFile(AGENTDOCS, "utf8");
  for (const [sandbox, suffix, tools] of [[false, "", 3], [true, "_WITH_SANDBOX", 5]]) {
    const m = await measureTools({ sandbox });
    assert.equal(m.tools, tools);
    assert.ok(docs.includes(`MCP_TOOL_CHARS${suffix} = ${m.chars};`), `src/agentdocs.ts must state ${m.chars} characters`);
    assert.ok(docs.includes(`MCP_TOOL_TOKENS${suffix} = ${m.tokens};`), `src/agentdocs.ts must state ${m.tokens} tokens`);
    for (const f of ["../README.md", "../../README.md"]) {
      const text = (await readFile(new URL(f, import.meta.url), "utf8")).replace(/\s+/g, " ");
      assert.ok(text.includes(`about ${m.tokens} tokens`), `${f} must state about ${m.tokens} tokens`);
      assert.ok(text.includes(`${m.chars} characters`), `${f} must state ${m.chars} characters`);
    }
  }
});

test("server.json and the package description describe only what is live with the flags off", async () => {
  for (const f of ["../server.json", "../package.json"]) {
    const text = await readFile(new URL(f, import.meta.url), "utf8");
    assert.doesNotMatch(text, /sandbox|payment|charge|refund/i, f);
    assert.match(text, /"version": "0\.5\.\d+"/, f);
  }
  // The registry entry names a published npm version; server.json follows package.json.
  const server = JSON.parse(await readFile(new URL("../server.json", import.meta.url), "utf8"));
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(server.version, pkg.version);
  assert.equal(server.packages[0].version, pkg.version);
  assert.equal(server.repository?.url, "https://github.com/meiorz/rowsmith-mcp");
  // A start script lets directories (Glama) start the server from a checkout.
  assert.equal(pkg.scripts.start, "node index.js");
});

test("server.js states the package version as a constant (read here as text; server.js reads no file for it)", async () => {
  const src = await readFile(new URL("../server.js", import.meta.url), "utf8");
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const m = /^const VERSION = "([^"]+)";$/m.exec(src);
  assert.ok(m, "server.js must declare const VERSION = \"<version>\";");
  assert.equal(m[1], pkg.version);
  assert.doesNotMatch(src, /package\.json/, "the version is not read from package.json at run time");
});

test("tool descriptions use process wording only and no processor naming", async () => {
  const text = JSON.stringify(await listed({ sandbox: true }));
  assert.doesNotMatch(text, /\b(safe|anonymous|AI)\b/);
  assert.equal(text.replace(/Stripe's published testing list/g, "").includes("Stripe"), false);
});

test("chaos options become query parameters, never body fields; the tool name is sent for counting", async () => {
  const seen = fake(200, "id\r\n1\r\n", OK_HEADERS);
  const args = { rows: 1, columns: [{ name: "id", type: "sequence" }] };
  await generate({ ...args, chaos: { fail: "429@0.2", latency_ms: 100, empty_result: true, attempt: 3 } });
  assert.equal(seen[0].url, `${BASE_URL}/v1/generate?fail=429%400.2&latency=100&empty_result=1&attempt=3`);
  assert.deepEqual(JSON.parse(seen[0].init.body), args);
  assert.equal(seen[0].init.headers["x-rowsmith-tool"], "generate_test_data");
});

test("invalid_values passes kind, count, seed and fields", async () => {
  const seen = fake(200, '{"items":[]}');
  await invalidValues({ kind: "email", count: 3, seed: 9, fields: "value,reason" });
  assert.equal(seen[0].url, `${BASE_URL}/v1/invalid?kind=email&count=3&seed=9&fields=value%2Creason`);
});

test("sandbox tools route each action, and say plainly when the sandbox is not open", async () => {
  const id = "sbx_" + "a".repeat(32);
  let seen = fake(201, '{"id":"ch_test_x"}');
  await sandboxPayments({ sandbox_id: id, action: "charge", amount: 100, card: "4242424242424242" });
  assert.equal(seen[0].url, `${BASE_URL}/v1/sandbox/${id}/charges`);
  assert.deepEqual(JSON.parse(seen[0].init.body), { amount: 100, card: "4242424242424242" });
  seen = fake(200, "{}");
  await sandboxPayments({ sandbox_id: id, action: "list", limit: 5, fields: "id,status" });
  assert.equal(seen[0].url, `${BASE_URL}/v1/sandbox/${id}/charges?fields=id%2Cstatus&limit=5`);
  assert.equal((await sandboxPayments({ sandbox_id: id, action: "refund" })).isError, true);
  fake(404, JSON.stringify({ error: "Not found." }));
  assert.match((await sandboxCreate({})).content[0].text, /not open/);
  fake(404, JSON.stringify({ error: "No such sandbox.", next: "Create one." }), { "x-rowsmith-sandbox": "test" });
  assert.match((await sandboxPayments({ sandbox_id: id, action: "list" })).content[0].text, /No such sandbox\. Next: Create one\./);
});

test("for an OpenAPI component, only the component and the schemas it references are sent (shared fixture)", async () => {
  const fixture = JSON.parse(await readFile(new URL("../pytest-rowsmith/tests/fixtures/openapi_closure.json", import.meta.url), "utf8"));
  const seen = fake(200, "id\r\n1\r\n", { ...OK_HEADERS, "x-schema-version": "1" });
  const out = await generate({ rows: 2, schema: fixture.input });
  const body = seen[0].init.body;
  assert.equal(JSON.stringify(JSON.parse(body).schema), JSON.stringify(fixture.expected));
  for (const gone of ["paths", "servers", "security", "info", "Unused", "Secret", "realperson"]) assert.ok(!body.includes(gone), gone);
  assert.ok(!out.content.map((c) => c.text).join("\n").includes("realperson"));
});

test("the OpenAPI closure ends on $ref cycles", () => {
  const schemas = {};
  for (let i = 0; i < 200; i++) schemas[`S${i}`] = { type: "object", properties: { next: { $ref: `#/components/schemas/S${(i + 1) % 200}` }, self: { $ref: `#/components/schemas/S${i}` } } };
  const r = minimalOpenapi({ openapi: { openapi: "3.1.0", paths: { "/x": {} }, components: { schemas } }, component: "S5" });
  assert.equal(Object.keys(r.openapi.components.schemas).length, 200);
  assert.deepEqual(Object.keys(r.openapi), ["openapi", "components"]);
});

test("the package test run covers test/*.test.js only, so no example (which calls the live API) runs in the check", async () => {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(pkg.scripts.test, "node --test test/*.test.js");
  const { readdir } = await import("node:fs/promises");
  const examples = (await readdir(new URL("../examples/", import.meta.url), { recursive: true })).map((f) => "examples/" + String(f).split("\\").join("/"));
  assert.ok(examples.some((f) => f.endsWith(".test.mjs")), "the live example still exists, run by hand");
  for (const f of examples) assert.ok(!f.startsWith("test/"), f + " would be matched by the test script");
});

test("tables calls /v1/dataset with the arguments as sent (schemas cleaned), and the result carries the per-table row hashes", async () => {
  const headers = { ...OK_HEADERS, "x-dataset-version": "1", "x-dataset-rows-sha256": `a=${"1".repeat(64)},b=${"2".repeat(64)}`, "x-output-sha256": "e".repeat(64) };
  const seen = fake(200, 'CREATE TABLE "a" (\n  "id" TEXT NOT NULL,\n  PRIMARY KEY ("id")\n);\n', headers);
  const tables = [
    { name: "a", rows: 2, columns: [{ name: "id", type: "uuid" }] },
    { name: "b", rows: 3, schema: { type: "object", properties: { n: { type: "string", examples: ["planted"] } } } },
  ];
  const out = await generate({ seed: 7, format: "sql", tables, chaos: { attempt: 2 } });
  assert.equal(seen[0].url, `${BASE_URL}/v1/dataset?attempt=2`);
  assert.equal(seen[0].init.headers["x-rowsmith-tool"], "generate_test_data");
  const sent = JSON.parse(seen[0].init.body);
  assert.deepEqual(sent, { seed: 7, format: "sql", tables: [tables[0], { name: "b", rows: 3, schema: { type: "object", properties: { n: { type: "string" } } } }] });
  assert.ok(!seen[0].init.body.includes("planted"));
  const text = out.content[1].text;
  assert.match(text, new RegExp(`^Rows sha256 per table: a=${"1".repeat(64)},b=${"2".repeat(64)}$`, "m"));
  const curl = text.split("\n").at(-1);
  assert.ok(curl.startsWith(`Reproduce: curl -s ${BASE_URL}/v1/dataset `), curl);
  const body = JSON.parse(curl.slice(curl.indexOf("-d '") + 4, -1));
  assert.equal(body.version, "1");
  assert.equal(body.dataset_version, "1");
  assert.equal(body.tables.length, 2);
});

test("tables with output_path writes the dump and names the tables and their total rows", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rowsmith-mcp-"));
  process.env.ROWSMITH_OUT_DIR = dir;
  try {
    fake(200, '{"tables":{"a":[],"b":[]}}', { ...OK_HEADERS, "x-dataset-version": "1" });
    const out = await generate({ format: "json", tables: [{ name: "a", rows: 4, columns: [] }, { name: "b", columns: [] }], output_path: join(dir, "d.json") });
    assert.equal(out.isError, undefined);
    assert.match(out.content[0].text, /^Wrote 14 rows \(\d+ bytes\) to /);
    assert.match(out.content[0].text, /^tables: a, b$/m);
    assert.equal(await readFile(join(dir, "d.json"), "utf8"), '{"tables":{"a":[],"b":[]}}');
  } finally {
    delete process.env.ROWSMITH_OUT_DIR;
    await rm(dir, { recursive: true, force: true });
  }
});

test("the tables argument passes through the MCP client (schema accepts it; at most 10 tables)", async () => {
  const seen = fake(200, "x", { ...OK_HEADERS, "x-dataset-version": "1" });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const server = createServer();
  await server.connect(serverSide);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientSide);
  const tables = [{ name: "a", rows: 1, columns: [{ name: "id", type: "uuid" }] }, { name: "b", rows: 1, columns: [{ name: "a_id", type: "ref", table: "a", column: "id" }] }];
  const out = await client.callTool({ name: "generate_test_data", arguments: { seed: 1, tables } });
  const tooMany = await client.callTool({ name: "generate_test_data", arguments: { tables: Array.from({ length: 11 }, (_, i) => ({ name: `t${i}` })) } });
  await client.close();
  await server.close();
  assert.equal(out.isError, undefined);
  assert.deepEqual(JSON.parse(seen[0].init.body), { seed: 1, tables });
  assert.equal(seen.length, 1);
  assert.equal(tooMany.isError, true);
});
