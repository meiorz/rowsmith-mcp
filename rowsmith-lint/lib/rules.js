// The five rules. Each one needs structure plus a validity check; a bare regex match is never a finding.
// Every rule's exact logic is written out in README.md ("Rules"); keep the two in step.
import { findCardNumbers, prepareText } from "./cards.js";

export const API_BASE = "https://testdata-api.re-jam620.workers.dev";

export const RULES = Object.freeze({
  email: { column_type: "email", message: "looks like a real email address" },
  card: { column_type: "test_card", message: "looks like a real card number" },
  ssn: { column_type: "ssn_invalid", message: "looks like a real US SSN" },
  iban: { column_type: "iban_invalid", message: "looks like a real IBAN" },
  phone: { column_type: "phone", message: "looks like a real phone number" },
});

export function exampleRequest(rule) {
  const type = RULES[rule].column_type;
  const body = JSON.stringify({ rows: 10, format: "csv", columns: [{ name: type === "test_card" ? "card" : rule, type }] });
  return `curl -s ${API_BASE}/v1/generate -H 'content-type: application/json' -d '${body}'`;
}

/**
 * The only form in which a matched value is ever shown, in every output channel:
 *   ssn    ***-**-** and the last 2 digits        phone  ******** and the last 2 digits
 *   card   **** and the last 4 digits             email  the first character, ***, then @domain
 *   iban   the country code, ******, the last 2 characters
 */
export function mask(rule, normalized) {
  switch (rule) {
    case "ssn": return `***-**-**${normalized.slice(-2)}`;
    case "phone": return `********${normalized.slice(-2)}`;
    case "card": return `****${normalized.slice(-4)}`;
    case "iban": return `${normalized.slice(0, 2)}******${normalized.slice(-2)}`;
    case "email": {
      const at = normalized.lastIndexOf("@");
      return `${normalized[0]}***${normalized.slice(at)}`;
    }
    default: throw new Error("unknown rule");
  }
}

// ---- email -------------------------------------------------------------------------------------------------------
// local@domain where the domain has at least two labels and an alphabetic TLD of 2-24 letters.
const EMAIL =
  /(?<![A-Za-z0-9._%+-])[A-Za-z0-9][A-Za-z0-9._%+-]{0,63}@((?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,24})(?![A-Za-z0-9-]|\.[A-Za-z0-9])/g;
const RESERVED_TLDS = new Set(["test", "example", "invalid", "localhost"]);
const RESERVED_DOMAINS = ["example.com", "example.net", "example.org"];
// "icon@2x.png"-style asset names are not addresses.
const FILE_TLDS = new Set(["png", "jpg", "jpeg", "gif", "svg", "webp", "ico", "js", "mjs", "cjs", "ts", "css", "map", "json"]);

export function emailReserved(domain) {
  const d = domain.toLowerCase();
  const tld = d.slice(d.lastIndexOf(".") + 1);
  return RESERVED_TLDS.has(tld) || RESERVED_DOMAINS.some((r) => d === r || d.endsWith(`.${r}`));
}

function emails(line) {
  const out = [];
  for (const m of line.matchAll(EMAIL)) {
    const domain = m[1].toLowerCase();
    const tld = domain.slice(domain.lastIndexOf(".") + 1);
    const span = { start: m.index, end: m.index + m[0].length };
    if (FILE_TLDS.has(tld)) continue;
    out.push({ ...span, flag: !emailReserved(domain), rule: "email", normalized: m[0].toLowerCase() });
  }
  return out;
}

// ---- US SSN ------------------------------------------------------------------------------------------------------
// AAA-GG-SSSS with dashes, not touching other digits, letters or dashes. Never issued: area 000, 666 or 900-999,
// group 00, serial 0000.
const SSN = /(?<![0-9A-Za-z_-])(\d{3})-(\d{2})-(\d{4})(?![0-9A-Za-z_]|-\d)/g;

export function ssnIssuable(area, group, serial) {
  const a = Number(area);
  return a !== 0 && a !== 666 && a < 900 && group !== "00" && serial !== "0000";
}

function ssns(line) {
  return [...line.matchAll(SSN)].map((m) => ({
    start: m.index, end: m.index + m[0].length, rule: "ssn",
    flag: ssnIssuable(m[1], m[2], m[3]), normalized: `${m[1]}${m[2]}${m[3]}`,
  }));
}

// ---- IBAN --------------------------------------------------------------------------------------------------------
// Total IBAN length per country (SWIFT IBAN registry).
const IBAN_LENGTHS = {
  AD: 24, AE: 23, AL: 28, AT: 20, AZ: 28, BA: 20, BE: 16, BG: 22, BH: 22, BR: 29, BY: 28, CH: 21, CR: 22, CY: 28,
  CZ: 24, DE: 22, DK: 18, DO: 28, EE: 20, EG: 29, ES: 24, FI: 18, FO: 18, FR: 27, GB: 22, GE: 22, GI: 23, GL: 18,
  GR: 27, GT: 28, HR: 21, HU: 28, IE: 22, IL: 23, IQ: 23, IS: 26, IT: 27, JO: 30, KW: 30, KZ: 20, LB: 28, LC: 32,
  LI: 21, LT: 20, LU: 20, LV: 21, MC: 27, MD: 24, ME: 22, MK: 19, MR: 27, MT: 31, MU: 30, NL: 18, NO: 15, PK: 24,
  PL: 28, PS: 29, PT: 25, QA: 29, RO: 24, RS: 22, SA: 24, SC: 31, SE: 24, SI: 19, SK: 24, SM: 27, ST: 25, SV: 28,
  TL: 23, TN: 24, TR: 26, UA: 29, VA: 22, VG: 24, XK: 20,
};
const IBAN_START = /(?<![A-Za-z0-9_])([A-Z]{2})(\d{2})/g;

