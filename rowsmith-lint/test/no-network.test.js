// No network, proven: the guard (test/guard.mjs) trips on any socket, DNS lookup or fetch; the package is imported,
// the CLI run and the Action's script executed under it. A static check backs it up.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { pathToFileURL } from "node:url";
import { PKG, planted, removeTree, tempTree } from "./helpers.js";
import { cli, findBash, GUARD_URL, node } from "./run.js";
import { spawnSync } from "node:child_process";

const dirs = [];
after(() => dirs.forEach(removeTree));
const P = planted();

test("guard control: fetch, net.connect (named ESM import), http.get and dns.lookup are all stopped with exit 99", () => {
  const probes = [
    "await fetch('http://127.0.0.1:9/')",
    "const { connect } = await import('node:net'); connect(9, '127.0.0.1')",
    "const http = await import('node:http'); http.get('http://127.0.0.1:9/')",
    "const dns = await import('node:dns'); dns.lookup('localhost', () => {})",
    "const net = await import('node:net'); new net.Socket().connect(9, '127.0.0.1')",
  ];
  for (const code of probes) {
    const r = node(["--import", GUARD_URL, "--input-type=module", "-e", code]);
    assert.equal(r.code, 99, code);
    assert.match(r.stderr, /NETWORK-GUARD/);
  }
});

test("importing the package under the guard opens no connection", () => {
  const url = pathToFileURL(join(PKG, "lib", "index.js")).href;
  const r = node(["--import", GUARD_URL, "--input-type=module", "-e", `await import(${JSON.stringify(url)});`]);
  assert.equal(r.code, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /NETWORK-GUARD/);
});

test("a CLI run with findings, in every format, opens no connection", () => {
  const d = tempTree({ "fixtures/a.csv": Object.values(P).join("\n") + "\n" });
  dirs.push(d);
  for (const format of ["text", "json", "github"]) {
    const r = cli([d, "--format", format]);
    assert.equal(r.code, 1, r.stderr);
    assert.doesNotMatch(r.stdout + r.stderr, /NETWORK-GUARD/);
  }
});

/** The bash script of the Action's single step, unindented. */
export function actionScript() {
  const lines = readFileSync(join(PKG, "action.yml"), "utf8").split(/\r?\n/);
  const at = lines.findIndex((l) => /^\s+run: \|$/.test(l));
  const indent = lines[at].search(/\S/) + 2;
  const out = [];
  for (const l of lines.slice(at + 1)) {
    if (l.trim() && l.search(/\S/) < indent) break;
    out.push(l.slice(indent));
  }
  return out.join("\n") + "\n";
}

const bash = findBash();
test("the Action's script, run under the guard, opens no connection and its log and summary are masked", { skip: bash ? false : "no bash" }, () => {
  const d = tempTree({ "work/fixtures/a.csv": `x\n${Object.values(P).join(",")}\n` });
  dirs.push(d);
  const summary = join(d, "summary.md");
  writeFileSync(summary, "");
  const r = spawnSync(bash, ["-c", actionScript()], {
    cwd: join(d, "work"), encoding: "utf8",
    env: {
      ...process.env, NODE_OPTIONS: `--import=${GUARD_URL}`, GITHUB_ACTION_PATH: PKG, GITHUB_STEP_SUMMARY: summary,
      INPUT_PATH: ".", INPUT_INCLUDE: "fixtures/**\r\n\n", INPUT_EXCLUDE: "", INPUT_FAIL_ON: "findings",
    },
  });
  // Control: in the same environment, the guard is live for every node the script starts.
  const control = spawnSync(bash, ["-c", "node -e \"fetch('http://127.0.0.1:9/')\""], {
    encoding: "utf8", env: { ...process.env, NODE_OPTIONS: `--import=${GUARD_URL}` },
  });
  assert.equal(control.status, 99, control.stderr);
  const all = r.stdout + r.stderr + readFileSync(summary, "utf8");
  assert.equal(r.status, 1, all);
  assert.doesNotMatch(all, /NETWORK-GUARD/);
  assert.match(r.stdout, /::error file=fixtures\/a\.csv,line=2,col=\d+,title=rowsmith-lint email::/);
  for (const v of Object.values(P)) assert.ok(!all.includes(v), "a planted value reached the Action's output");
  assert.ok(readFileSync(summary, "utf8").includes("j***@acme-mail.co"));
});

test("static: no source file references a network module or API", () => {
  const files = ["bin", "lib"].flatMap((dir) => readdirSync(join(PKG, dir)).map((f) => join(PKG, dir, f)));
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    for (const re of [/node:(net|http|https|http2|tls|dgram|dns)\b/, /require\(/, /\bfetch\s*\(/, /WebSocket|XMLHttpRequest|EventSource/, /child_process/])
      assert.doesNotMatch(src, re, `${f}: ${re}`);
  }
});
