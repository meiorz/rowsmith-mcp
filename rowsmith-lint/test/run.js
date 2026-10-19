// Runs the CLI (or a bash script) in a child process with the no-network guard preloaded.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { BIN, GUARD } from "./helpers.js";

export const GUARD_URL = pathToFileURL(GUARD).href;

export function cli(args, { cwd, env = {} } = {}) {
  const r = spawnSync(process.execPath, ["--import", GUARD_URL, BIN, ...args], {
    cwd, encoding: "utf8", env: { ...process.env, GITHUB_STEP_SUMMARY: "", ...env },
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

export function node(args, opts = {}) {
  const r = spawnSync(process.execPath, args, { encoding: "utf8", ...opts });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** A bash to run the Action's script with, or null (Windows without Git for Windows: never WSL's bash.exe). */
export function findBash() {
  if (process.platform !== "win32") return "bash";
  for (const p of ["C:\\Program Files\\Git\\bin\\bash.exe", "C:\\Program Files (x86)\\Git\\bin\\bash.exe"]) if (existsSync(p)) return p;
  return null;
}
