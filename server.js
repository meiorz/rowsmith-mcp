// Rowsmith MCP server (stdio). A thin client of the public Rowsmith HTTP API: it holds no keys and sends only what
// the tool call contains. It writes a file only when the caller asks for one with output_path.
// Terms: https://testdata-api.re-jam620.workers.dev/terms
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export const BASE_URL = (process.env.ROWSMITH_URL ?? "https://testdata-api.re-jam620.workers.dev").replace(/\/+$/, "");
const VERSION = "0.2.0";
const TIMEOUT_MS = 30_000;

const TYPES =
  "uuid, sequence (start, step, prefix, pad), integer (min, max), decimal (min, max, scale), boolean (p_true), " +
  "enum (values, weights), date (from, to: YYYY-MM-DD), datetime (from, to), first_name, last_name, full_name, " +
  "email, phone, test_card, ssn_invalid, iban_invalid, text (min_words, max_words). Every column also takes null_rate.";

const column = z
  .object({ name: z.string().describe("Column name: lowercase letters, digits and _"), type: z.string().describe(`One of: ${TYPES}`) })
  .passthrough();

export const generateInput = {
  columns: z.array(column).min(1).max(50).describe("The table's columns, 1 to 50"),
  rows: z.number().int().min(1).max(500).optional().describe("Number of rows, 1 to 500 (default 100)"),
  seed: z.number().int().min(0).max(4294967295).optional().describe("Seed; the same schema and seed give identical output for the same generator version (default 1)"),
  format: z.enum(["csv", "json", "sql"]).optional().describe("Output format (default csv)"),
  table: z.string().optional().describe("Table name, used in SQL output (default data)"),
  output_path: z
    .string()
    .optional()
    .describe("Write the data to this file instead of returning it (use for more than about 50 rows). Must be inside the working directory, or inside ROWSMITH_OUT_DIR when set; no '..' segments"),
  overwrite: z.boolean().optional().describe("Replace output_path if it already exists (default false)"),
  chaos: chaosSchema(),
};

async function call(path, init) {
  let res;
  try {
    res = await fetch(`${BASE_URL}${path}`, {
      ...init,
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { "user-agent": `rowsmith-mcp/${VERSION}`, ...(init?.headers ?? {}) },
    });
  } catch (e) {
    const why = e instanceof Error && e.name === "TimeoutError" ? `no response within ${TIMEOUT_MS / 1000} s` : e instanceof Error ? e.message : String(e);
    return { ok: false, text: `Could not reach Rowsmith: ${why}` };
  }
  const text = await res.text();
  if (res.ok) return { ok: true, text, headers: res.headers };
  let message = text;
  let next = "";
  let parsed;
  try {
    parsed = JSON.parse(text);
    message = parsed.error ?? text;
    if (typeof parsed.next === "string") next = ` Next: ${parsed.next}`;
  } catch {}
  const retry = res.headers.get("retry-after");
  return {
    ok: false,
    status: res.status,
    body: parsed,
    headers: res.headers,
    text: `Rowsmith refused the request (HTTP ${res.status}): ${message}${retry ? ` Retry after ${retry} s.` : ""}${next}`,
  };
}

// Chaos parameters, shared by every tool that calls a data endpoint. They make the service misbehave on purpose;
// outcomes are fixed by seed and attempt.
export function chaosSchema() {
  return z
  .object({
    fail: z.string().regex(/^(429|500|503)@(0(\.\d{1,6})?|1(\.0{1,6})?)$/).optional().describe("Inject failures, e.g. 429@0.2"),
    latency_ms: z.number().int().min(0).max(3000).optional(),
    empty_result: z.boolean().optional(),
    attempt: z.number().int().min(1).max(100000).optional().describe("Roll counter; increment on retry"),
  })
  .optional()
  .describe("Deliberate misbehaviour for testing error handling");
}

