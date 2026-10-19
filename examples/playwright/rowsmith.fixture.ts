// A `rowsmith` fixture for Playwright: fake test data from a schema, cached by the request's sha256 so later runs
// work offline. Copy this file into your tests. No dependency beyond @playwright/test (Node 20's fetch).
//
//   import { test, expect } from "./rowsmith.fixture";
//   test("orders page", async ({ page, rowsmith }) => {
//     const { rows } = await rowsmith.generate({ rows: 5, seed: 42, columns: [...] });
//   });
//
// The service: https://testdata-api.re-jam620.workers.dev (free, rate-limited; send schemas only, never real data).
// Set ROWSMITH_URL to point at another base URL (the example's offline smoke points it at a local stub).
import { test as base } from "@playwright/test";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export { expect } from "@playwright/test";

export const FIXTURE_VERSION = "0.1.0";
const BASE = (process.env.ROWSMITH_URL ?? "https://testdata-api.re-jam620.workers.dev").replace(/\/$/, "");
const CACHE_DIR = path.join(process.cwd(), "node_modules", ".cache", "rowsmith");

export interface RowsmithResult {
  rows: Record<string, unknown>[];
  /** sha256 of the response body, equal to the service's X-Output-SHA256. */
  outputSha256: string;
  generatorVersion: string | null;
  /** A curl command that reproduces this answer. */
  reproduce: string;
  fromCache: boolean;
}

/** POST /v1/generate in JSON form; "version" defaults to "1" so cached answers stay valid. */
export async function generate(request: Record<string, unknown>): Promise<RowsmithResult> {
  const body = JSON.stringify({ version: "1", ...request, format: "json" });
  const key = createHash("sha256").update(body).digest("hex");
  const file = path.join(CACHE_DIR, `${key}.json`);
  const reproduce = `curl -sS ${BASE}/v1/generate -H 'content-type: application/json' -d '${body}'`;
  try {
    return { ...(JSON.parse(await readFile(file, "utf8")) as RowsmithResult), fromCache: true };
  } catch {
    // not cached yet
  }
  const res = await fetch(`${BASE}/v1/generate`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "user-agent": `rowsmith-playwright/${FIXTURE_VERSION}`,
      "x-rowsmith-tool": "playwright",
    },
    body,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Rowsmith answered ${res.status}: ${text}\nReproduce: ${reproduce}`);
  const outputSha256 = createHash("sha256").update(text).digest("hex");
  const declared = res.headers.get("x-output-sha256");
  if (declared && declared !== outputSha256) {
    throw new Error(`Rowsmith body sha256 ${outputSha256} differs from X-Output-SHA256 ${declared}\nReproduce: ${reproduce}`);
  }
  const result: RowsmithResult = {
    rows: JSON.parse(text) as Record<string, unknown>[],
    outputSha256,
    generatorVersion: res.headers.get("x-generator-version"),
    reproduce,
    fromCache: false,
  };
  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(file, JSON.stringify(result));
  return result;
}

export const test = base.extend<{ rowsmith: { generate: typeof generate } }>({
  rowsmith: async ({}, use, testInfo) => {
    const seen: string[] = [];
    await use({
      generate: async (request) => {
        const r = await generate(request);
        seen.push(r.reproduce);
        return r;
      },
    });
    // On failure the report shows how to reproduce every answer the test used.
    if (testInfo.status !== testInfo.expectedStatus) {
      for (const line of seen) testInfo.annotations.push({ type: "rowsmith reproduce", description: line });
    }
  },
});
