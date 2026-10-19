// Walks a directory, picks fixture-like files and scans them line by line. Reads local files only.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";
import { compileGlobs, DEFAULT_INCLUDE } from "./glob.js";
import { mask, RULES, scanLine } from "./rules.js";

export const MAX_BYTES = 5 * 1024 * 1024;
export const ALLOWLIST_NAME = ".rowsmith-lint-allow";
const SKIP_DIRS = new Set(["node_modules", ".git"]);
const BINARY_EXT = /\.(png|jpe?g|gif|webp|ico|bmp|tiff?|pdf|zip|gz|tgz|bz2|xz|7z|rar|jar|woff2?|ttf|otf|eot|mp[34]|mov|avi|wasm|exe|dll|so|dylib|class|pyc|sqlite3?|db)$/i;

export class LintError extends Error {}

/**
 * Reads an allowlist of locations. One entry per line: a rule name, whitespace, then either path:line (that rule on
 * that line of that file) or a path glob (that rule anywhere in matching files). Paths are relative to the scanned
 * directory, with forward slashes. Blank lines and lines starting with # are ignored. No value and no hash of a value
 * is ever stored; a line that itself looks like a flaggable value is refused. Errors name the line number only.
 */
export function readAllowlist(file) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    throw new LintError("cannot read the allowlist file");
  }
  const entries = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith("#")) return;
    const where = `${ALLOWLIST_NAME} line ${i + 1}`;
    if (scanLine(line).length) throw new LintError(`${where}: looks like it holds a value; entries are a rule and a location only`);
    const m = /^(email|card|ssn|iban|phone)\s+(\S+)$/.exec(line);
    if (!m) throw new LintError(`${where}: expected "<email|card|ssn|iban|phone> <path:line or path glob>"`);
    const loc = /^(.+):([1-9]\d*)$/.exec(m[2]);
    let matchPath;
    try {
      matchPath = loc ? null : compileGlobs([m[2]])[0];
    } catch {
      throw new LintError(`${where}: not a valid glob`);
    }
    entries.push({ text: `${m[1]} ${m[2]}`, rule: m[1], path: loc ? loc[1].replace(/^\.\//, "") : null, line: loc ? Number(loc[2]) : null, matchPath, used: false });
  });
  return entries;
}

function allowedBy(entries, rel, line, rule) {
  let hit = false;
  for (const e of entries) {
    if (e.rule !== rule) continue;
    if (e.path !== null ? e.path === rel && e.line === line : e.matchPath(rel)) {
      e.used = true;
      hit = true;
    }
  }
  return hit;
}

function toPosix(p) {
  return p.split(sep).join("/");
}

function* walk(root, dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    throw new LintError(`cannot read directory ${toPosix(relative(root, dir)) || "."}`);
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) yield* walk(root, full);
    } else if (e.isFile()) yield full;
  }
}

/**
 * Scans `target` (a directory, or one file which is then scanned whatever its name).
 * Returns { files_scanned, files_skipped, allowlisted, allowlist_unused, findings: [{ file, line, column, rule, normalized }] }.
 * `normalized` stays inside the process: the reporters print only mask(normalized).
 */
export function scan(target, { include = DEFAULT_INCLUDE, exclude = [], allowlist = [] } = {}) {
  let st;
  try {
    st = statSync(target);
  } catch {
    throw new LintError("path does not exist");
  }
  const inc = compileGlobs(include);
  const exc = compileGlobs(exclude);
  const root = st.isDirectory() ? target : join(target, "..");
  const files = st.isDirectory() ? walk(root, target) : [target];
  const result = { files_scanned: 0, files_skipped: 0, allowlisted: 0, findings: [] };
  for (const full of files) {
    const rel = toPosix(relative(root, full));
    if (st.isDirectory()) {
      if (basename(full) === ALLOWLIST_NAME) continue;
      if (!inc.some((m) => m(rel)) || exc.some((m) => m(rel))) continue;
    }
    let buf;
    try {
      if (statSync(full).size > MAX_BYTES || BINARY_EXT.test(full)) {
        result.files_skipped++;
        continue;
      }
      buf = readFileSync(full);
    } catch {
      throw new LintError(`cannot read file ${rel}`);
    }
    if (buf.subarray(0, 8000).includes(0)) {
      result.files_skipped++;
      continue;
    }
    result.files_scanned++;
    buf.toString("utf8").split(/\r?\n/).forEach((text, i) => {
      for (const f of scanLine(text)) {
        if (allowedBy(allowlist, rel, i + 1, f.rule)) {
          result.allowlisted++;
          continue;
        }
        result.findings.push({ file: rel, line: i + 1, column: f.column, rule: f.rule, normalized: f.normalized });
      }
    });
  }
  result.allowlist_unused = allowlist.filter((e) => !e.used).map((e) => e.text);
  return result;
}

/** The public shape of a finding: the masked value only, never the value itself. */
export function publicFinding(f) {
  return {
    file: f.file, line: f.line, column: f.column, rule: f.rule, masked: mask(f.rule, f.normalized),
    message: RULES[f.rule].message, column_type: RULES[f.rule].column_type,
  };
}
