// CLI behaviour: exit codes, formats, file selection, allowlist, usage errors, and masking on every output channel.
// Every run goes through the no-network guard (test/guard.mjs).
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { mask } from "../lib/rules.js";
import { scanLine } from "../lib/rules.js";
import { PKG, planted, removeTree, tempTree } from "./helpers.js";
import { cli } from "./run.js";

const P = planted();
const dirs = [];
function tree(files) {
  const d = tempTree(files);
  dirs.push(d);
  return d;
}
after(() => dirs.forEach(removeTree));

const CLEAN = "id,email,phone,card,ssn\n1,jane.doe@example.com,+1-201-555-0123,4242424242424242,912-00-1234\n";
const DIRTY = `id,email,phone,card,ssn,iban\n1,${P.email},${P.phone},${P.card},${P.ssn},${P.iban}\n`;

test("exit 0 and a clean summary when nothing looks real", () => {
  const d = tree({ "test/fixtures/users.csv": CLEAN });
  const r = cli([d]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /1 file\(s\) scanned, 0 finding\(s\)/);
  assert.ok(!r.stdout.includes("NETWORK-GUARD") && !r.stderr.includes("NETWORK-GUARD"));
});

test("exit 1 with findings, one per rule, each with file:line:column, rule and suggestion", () => {
  const d = tree({ "test/fixtures/users.csv": DIRTY });
  const r = cli([d]);
  assert.equal(r.code, 1, r.stderr);
  for (const rule of ["email", "phone", "card", "ssn", "iban"]) assert.match(r.stdout, new RegExp(`users\\.csv:2:\\d+  ${rule}  `));
  for (const t of ["email", "phone", "test_card", "ssn_invalid", "iban_invalid"]) assert.ok(r.stdout.includes(`column type "${t}"`), t);
  assert.ok(r.stdout.includes("/v1/generate"));
});

test("--fail-on none exits 0 with findings; --fail-on findings exits 1", () => {
  const d = tree({ "fixtures/a.csv": DIRTY });
  assert.equal(cli([d, "--fail-on", "none"]).code, 0);
  assert.equal(cli([d, "--fail-on=findings"]).code, 1);
});

test("output carries the claim, limits, advice and local-only lines", () => {
  const d = tree({ "fixtures/a.csv": CLEAN });
  const r = cli([d]);
  for (const s of [
    "Checks these formats: email addresses not on reserved test domains, payment card numbers (Luhn-valid, excluding Stripe's published test cards), US Social Security numbers in valid ranges, IBANs with a valid checksum, and phone numbers",
    "A finding means a value looks like real data, not that it is real.",
    "It is pattern-based: it may miss values that don't match its rules, and it may flag test values it doesn't know.",
    "A pattern check, not legal or compliance advice.",
    "Runs locally and sends nothing anywhere: no network access, no telemetry, no update check.",
  ]) assert.ok(r.stdout.includes(s), s);
});

test("--format json: version field, findings with masked values and suggestions, no raw value", () => {
  const d = tree({ "seed/data.sql": `INSERT INTO u VALUES ('${P.email}');\n` });
  const r = cli([d, "--format", "json"]);
  assert.equal(r.code, 1);
  const j = JSON.parse(r.stdout);
  assert.equal(j.version, 1);
  assert.equal(j.tool, "rowsmith-lint");
  assert.equal(j.tool_version, "0.1.0");
  assert.equal(j.files_scanned, 1);
  assert.equal(j.findings.length, 1);
  const f = j.findings[0];
  assert.deepEqual(Object.keys(f).sort(), ["column", "file", "line", "masked", "message", "rule", "suggestion"]);
  assert.equal(f.file, "seed/data.sql");
  assert.equal(f.line, 1);
  assert.equal(f.masked, "j***@acme-mail.co");
  assert.equal(f.suggestion.column_type, "email");
  assert.match(f.suggestion.example_request, /^curl -s https:\/\/testdata-api\.re-jam620\.workers\.dev\/v1\/generate .*"type":"email"/);
  assert.ok(!r.stdout.includes(P.email));
});

test("default globs pick fixture-like files only; --include replaces them; --exclude removes files", () => {
  const d = tree({
    "src/app.js": `const e = "${P.email}";\n`,
    "test/fixtures/a.json": `{"e":"${P.email}"}\n`,
    "testdata/b.txt": `${P.email}\n`,
    "db/users.seed.sql": `${P.email}\n`,
    "seeds/c.yaml": `e: ${P.email}\n`,
    "tests/unit/d.yml": `e: ${P.email}\n`,
    "tests/unit/e.js": `${P.email}\n`,
    "node_modules/x/fixtures/f.json": `${P.email}\n`,
  });
  const files = (r) => JSON.parse(r.stdout).findings.map((f) => f.file).sort();
  assert.deepEqual(files(cli([d, "--format", "json"])), ["db/users.seed.sql", "seeds/c.yaml", "test/fixtures/a.json", "testdata/b.txt", "tests/unit/d.yml"]);
  assert.deepEqual(files(cli([d, "--format", "json", "--include", "src/**"])), ["src/app.js"]);
  assert.deepEqual(files(cli([d, "--format", "json", "--exclude", "**/seed*/**", "--exclude", "*.seed.*"])), ["test/fixtures/a.json", "testdata/b.txt", "tests/unit/d.yml"]);
});

test("binary files and files over 5 MB are skipped", () => {
  const d = tree({ "fixtures/bin.dat": Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(P.email)]), "fixtures/ok.csv": CLEAN });
  writeFileSync(join(d, "fixtures/big.csv"), `${P.email}\n`.padEnd(5 * 1024 * 1024 + 1, "x"));
  const j = JSON.parse(cli([d, "--format", "json"]).stdout);
  assert.equal(j.files_scanned, 1);
  assert.equal(j.files_skipped, 2);
  assert.equal(j.findings.length, 0);
});