export function chaosQuery(chaos) {
  const q = new URLSearchParams();
  if (!chaos) return q;
  if (chaos.fail) q.set("fail", chaos.fail);
  if (chaos.latency_ms !== undefined) q.set("latency", String(chaos.latency_ms));
  if (chaos.empty_result) q.set("empty_result", "1");
  if (chaos.attempt !== undefined) q.set("attempt", String(chaos.attempt));
  return q;
}

const withQuery = (path, q) => (q.toString() ? `${path}?${q}` : path);
const tool = (name) => ({ "x-rowsmith-tool": name });

const fail = (text) => ({ isError: true, content: [{ type: "text", text }] });

// Resolves output_path inside the write root: ROWSMITH_OUT_DIR when set, otherwise the working directory. Refuses
// ".." segments and anything that resolves outside the root, relative or absolute (CTO C1, C5).
export function resolveOutputPath(p, root = process.env.ROWSMITH_OUT_DIR || process.cwd()) {
  const outside = "output_path must be inside the working directory (or ROWSMITH_OUT_DIR when set).";
  if (p.split(/[\\/]/).includes("..")) return { error: "output_path must not contain '..' segments." };
  const full = resolve(p);
  const rel = relative(resolve(root), full);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return { error: outside };
  return { path: full };
}

function headerLine(body, format) {
  if (format === "json") {
    try {
      const first = JSON.parse(body)[0];
      return first ? `columns: ${Object.keys(first).join(", ")}` : "no rows";
    } catch {
      return "";
    }
  }
  return body.split(/\r?\n/, 1)[0] ?? "";
}

export async function generate(args) {
  const { output_path, overwrite, chaos, ...request } = args;
  let target;
  if (output_path !== undefined) {
    const r = resolveOutputPath(output_path);
    if (r.error) return fail(r.error);
    target = r.path;
  }
  const r = await call(withQuery("/v1/generate", chaosQuery(chaos)), {
    method: "POST",
    headers: { "content-type": "application/json", ...tool("generate_test_data") },
    body: JSON.stringify(request),
  });
  if (!r.ok) return fail(r.text);
  const provenance =
    `(generator ${r.headers.get("x-generator-version")}, ${r.headers.get("x-prng")}, seed ${r.headers.get("x-seed")}; ` +
    `generated fake data, see ${BASE_URL}/terms)`;
  if (target === undefined) return { content: [{ type: "text", text: r.text }, { type: "text", text: provenance }] };

  try {
    // "wx" refuses an existing file, so nothing is ever overwritten silently.
    await writeFile(target, r.text, { encoding: "utf8", flag: overwrite ? "w" : "wx" });
  } catch (e) {
    if (e && e.code === "EEXIST") return fail(`${target} already exists; pass overwrite: true to replace it.`);
    return fail(`Could not write ${target}: ${e instanceof Error ? e.message : String(e)}`);
  }
  const bytes = Buffer.byteLength(r.text, "utf8");
  const sha256 = createHash("sha256").update(r.text, "utf8").digest("hex");
  const summary = [
    `Wrote ${request.rows ?? 100} rows (${bytes} bytes) to ${target}`,
    `sha256 ${sha256}`,
    headerLine(r.text, request.format ?? "csv"),
    provenance,
  ].join("\n");
  return { content: [{ type: "text", text: summary }] };
}

export async function listTypes() {
  const r = await call("/v1/types", { method: "GET", headers: tool("list_column_types") });
  return r.ok ? { content: [{ type: "text", text: r.text }] } : fail(r.text);
}

const KINDS = ["email", "card", "address", "unicode", "iban", "ssn", "all"];
const fieldsInput = z.string().regex(/^[a-z_,]{1,200}$/).optional().describe("Comma-separated fields to keep, e.g. value,reason");

export const invalidInput = {
  kind: z.enum(KINDS).optional().describe("Default all"),
  count: z.number().int().min(1).max(100).optional().describe("Default 10"),
  seed: z.number().int().min(0).max(4294967295).optional(),
  fields: fieldsInput,
  chaos: chaosSchema(),
};

