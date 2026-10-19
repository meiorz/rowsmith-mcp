// Command line: argument parsing and the three reporters (text, json, github). Exit codes: 0 clean (or
// --fail-on none), 1 findings, 2 usage or read error. Every reporter prints masked values only (rules.js mask).
import { appendFileSync, existsSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DEFAULT_INCLUDE } from "./glob.js";
import { exampleRequest } from "./rules.js";
import { ALLOWLIST_NAME, LintError, publicFinding, readAllowlist, scan } from "./scan.js";

export const VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
export const JSON_VERSION = 1;

export const FORMATS =
  "Checks these formats: email addresses not on reserved test domains, payment card numbers (Luhn-valid, excluding " +
  "Stripe's published test cards), US Social Security numbers in valid ranges, IBANs with a valid checksum, and phone " +
  "numbers (North American numbers outside the fictional 555-0100 to 555-0199 range, and international numbers " +
  "written in E.164 form).";
export const LOOKS = "A finding means a value looks like real data, not that it is real.";
export const LIMITS =
  "It is pattern-based: it may miss values that don't match its rules, and it may flag test values it doesn't know.";
export const ADVICE = "A pattern check, not legal or compliance advice.";
export const LOCAL = "Runs locally and sends nothing anywhere: no network access, no telemetry, no update check.";
export const NOTES = Object.freeze([FORMATS, LOOKS, LIMITS, ADVICE, LOCAL]);

export const USAGE = `Usage: rowsmith-lint [path] [options]

Scans test fixtures and seed files under path (default: the current directory) for values that look like real
emails, card numbers, US SSNs, IBANs and phone numbers. ${LOCAL}

Options:
  --include <glob>      Scan files matching this glob (repeatable; replaces the default globs)
  --exclude <glob>      Skip files matching this glob (repeatable)
  --format <f>          text (default), json or github
  --fail-on <when>      findings (default: exit 1 when there are findings) or none (always exit 0)
  --allowlist <file>    Allowlist of locations (default: <path>/${ALLOWLIST_NAME} when it exists)
  -h, --help            Show this help
  -v, --version         Show the version

Allowlist entries, one per line: "<email|card|ssn|iban|phone> <path>:<line>" or "<rule> <path glob>".
Exit codes: 0 no findings (or --fail-on none), 1 findings, 2 usage or read error.
Default include globs: ${DEFAULT_INCLUDE.join(" ")}`;

class UsageError extends Error {}

export function parseArgs(argv) {
  const opts = { path: undefined, include: [], exclude: [], format: "text", failOn: "findings", allowlist: undefined };
  let positionalOnly = false;
  for (let i = 0; i < argv.length; i++) {
    let arg = argv[i];
    if (!positionalOnly && arg === "--") {
      positionalOnly = true;
      continue;
    }
    if (positionalOnly || !arg.startsWith("-") || arg === "-") {
      if (opts.path !== undefined) throw new UsageError("only one path may be given");
      opts.path = arg;
      continue;
    }
    let value;
    const eq = arg.indexOf("=");
    if (arg.startsWith("--") && eq > 0) {
      value = arg.slice(eq + 1);
      arg = arg.slice(0, eq);
    }
    const name = arg;
    const take = () => {
      if (value !== undefined) return value;
      if (i + 1 >= argv.length) throw new UsageError(`${name} needs a value`);
      return argv[++i];
    };
    switch (arg) {
      case "-h": case "--help": opts.help = true; break;
      case "-v": case "--version": opts.version = true; break;
      case "--include": opts.include.push(take()); break;
      case "--exclude": opts.exclude.push(take()); break;
      case "--allowlist": opts.allowlist = take(); break;
      case "--format": {
        const f = take();
        if (!["text", "json", "github"].includes(f)) throw new UsageError("--format must be text, json or github");
        opts.format = f;
        break;
      }
      case "--fail-on": {
        const f = take();
        if (!["findings", "none"].includes(f)) throw new UsageError("--fail-on must be findings or none");
        opts.failOn = f;
        break;
      }
      default:
        // The option itself is not echoed: it could be a pasted value.
        throw new UsageError("unknown option (see --help)");
    }
  }
  for (const g of [...opts.include, ...opts.exclude]) if (!g) throw new UsageError("a glob may not be empty");
  return opts;
}

// GitHub workflow-command escaping.
const escData = (s) => s.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
const escProp = (s) => escData(s).replace(/:/g, "%3A").replace(/,/g, "%2C");
const unusedLine = (e) => `allowlist entry matched nothing: ${e}`;

