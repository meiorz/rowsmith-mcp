// adoption-check: fetches each page listed in adopted.json from the service, hashes the exact body bytes (sha256) and
// compares them with the recorded hash. One line per path; exit 0 only if every path is OK, exit 1 otherwise.
//
//   node adoption-check.mjs [base-url]        (or ADOPTION_CHECK_BASE_URL; default: the public service URL)
//
// adopted.json is read from beside this script if present, otherwise from ../records/adopted.json.
// Read-only: GET requests only, no secrets. Each request sends x-rowsmith-team: ci, which marks it as the service's
// own automated check (counted as our own traffic, not outside use; the response is the same). A network error is retried once;
// an HTTP error or a mismatch is never retried. A MISMATCH means the page changed since its last recorded review:
// right after a deploy that changes a page, this is expected until the new hash is reviewed and recorded.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const DEFAULT_BASE_URL = "https://testdata-api.re-jam620.workers.dev";
export const USER_AGENT = "rowsmith-adoption-check/1";
export const TEAM_HEADER = ["x-rowsmith-team", "ci"];
export const TIMEOUT_MS = 20000;
const HERE = dirname(fileURLToPath(import.meta.url));
const CANDIDATES = [join(HERE, "adopted.json"), join(HERE, "..", "records", "adopted.json")];
const HEX64 = /^[0-9a-f]{64}$/;
const UTC = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/;
const STATUSES = ["adopted", "verified", "cleared copy", "served", "reviewed"];
const PUBLIC_KEYS = ["path", "sha256", "status"];

/** The adopted.json this script reads by default. */
export function defaultAdoptedPath() {
  return CANDIDATES.find((p) => existsSync(p)) ?? CANDIDATES[1];
}

/** Returns a list of problems with the parsed adopted.json (empty = valid). */
export function validateAdopted(doc) {
  const errs = [];
  if (!doc || typeof doc !== "object" || !Array.isArray(doc.pages) || doc.pages.length === 0) return ["pages: a non-empty array is required"];
  const seen = new Set();
  doc.pages.forEach((p, i) => {
    const at = `pages[${i}]`;
    if (!p || typeof p !== "object") return void errs.push(`${at}: not an object`);
    if (typeof p.path !== "string" || !p.path.startsWith("/")) errs.push(`${at}.path: must start with /`);
    else if (seen.has(p.path)) errs.push(`${at}.path: duplicate ${p.path}`);
    else seen.add(p.path);
    if (typeof p.sha256 !== "string" || !HEX64.test(p.sha256)) errs.push(`${at}.sha256: 64 lowercase hex characters required`);
    if (!STATUSES.includes(p.status)) return void errs.push(`${at}.status: one of ${STATUSES.join(", ")}`);
    if (p.status === "reviewed") {
      // The public form: path, sha256 and status only.
      const extra = Object.keys(p).filter((k) => !PUBLIC_KEYS.includes(k));
      if (extra.length) errs.push(`${at}: a reviewed entry has path, sha256 and status only (found ${extra.join(", ")})`);
      return;
    }
    if (p.adopted_at !== null && !(typeof p.adopted_at === "string" && UTC.test(p.adopted_at)))
      errs.push(`${at}.adopted_at: ISO 8601 UTC (YYYY-MM-DDTHH:MM:SSZ) or null`);
    if (p.status === "adopted" && p.adopted_at === null) errs.push(`${at}.adopted_at: required for status adopted`);
    if (p.verified_at !== undefined && !(typeof p.verified_at === "string" && UTC.test(p.verified_at)))
      errs.push(`${at}.verified_at: ISO 8601 UTC (YYYY-MM-DDTHH:MM:SSZ)`);
    if (typeof p.adopted_by !== "string" || !p.adopted_by) errs.push(`${at}.adopted_by: required`);
    if (typeof p.record !== "string" || !p.record) errs.push(`${at}.record: required`);
  });
  return errs;
}

export function loadAdopted(file = defaultAdoptedPath()) {
  const doc = JSON.parse(readFileSync(file, "utf8"));
  const errs = validateAdopted(doc);
  if (errs.length) throw new Error(`invalid ${file}:\n  ${errs.join("\n  ")}`);
  return doc;
}

async function fetchOnce(fetchImpl, url, timeoutMs) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(new Error(`timeout after ${timeoutMs} ms`)), timeoutMs);
  try {
    const headers = { "user-agent": USER_AGENT, [TEAM_HEADER[0]]: TEAM_HEADER[1] };
    const res = await fetchImpl(url, { method: "GET", redirect: "manual", headers, signal: ctl.signal });
    const body = new Uint8Array(await res.arrayBuffer());
    return { status: res.status, body };
  } finally {
    clearTimeout(timer);
  }
}

/** Checks one page. Retries once on a network error (thrown fetch / timeout) only; never on an HTTP status or a mismatch. */
export async function checkPage(page, { baseUrl = DEFAULT_BASE_URL, fetchImpl = fetch, timeoutMs = TIMEOUT_MS } = {}) {
  const url = baseUrl.replace(/\/+$/, "") + page.path;
  let r;
  try {
    r = await fetchOnce(fetchImpl, url, timeoutMs);
  } catch {
    try {
      r = await fetchOnce(fetchImpl, url, timeoutMs);
    } catch (e2) {
      return { ok: false, line: `NETWORK ERROR ${page.path}: ${e2 instanceof Error ? e2.message : String(e2)} (after 1 retry)` };
    }
  }
  if (r.status !== 200) return { ok: false, line: `HTTP ERROR ${page.path}: status ${r.status}, expected 200` };
  const got = createHash("sha256").update(r.body).digest("hex");
  if (got !== page.sha256) return { ok: false, line: `MISMATCH ${page.path} (${page.status}): expected ${page.sha256} got ${got}` };
  return { ok: true, line: `OK ${page.path} ${got} (${page.status})` };
}

/** Checks every page in order; returns the printed lines and the exit code (0 only if all OK). */
export async function runCheck(doc, opts = {}) {
  const lines = [];
  let failed = 0;
  for (const page of doc.pages) {
    const r = await checkPage(page, opts);
    lines.push(r.line);
    if (!r.ok) failed++;
  }
  if (failed) {
    lines.push(`adoption-check: FAIL, ${failed} of ${doc.pages.length} paths differ from adopted.json.`);
    lines.push("A MISMATCH means the page changed since its last recorded review. Right after a deploy that changes a page");
    lines.push("this is expected: the check stays red until the new hash is reviewed and recorded in adopted.json.");
  } else lines.push(`adoption-check: PASS, ${doc.pages.length} of ${doc.pages.length} paths match adopted.json.`);
  return { lines, code: failed ? 1 : 0 };
}

async function main() {
  const baseUrl = process.argv[2] || process.env.ADOPTION_CHECK_BASE_URL || DEFAULT_BASE_URL;
  const file = defaultAdoptedPath();
  let doc;
  try {
    doc = loadAdopted(file);
  } catch (e) {
    console.error(`adoption-check: FAIL, ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  console.log(`adoption-check: ${baseUrl} against adopted.json (${doc.pages.length} paths)`);
  const { lines, code } = await runCheck(doc, { baseUrl });
  for (const l of lines) console.log(l);
  return code;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main();
