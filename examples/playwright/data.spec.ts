// Data-only example (no browser needed): the golden request's rows, checked by their sha256.
import golden from "./fixtures/golden-json.json" with { type: "json" };
import { expect, test } from "./rowsmith.fixture";

test("the golden request gives the recorded rows", async ({ rowsmith }) => {
  const { version: _version, format: _format, ...request } = golden.request as Record<string, unknown>;
  const result = await rowsmith.generate(request);
  expect(result.outputSha256).toBe(golden.headers["x-output-sha256"]);
  expect(result.generatorVersion).toBe("1");
  expect(result.rows).toHaveLength(5);
  expect(result.rows[0]).toMatchObject({ order_no: "ord_0001" });
  // email has null_rate 0.1 in the golden schema, so some rows carry null; every present address is on a reserved domain.
  for (const row of result.rows) if (row.email !== null) expect(String(row.email)).toMatch(/@(example\.(com|net|org)|mail\.test)$/);
});