export function ibanMod97(iban) {
  const moved = iban.slice(4) + iban.slice(0, 4);
  let rem = 0;
  for (const ch of moved) {
    const v = ch >= "A" && ch <= "Z" ? String(ch.charCodeAt(0) - 55) : ch;
    for (const d of v) rem = (rem * 10 + Number(d)) % 97;
  }
  return rem;
}

function ibans(line) {
  const out = [];
  for (const m of line.matchAll(IBAN_START)) {
    const len = IBAN_LENGTHS[m[1]];
    if (!len) continue;
    // Uppercase letters and digits, optionally grouped in fours by single spaces, to exactly the country's length.
    let i = m.index + 4, n = 4, iban = m[0];
    while (n < len && i < line.length) {
      const ch = line[i];
      if (ch === " " && n % 4 === 0 && /[A-Z0-9]/.test(line[i + 1] ?? "")) i++;
      else if (/[A-Z0-9]/.test(ch)) {
        iban += ch;
        n++;
        i++;
      } else break;
    }
    if (n !== len || /[A-Za-z0-9_]/.test(line[i] ?? "")) continue;
    const check = Number(m[2]);
    out.push({ start: m.index, end: i, rule: "iban", flag: check >= 2 && check <= 98 && ibanMod97(iban) === 1, normalized: iban });
  }
  return out;
}

// ---- phone -------------------------------------------------------------------------------------------------------
// Shapes: E.164 (+ then 8-15 digits, no separators); +1 or 1- then a NANP number; (AAA) EEE-LLLL; AAA-EEE-LLLL or
// AAA.EEE.LLLL (one separator throughout); +1 AAA EEE LLLL. Plain digit runs without separators are never phones.
const PHONE_SHAPES = [
  /(?<![0-9A-Za-z_+.-])(?:\+1[ .-]?|1-)?(\d{3})([.-])(\d{3})\2(\d{4})(?![0-9A-Za-z_]|[.-]\d)/g,
  /(?<![0-9A-Za-z_])(?:\+1 ?)?\((\d{3})\) ?(\d{3})[-.](\d{4})(?![0-9A-Za-z_]|[.-]\d)/g,
  /(?<![0-9A-Za-z_])\+1 (\d{3}) (\d{3}) (\d{4})(?![0-9A-Za-z_]| \d)/g,
  /(?<![0-9A-Za-z_+])\+([1-9]\d{7,14})(?![0-9A-Za-z_])/g,
];

/** NANP: area and exchange start 2-9 and are not N11; the area's middle digit is not 9 (N9X is unassigned). */
export function nanpValid(d10) {
  const area = d10.slice(0, 3), ex = d10.slice(3, 6);
  return /^[2-9][0-8]\d$/.test(area) && !/^[2-9]11$/.test(area) && /^[2-9]\d\d$/.test(ex) && !/^[2-9]11$/.test(ex);
}

/** Ranges set aside for fiction and drama: NANP 555-0100 to 555-0199; UK 07700 900000-900999 and 020 7946 0000-0999. */
export function phoneReserved(e164) {
  if (/^\+1\d{3}55501\d\d$/.test(e164)) return true;
  return /^\+447700900\d{3}$/.test(e164) || /^\+442079460\d{3}$/.test(e164);
}

/** True when the E.164 form is plausible enough to flag: NANP-valid for +1, otherwise any +CC of 8-15 digits. */
export function phonePlausible(e164) {
  const d = e164.slice(1);
  if (d.startsWith("1")) return d.length === 11 && nanpValid(d.slice(1));
  return d.length >= 8 && d.length <= 15;
}

function phones(line) {
  const out = [];
  PHONE_SHAPES.forEach((re, k) => {
    for (const m of line.matchAll(re)) {
      let e164;
      if (k === 0) e164 = `+1${m[1]}${m[3]}${m[4]}`;
      else if (k === 1 || k === 2) e164 = `+1${m[1]}${m[2]}${m[3]}`;
      else e164 = `+${m[1]}`;
      out.push({
        start: m.index, end: m.index + m[0].length, rule: "phone",
        flag: phonePlausible(e164) && !phoneReserved(e164), normalized: e164,
      });
    }
  });
  return out;
}

// ---- line scan ---------------------------------------------------------------------------------------------------
function overlaps(a, b) {
  return a.start < b.end && b.start < a.end;
}

/**
 * Findings in one line: [{ rule, column, normalized }]. IBAN, SSN, phone and email shapes are found first, and their
 * spans (flagged or not) are blanked before the card detector reads the line, so an IBAN's digits or a long E.164
 * number are not read again as a card. Where shapes overlap, the earlier rule in that order wins.
 */
export function scanLine(line) {
  const shapes = [];
  for (const s of [...ibans(line), ...ssns(line), ...phones(line), ...emails(line)])
    if (!shapes.some((t) => overlaps(s, t))) shapes.push(s);
  let rest = line;
  for (const s of shapes) rest = rest.slice(0, s.start) + " ".repeat(s.end - s.start) + rest.slice(s.end);
  const out = shapes.filter((s) => s.flag).map((s) => ({ rule: s.rule, column: s.start + 1, normalized: s.normalized }));
  // Card columns are positions in the prepared text (NFKC, format characters removed); they equal the raw columns
  // whenever preparing leaves the line's length unchanged.
  const shift = prepareText(rest).length === rest.length;
  for (const c of findCardNumbers(rest)) out.push({ rule: "card", column: c.index + 1, normalized: c.digits, approxColumn: !shift });
  return out.sort((a, b) => a.column - b.column);
}