function report(opts, result, prefix) {
  const findings = result.findings.map(publicFinding);
  const rules = [...new Set(findings.map((f) => f.rule))];
  if (opts.format === "json") {
    const out = {
      version: JSON_VERSION,
      tool: "rowsmith-lint",
      tool_version: VERSION,
      files_scanned: result.files_scanned,
      files_skipped: result.files_skipped,
      allowlisted: result.allowlisted,
      allowlist_unused: result.allowlist_unused,
      findings: findings.map(({ column_type, ...f }) => ({ ...f, suggestion: { column_type, example_request: exampleRequest(f.rule) } })),
      notes: NOTES,
    };
    return JSON.stringify(out, null, 2) + "\n";
  }
  const lines = [];
  if (opts.format === "github") {
    const level = opts.failOn === "none" ? "warning" : "error";
    for (const f of findings) {
      const file = prefix ? `${prefix}/${f.file}` : f.file;
      lines.push(`::${level} file=${escProp(file)},line=${f.line},col=${f.column},title=${escProp(`rowsmith-lint ${f.rule}`)}::` +
        escData(`Value ${f.masked} ${f.message}. Replace it with Rowsmith column type "${f.column_type}".`));
    }
    for (const e of result.allowlist_unused) lines.push(`::notice title=rowsmith-lint::${escData(unusedLine(e))}`);
  }
  lines.push(`rowsmith-lint ${VERSION}: ${result.files_scanned} file(s) scanned, ${findings.length} finding(s)` +
    (result.allowlisted ? `, ${result.allowlisted} allowlisted` : ""));
  for (const f of findings)
    lines.push(`${f.file}:${f.line}:${f.column}  ${f.rule}  ${f.masked}  ${f.message}; use Rowsmith column type "${f.column_type}"`);
  if (opts.format === "text") for (const e of result.allowlist_unused) lines.push(unusedLine(e));
  if (rules.length) {
    lines.push("", "Example Rowsmith requests for replacements (rowsmith-lint sends nothing; run one yourself if you want):");
    for (const r of rules) lines.push(`  ${r}: ${exampleRequest(r)}`);
  }
  lines.push("", ...NOTES);
  return lines.join("\n") + "\n";
}

function stepSummary(opts, result, prefix) {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (opts.format !== "github" || !file) return;
  const rows = result.findings.map(publicFinding).map((f) =>
    `| ${(prefix ? `${prefix}/` : "") + f.file}:${f.line}:${f.column} | ${f.rule} | \`${f.masked}\` | \`${f.column_type}\` |`);
  const md = [
    `### rowsmith-lint: ${result.findings.length} finding(s) in ${result.files_scanned} file(s)`,
    "",
    ...(rows.length ? ["| Where | Rule | Value (masked) | Rowsmith column type |", "|---|---|---|---|", ...rows, ""] : []),
    ...result.allowlist_unused.map((e) => `- ${unusedLine(e)}`),
    "",
    NOTES.join(" "),
    "",
  ].join("\n");
  appendFileSync(file, md);
}

/** Runs the CLI. Returns the exit code; writes through the given streams. */
export function main(argv, { stdout = process.stdout, stderr = process.stderr, cwd = process.cwd() } = {}) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    stderr.write(`rowsmith-lint: ${e.message}\n${USAGE}\n`);
    return 2;
  }
  if (opts.help) {
    stdout.write(USAGE + "\n");
    return 0;
  }
  if (opts.version) {
    stdout.write(VERSION + "\n");
    return 0;
  }
  const target = resolve(cwd, opts.path ?? ".");
  try {
    if (!existsSync(target)) throw new LintError("path does not exist");
    const isFile = statSync(target).isFile();
    const allowFile = opts.allowlist !== undefined ? resolve(cwd, opts.allowlist) : resolve(isFile ? dirname(target) : target, ALLOWLIST_NAME);
    const allowlist = opts.allowlist !== undefined || existsSync(allowFile) ? readAllowlist(allowFile) : [];
    const result = scan(target, {
      include: opts.include.length ? opts.include : DEFAULT_INCLUDE,
      exclude: opts.exclude,
      allowlist,
    });
    const given = opts.path ?? ".";
    let prefix = (isFile ? dirname(given) : given).replace(/\\/g, "/").replace(/^(\.\/)+/, "").replace(/\/+$/, "");
    if (prefix === ".") prefix = "";
    stdout.write(report(opts, result, prefix));
    stepSummary(opts, result, prefix);
    return result.findings.length && opts.failOn === "findings" ? 1 : 0;
  } catch (e) {
    if (!(e instanceof LintError)) throw e;
    stderr.write(`rowsmith-lint: ${e.message}\n`);
    return 2;
  }
}
