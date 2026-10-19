// Package shape: package.json, MIT licence, the composite Action, and the README's required lines.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { NOTES } from "../lib/cli.js";
import { PKG } from "./helpers.js";

const pkg = JSON.parse(readFileSync(join(PKG, "package.json"), "utf8"));
const action = readFileSync(join(PKG, "action.yml"), "utf8");
const readme = readFileSync(join(PKG, "README.md"), "utf8");

test("package.json: name, version, bin, engines, files, test script, MIT, public repo, no dependencies", () => {
  assert.equal(pkg.name, "rowsmith-lint");
  assert.equal(pkg.version, "0.1.0");
  assert.deepEqual(pkg.bin, { "rowsmith-lint": "bin/rowsmith-lint.js" });
  assert.equal(pkg.engines.node, ">=20");
  assert.deepEqual(pkg.files, ["bin/", "lib/", "README.md", "LICENSE"]);
  assert.equal(pkg.scripts.test, "node --test test/*.test.js");
  assert.equal(pkg.license, "MIT");
  assert.equal(pkg.repository.url, "git+https://github.com/meiorz/rowsmith-mcp.git");
  assert.equal(pkg.bugs.url, "https://github.com/meiorz/rowsmith-mcp/issues");
  for (const k of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) assert.equal(pkg[k], undefined, k);
  for (const k of ["preinstall", "install", "postinstall", "prepare"]) assert.equal(pkg.scripts[k], undefined, k);
  assert.ok(readFileSync(join(PKG, "bin", "rowsmith-lint.js"), "utf8").startsWith("#!/usr/bin/env node\n"));
});

test("LICENSE: MIT with the 'AS IS' text, identical to the Rowsmith MCP package's when that is present", () => {
  const lic = readFileSync(join(PKG, "LICENSE"), "utf8");
  assert.ok(lic.startsWith("MIT License"));
  assert.ok(lic.includes('THE SOFTWARE IS PROVIDED "AS IS"'));
  const sibling = join(PKG, "..", "LICENSE");
  if (existsSync(join(PKG, "..", "server.js"))) assert.equal(lic, readFileSync(sibling, "utf8"));
});

test("action.yml: composite, the four inputs, env-only inputs, node runs the CLI from the action path", () => {
  assert.match(action, /^runs:\n {2}using: composite$/m);
  for (const input of ["path", "include", "exclude", "fail-on"]) assert.match(action, new RegExp(`^ {2}${input}:$`, "m"), input);
  assert.match(action, /^ {6}shell: bash$/m);
  assert.ok(action.includes('node "$GITHUB_ACTION_PATH/bin/rowsmith-lint.js" "${args[@]}" -- "${INPUT_PATH:-.}"'));
  const run = action.slice(action.indexOf("run: |"));
  assert.doesNotMatch(run, /\$\{\{/, "inputs reach the script through env only");
  assert.match(action, /contents: read/);
  for (const re of [/\buses:/, /\bcurl\b/, /\bwget\b/, /secrets\./, /github\.token/, /upload-artifact|actions\/cache/, /\bnpm\b|\bnpx\b/])
    assert.doesNotMatch(action, re, String(re));
});

test("README: the required lines, the claim sentences and the exit codes", () => {
  for (const line of [
    "Runs locally and sends nothing anywhere: no network access, no telemetry, no update check.",
    "A pattern check, not legal or compliance advice.",
    NOTES[0],
    NOTES[2],
    "npx rowsmith-lint",
    "permissions:\n  contents: read",
  ]) assert.ok(readme.includes(line), line);
  assert.match(readme, /\| `0` \| no findings/);
  assert.match(readme, /\| `1` \| findings/);
  assert.match(readme, /\| `2` \| usage or read error/);
  assert.ok(readme.includes("uses: meiorz/rowsmith-mcp/rowsmith-lint@rowsmith-lint-v0.1.0"));
  assert.ok(readme.includes("uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1"));
  assert.doesNotMatch(readme, /@main\b/);
  assert.ok(readme.includes("Dense numeric files, such as CSV columns of short integers, can produce card findings"));
  for (const text of [readme, action, pkg.description]) assert.doesNotMatch(text, /national IDs?/i);
  for (const banned of [/compliant/i, /finds all/i, /\bGDPR\b/, /\bHIPAA\b/, /\bPCI\b/, /guarantee/i])
    assert.doesNotMatch(readme, banned, String(banned));
});