test("a single file path is scanned whatever its name", () => {
  const d = tree({ "notes.txt": `${P.ssn}\n` });
  const r = cli([join(d, "notes.txt"), "--format", "json"]);
  assert.equal(r.code, 1);
  assert.equal(JSON.parse(r.stdout).findings[0].file, "notes.txt");
});

test("allowlist: path:line and path glob entries silence findings of that rule only", () => {
  const d = tree({
    "fixtures/a.csv": `x\n${P.email}\n${P.phone}\n`,
    "fixtures/legacy/b.csv": `${P.ssn}\n`,
    ".rowsmith-lint-allow": "# known false positives\nemail fixtures/a.csv:2\nssn fixtures/legacy/**\nphone fixtures/a.csv:2\n",
  });
  const j = JSON.parse(cli([d, "--format", "json"]).stdout);
  assert.deepEqual(j.findings.map((f) => `${f.file}:${f.line}:${f.rule}`), ["fixtures/a.csv:3:phone"]);
  assert.equal(j.allowlisted, 2);
});

test("allowlist: an entry that matches nothing is reported, and the exit stays 0 without findings", () => {
  const d = tree({ "fixtures/a.csv": `${P.email}\n`, ".rowsmith-lint-allow": "email fixtures/a.csv:1\ncard fixtures/moved.csv:7\nphone old/**\n" });
  const r = cli([d]);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.ok(r.stdout.includes("allowlist entry matched nothing: card fixtures/moved.csv:7"));
  assert.ok(r.stdout.includes("allowlist entry matched nothing: phone old/**"));
  assert.ok(!r.stdout.includes("matched nothing: email"));
  const j = JSON.parse(cli([d, "--format", "json"]).stdout);
  assert.deepEqual(j.allowlist_unused, ["card fixtures/moved.csv:7", "phone old/**"]);
  const g = cli([d, "--format", "github"]);
  assert.equal(g.code, 0);
  assert.ok(g.stdout.includes("::notice title=rowsmith-lint::allowlist entry matched nothing: card fixtures/moved.csv:7"));
});

test("allowlist: --allowlist names another file; malformed entries and entries holding a value exit 2 without echoing the line", () => {
  const d = tree({ "fixtures/a.csv": `${P.email}\n`, "allow.txt": "email fixtures/a.csv:1\n" });
  assert.equal(cli([d, "--allowlist", join(d, "allow.txt")]).code, 0);
  for (const bad of ["just-a-path\n", "sha256:" + "ab".repeat(32) + "\n", `email ${P.email}\n`, `card ${P.card}\n`, `ssn ${P.ssn}\n`, "email a b c\n"]) {
    writeFileSync(join(d, "allow.txt"), bad);
    const r = cli([d, "--allowlist", join(d, "allow.txt")]);
    assert.equal(r.code, 2, "malformed allowlist entry");
    assert.match(r.stderr, /line 1/);
    assert.ok(!r.stderr.includes(bad.trim()), "allowlist error echoed the entry");
  }
  assert.equal(cli([d, "--allowlist", join(d, "missing.txt")]).code, 2);
});

test("usage errors exit 2 and never echo the offending argument", () => {
  const d = tree({ "fixtures/a.csv": CLEAN });
  const cases = [
    [d, `--${P.card}`],
    [d, "--format", "xml"],
    [d, "--fail-on", "always"],
    [d, "--include"],
    [d, "--include", ""],
    [d, d],
    [join(d, "does-not-exist")],
  ];
  for (const args of cases) {
    const r = cli(args);
    assert.equal(r.code, 2, `usage case ${cases.indexOf(args)}`);
    assert.equal(r.stdout, "");
    assert.ok(!r.stderr.includes(P.card));
  }
  assert.equal(cli(["--help"]).code, 0);
  assert.equal(cli(["--version"]).stdout.trim(), "0.1.0");
});

test("masking on every channel: text, json and github output plus the step summary show only each type's mask", () => {
  const d = tree({ "fixtures/a.csv": DIRTY });
  const summary = join(d, "summary.md");
  writeFileSync(summary, "");
  const outputs = [
    cli([d]), cli([d, "--format", "json"]), cli([d, "--format", "github"], { env: { GITHUB_STEP_SUMMARY: summary } }),
  ].map((r) => r.stdout + r.stderr);
  outputs.push(readFileSync(summary, "utf8"));
  const found = scanLine(DIRTY.split("\n")[1]);
  assert.equal(found.length, 5);
  for (const text of outputs) assertMasked(text, found);
});

/** No channel may show more of a value than its mask: checked by windows one longer than the mask reveals. */
function assertMasked(text, found) {
  for (const f of found) {
    assert.ok(text.includes(mask(f.rule, f.normalized)), `${f.rule} mask missing`);
    const visible = { ssn: 2, phone: 2, card: 4, iban: 2 }[f.rule];
    if (f.rule === "email") {
      const local = f.normalized.slice(0, f.normalized.indexOf("@"));
      assert.ok(!text.includes(local.slice(1)), "email local part leaked");
      continue;
    }
    const body = f.rule === "iban" ? f.normalized.slice(2) : f.normalized.replace(/\D/g, "");
    for (let i = 0; i + visible + 1 <= body.length; i++) {
      const w = body.slice(i, i + visible + 1);
      assert.ok(!text.includes(w), `${f.rule} leaked a ${w.length}-character window`);
    }
  }
}

test("the linter's own package scans clean with the default globs", () => {
  const r = cli([PKG]);
  assert.equal(r.code, 0, r.stdout);
});
