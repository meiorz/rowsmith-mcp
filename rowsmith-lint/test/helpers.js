// Test helpers. Values that must look real are built here at runtime (Luhn check digits, IBAN check digits), so no
// committed file holds one; committed fixtures hold reserved or invalid values only.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const PKG = join(dirname(fileURLToPath(import.meta.url)), "..");
export const BIN = join(PKG, "bin", "rowsmith-lint.js");
export const GUARD = join(PKG, "test", "guard.mjs");

/** digits followed by their Luhn check digit. */
export function luhn(digits) {
  let sum = 0;
  const x = digits + "0";
  for (let i = 0; i < x.length; i++) {
    let d = x.charCodeAt(x.length - 1 - i) - 48;
    if (i % 2 === 1) d = d * 2 > 9 ? d * 2 - 9 : d * 2;
    sum += d;
  }
  return digits + String((10 - (sum % 10)) % 10);
}

/** An IBAN with correct mod-97 check digits for the country code and BBAN. */
export function iban(cc, bban) {
  const moved = bban + cc + "00";
  let rem = 0;
  for (const ch of moved) {
    const v = ch >= "A" && ch <= "Z" ? String(ch.charCodeAt(0) - 55) : ch;
    for (const d of v) rem = (rem * 10 + Number(d)) % 97;
  }
  return cc + String(98 - rem).padStart(2, "0") + bban;
}

/**
 * Expands the corpus templates (test/card-corpus.json, "expand"):
 *   {L:DIGITS}       DIGITS plus their Luhn check digit
 *   {L:DIGITS:SEP}   the same, in groups of 4 joined by SEP
 *   {LW:DIGITS}      the same as {L:DIGITS} in full-width digits (U+FF10 to U+FF19)
 * The Worker's test/lint-parity.test.ts has the same function.
 */
export function expand(text) {
  return text.replace(/\{(LW?):(\d+)(?::([^}]*))?\}/g, (_, kind, digits, sep) => {
    let n = luhn(digits);
    if (sep !== undefined) n = n.match(/.{1,4}/g).join(sep);
    if (kind === "LW") n = [...n].map((c) => (c >= "0" && c <= "9" ? String.fromCharCode(0xff10 + Number(c)) : c)).join("");
    return n;
  });
}

export function loadCorpus() {
  return JSON.parse(readFileSync(join(PKG, "test", "card-corpus.json"), "utf8"));
}

/** A fresh temp directory with the given files ({ "rel/path": "content" }). os.tmpdir() honours TMPDIR / TEMP. */
export function tempTree(files) {
  const dir = mkdtempSync(join(tmpdir(), "rowsmith-lint-test-"));
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}

export function removeTree(dir) {
  rmSync(dir, { recursive: true, force: true });
}

/** Real-looking values, built at runtime: one per rule. */
export function planted() {
  return {
    email: ["jane", "doe"].join(".") + "@" + "acme-mail.co",
    card: luhn("453201511283036"),
    ssn: ["219", "09", "1234"].join("-"),
    iban: iban("DE", "370400440532013000"),
    phone: "+1-415-" + "263-1234",
  };
}