export async function invalidValues(args) {
  const q = chaosQuery(args.chaos);
  for (const k of ["kind", "count", "seed", "fields"]) if (args[k] !== undefined) q.set(k, String(args[k]));
  const r = await call(withQuery("/v1/invalid", q), { method: "GET", headers: tool("invalid_values") });
  return r.ok ? { content: [{ type: "text", text: r.text }] } : fail(r.text);
}

const SANDBOX_CLOSED = "The payment sandbox is not open on this Rowsmith server yet (HTTP 404).";

export const sandboxCreateInput = { seed: z.number().int().min(0).max(4294967295).optional() };

export async function sandboxCreate(args) {
  const r = await call("/v1/sandbox", {
    method: "POST",
    headers: { "content-type": "application/json", ...tool("sandbox_create") },
    body: JSON.stringify(args.seed === undefined ? {} : { seed: args.seed }),
  });
  if (r.ok) return { content: [{ type: "text", text: r.text }] };
  return fail(r.status === 404 ? SANDBOX_CLOSED : r.text);
}

export const sandboxInput = {
  sandbox_id: z.string().regex(/^sbx_[0-9a-f]{32}$/),
  action: z.enum(["charge", "refund", "list", "get", "reset"]),
  amount: z.number().int().min(1).max(99999999).optional().describe("Minor units; charge, or partial refund"),
  currency: z.enum(["usd", "eur", "gbp", "jpy", "cad", "aud"]).optional(),
  card: z.string().optional().describe("Charge: a card number from Stripe's published testing list, e.g. 4242424242424242; decline numbers: invalid_values kind card"),
  charge: z.string().optional().describe("Charge id, for refund and get"),
  reference: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/).optional(),
  limit: z.number().int().min(1).max(100).optional(),
  fields: fieldsInput,
  chaos: chaosSchema(),
};

export async function sandboxPayments(args) {
  const { sandbox_id: id, action, chaos, fields, limit, charge, amount, currency, card, reference } = args;
  const q = chaosQuery(chaos);
  if (fields !== undefined) q.set("fields", fields);
  if (limit !== undefined) q.set("limit", String(limit));
  const pick = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
  const base = `/v1/sandbox/${id}`;
  const post = (path, body) => ({
    path, init: { method: "POST", headers: { "content-type": "application/json", ...tool("sandbox_payments") }, body: JSON.stringify(body) },
  });
  const get = (path) => ({ path, init: { method: "GET", headers: tool("sandbox_payments") } });
  if ((action === "refund" || action === "get") && !charge) return fail(`${action} needs charge (a ch_test_ id).`);
  if (action === "charge" && (amount === undefined || !card)) return fail("charge needs amount and card.");
  const { path, init } =
    action === "charge" ? post(`${base}/charges`, pick({ amount, currency, card, reference }))
      : action === "refund" ? post(`${base}/refunds`, pick({ charge, amount, reference }))
      : action === "reset" ? post(`${base}/reset`, {})
      : action === "get" ? get(`${base}/charges/${encodeURIComponent(charge)}`)
      : get(`${base}/charges`);
  const r = await call(withQuery(path, q), init);
  if (r.ok) return { content: [{ type: "text", text: r.text }] };
  // A 404 without the sandbox header means the server has no sandbox at all.
  if (r.status === 404 && r.headers?.get("x-rowsmith-sandbox") !== "test") return fail(SANDBOX_CLOSED);
  return fail(r.text);
}

const ADVERTISE_TIMEOUT_MS = 30_000;

export const SANDBOX_CHECK_FAILED_NOTE =
  "Note: the payment sandbox tools are hidden because rowsmith-mcp could not read /pricing.json at startup; restart the server to check again.";

