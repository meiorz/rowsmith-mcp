// Helper for the rowsmith fixtures action (action.yml). It builds the request body from the schema file and the
// inputs, and turns a refusal into the service's own "next" step. The action itself makes the one curl call.
// No network access here, no secrets, no caching.
//   node fixtures.mjs body              print the JSON body (reads INPUT_SCHEMA, INPUT_SEED, INPUT_ROWS, INPUT_FORMAT)
//   node fixtures.mjs fail <status> <f> print the error message for a non-200 response saved in file <f>
import { readFileSync } from "node:fs";

/**
 * The request body: the schema file is either a full request object or just a columns array. seed, rows and
 * format from the inputs replace the file's values when they are given; otherwise the file's (or the service's
 * defaults) apply.
 */
export function buildBody(schemaText, inputs = {}) {
  let schema;
  try {
    schema = JSON.parse(schemaText);
  } catch {
    throw new Error("The schema file is not valid JSON.");
  }
  const body = Array.isArray(schema) ? { columns: schema } : schema;
  if (!body || typeof body !== "object" || Array.isArray(body) || !Array.isArray(body.columns))
    throw new Error('The schema file must hold a columns array, or an object with "columns".');
  const int = (name, v) => {
    if (v === undefined || v === "") return undefined;
    if (!/^\d{1,10}$/.test(String(v))) throw new Error(`The ${name} input must be a whole number.`);
    return Number(v);
  };
  const seed = int("seed", inputs.seed);
  const rows = int("rows", inputs.rows);
  if (seed !== undefined) body.seed = seed;
  if (rows !== undefined) body.rows = rows;
  if (inputs.format) {
    if (!["csv", "json", "sql"].includes(inputs.format)) throw new Error("The format input must be csv, json or sql.");
    body.format = inputs.format;
  }
  return body;
}

/** The step's error text for a non-200 answer: the service's error and its "next" step when it has one. */
export function failureMessage(status, bodyText) {
  try {
    const b = JSON.parse(bodyText);
    if (b && typeof b.error === "string")
      return `Rowsmith refused the request (HTTP ${status}): ${b.error}${typeof b.next === "string" ? ` Next: ${b.next}` : ""}`;
  } catch {}
  return `Rowsmith answered HTTP ${status}${status === "000" || status === 0 ? " (no response)" : ""}.`;
}

const [mode, ...rest] = process.argv.slice(2);
if (mode === "body") {
  try {
    const env = process.env;
    const body = buildBody(readFileSync(env.INPUT_SCHEMA ?? "", "utf8"), { seed: env.INPUT_SEED, rows: env.INPUT_ROWS, format: env.INPUT_FORMAT });
    process.stdout.write(JSON.stringify(body));
  } catch (e) {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(2);
  }
} else if (mode === "fail") {
  const [status, file] = rest;
  let text = "";
  try {
    text = readFileSync(file, "utf8");
  } catch {}
  // One line, so it fits a GitHub Actions ::error:: annotation.
  process.stdout.write(failureMessage(status, text).replace(/[\r\n]+/g, " "));
}
