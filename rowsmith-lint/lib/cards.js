// Card-number detector: a line-for-line port of containsCardNumber in the Rowsmith Worker (src/cards.ts in
// testdata-api). TypeScript cannot be imported into this stdlib-only package, so parity is proven by a shared corpus,
// test/card-corpus.json, which this package's tests and the Worker's vitest suite (test/lint-parity.test.ts) both
// check with identical verdicts. Change both sides together.

// Card numbers from Stripe's published testing list, exactly the Worker's ALLOWED_CARDS (TEST_CARDS in
// src/reserved.ts plus the keys of DECLINE_CARDS in src/cards.ts). The list was last changed in that repo on
// STRIPE_LIST_AS_OF. test/card-corpus.json carries the same list and date; both test suites compare against it.
export const STRIPE_LIST_AS_OF = "2026-10-17";
export const STRIPE_TEST_CARDS = Object.freeze([
  "4242424242424242", "4000056655665556", "5555555555554444", "2223003122003222", "5200828282828210",
  "378282246310005", "371449635398431", "6011111111111117", "3056930009020004", "3566002020360505",
  "4000000000000002", "4000000000009995", "4000000000009987", "4000000000009979", "4000000000006975",
  "4100000000000019", "4000000000000069", "4000000000000127", "4000000000000119", "4242424242424241",
]);
const ALLOWED = new Set(STRIPE_TEST_CARDS);

export function luhnValid(digits) {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = digits.charCodeAt(digits.length - 1 - i) - 48;
    if (i % 2 === 1) d = d * 2 > 9 ? d * 2 - 9 : d * 2;
    sum += d;
  }
  return sum % 10 === 0;
}

// Separators between digits: any run of 1 or 2 whitespace, dash (\p{Pd}), connector (\p{Pc}) or other punctuation
// (\p{Po}) characters. Format characters (\p{Cf}) are removed first, and digits are folded to ASCII. One written
// number uses one separator throughout ("4111,1111,1111,1111", "4111, 1111, ..."); a run is split where the
// separator changes, and a separator of 3 or more characters ("4111 - 1111", space-dash-space) ends the run.
const RUN = /[0-9](?:[\s\p{Pd}\p{Pc}\p{Po}]{0,2}[0-9])*/gu;
const FORMAT = /\p{Cf}/gu;

/** NFKC, then every remaining Unicode decimal digit mapped to its ASCII value. */
export function foldDigits(text) {
  return text.normalize("NFKC").replace(/\p{Nd}/gu, (ch) => {
    const cp = ch.codePointAt(0);
    if (cp <= 0x39) return ch;
    let start = cp;
    while (start > 0 && /\p{Nd}/u.test(String.fromCodePoint(start - 1))) start--;
    return String((cp - start) % 10);
  });
}

/** The text the detector reads: format characters removed, digits folded to ASCII. */
export function prepareText(text) {
  return foldDigits(text.replace(FORMAT, "")).replace(FORMAT, "");
}

// First digit (major industry identifier, ISO/IEC 7812) 2 to 6, 13 to 19 digits, Luhn valid.
const cardLike = (d) => d.length >= 13 && d.length <= 19 && d[0] >= "2" && d[0] <= "6" && luhnValid(d);

// The card number inside `digits`, or null. Same decision as digitsAreCard in src/cards.ts.
function cardIn(digits) {
  if (digits.length < 13 || ALLOWED.has(digits)) return null;
  if (digits.length <= 19) return cardLike(digits) ? digits : null;
  for (let len = 13; len <= 19; len++)
    for (let at = 0; at + len <= digits.length; at++) {
      const w = digits.slice(at, at + len);
      if (!ALLOWED.has(w) && cardLike(w)) return w;
    }
  return null;
}

/**
 * Every card-like number in the text, as { digits, index } with index into prepareText(text). Non-empty exactly when
 * the Worker's containsCardNumber(text) is true: the same runs, the same split where the separator changes, the same
 * candidates of whole consecutive groups totalling 13-19 digits, and every window of a group longer than 19 digits.
 */
export function findCardNumbers(text) {
  const prepared = prepareText(text);
  const found = [];
  const seen = new Set();
  for (const m of prepared.matchAll(RUN)) {
    const parts = m[0].match(/[0-9]+|[^0-9]+/g);
    const offsets = [];
    let off = m.index;
    for (const p of parts) {
      offsets.push(off);
      off += p.length;
    }
    const groups = [], groupAt = [], seps = [];
    parts.forEach((p, i) => (i % 2 === 0 ? (groups.push(p), groupAt.push(offsets[i])) : seps.push(p)));
    let start = 0;
    for (let i = 0; i <= seps.length; i++) {
      if (i === seps.length || (i > start && seps[i] !== seps[i - 1])) {
        for (const hit of stretchCards(groups.slice(start, i + 1), groupAt.slice(start, i + 1)))
          if (!seen.has(hit.index)) {
            seen.add(hit.index);
            found.push(hit);
          }
        start = i;
      }
    }
  }
  return found;
}

function stretchCards(groups, at) {
  const hits = [];
  for (let a = 0; a < groups.length; a++) {
    if (groups[a].length > 19) {
      const w = cardIn(groups[a]);
      if (w) {
        hits.push({ digits: w, index: at[a] });
        continue;
      }
    }
    let joined = "";
    for (let b = a; b < groups.length && joined.length + groups[b].length <= 19; b++) {
      joined += groups[b];
      if (joined.length >= 13) {
        const w = cardIn(joined);
        if (w) {
          hits.push({ digits: w, index: at[a] });
          a = b;
          break;
        }
      }
    }
  }
  return hits;
}

/** The Worker's verdict: true when the text holds a card-like number that is not on Stripe's testing list. */
export function containsCardNumber(text) {
  return findCardNumbers(text).length > 0;
}