async function probeSandbox(timeoutMs) {
  try {
    const res = await fetch(`${BASE_URL}/pricing.json`, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { "user-agent": `rowsmith-mcp/${VERSION}` },
    });
    if (!res.ok) return "failed";
    const p = await res.json();
    const listed = (p?.tiers ?? []).some(
      (t) => Array.isArray(t?.endpoints) && t.endpoints.some((e) => typeof e === "string" && e.includes("/v1/sandbox")),
    );
    return listed ? "advertised" : "not_advertised";
  } catch {
    return "failed";
  }
}

// Whether the service advertises the payment sandbox: one GET of /pricing.json (30 s timeout), cached for the life
// of the process. "advertised" when a tier lists /v1/sandbox; "not_advertised" when it does not; "failed" on any
// network, timeout, HTTP or JSON error. Only "advertised" registers the sandbox tools (fail closed).
let sandboxCheck;
export function sandboxStatus(timeoutMs = ADVERTISE_TIMEOUT_MS) {
  sandboxCheck ??= probeSandbox(timeoutMs);
  return sandboxCheck;
}
/** Test hook: forgets the cached startup check. */
export function resetSandboxStatus() {
  sandboxCheck = undefined;
}
export async function sandboxAdvertised() {
  return (await sandboxStatus()) === "advertised";
}

/**
 * The server. Sandbox tools are registered only with { sandbox: true }; with { sandboxCheckFailed: true } the
 * instructions and list_column_types' output say why they are hidden.
 */
export function createServer({ sandbox = false, sandboxCheckFailed = false } = {}) {
  const server = new McpServer(
    { name: "rowsmith", version: VERSION },
    sandboxCheckFailed ? { instructions: SANDBOX_CHECK_FAILED_NOTE } : {},
  );
  const listTypesTool = sandboxCheckFailed
    ? async () => {
        const r = await listTypes();
        return { ...r, content: [...r.content, { type: "text", text: SANDBOX_CHECK_FAILED_NOTE }] };
      }
    : listTypes;
  server.registerTool(
    "generate_test_data",
    {
      title: "Generate test data",
      description:
        "Generate realistic fake test data (CSV, JSON or SQL INSERTs) from a table schema. Free and rate-limited: up to " +
        "500 rows and 50 columns per call. No real person's data is used as input and no record is derived from a real " +
        "person; emails, phones, card numbers, SSN-shaped and IBAN-shaped values come only from reserved or invalid " +
        "ranges. The same schema and seed give byte-identical output for the same generator version (sent as " +
        "x-generator-version). For more than about 50 rows, pass output_path to write a file instead of returning the " +
        "data. Send schemas only, never real data.",
      inputSchema: generateInput,
    },
    generate,
  );
  server.registerTool(
    "list_column_types",
    { title: "List column types", description: "List the supported column types and the options each accepts.", inputSchema: {} },
    listTypesTool,
  );
  server.registerTool(
    "invalid_values",
    {
      title: "Invalid test values",
      description:
        "Deliberately invalid TEST DATA values (malformed emails, declining or Luhn-invalid card numbers, malformed " +
        "addresses, Unicode edge cases, invalid IBAN and SSN shapes), each with the reason it is invalid. Same seed, " +
        "same output for the same catalogue version.",
      inputSchema: invalidInput,
    },
    invalidValues,
  );
  if (!sandbox) return server;
  server.registerTool(
    "sandbox_create",
    {
      title: "Create payment sandbox",
      description:
        "Create a fake card-processor sandbox (TEST DATA, no money, no payment provider). Returns its sbx_ id. " +
        "Deleted 1 hour after creation.",
      inputSchema: sandboxCreateInput,
    },
    sandboxCreate,
  );
  server.registerTool(
    "sandbox_payments",
    {
      title: "Use payment sandbox",
      description:
        "Charge, refund, list, get or reset in a payment sandbox. Accepts only card numbers from Stripe's published " +
        "testing list; any other card-like number is refused. Declines return code and decline_code. Same seed and " +
        "call order, same objects for the same sandbox version.",
      inputSchema: sandboxInput,
    },
    sandboxPayments,
  );
  return server;
}
