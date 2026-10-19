// One positive and one negative case (at least) per rule, plus masking. Real-looking values are built at runtime.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mask, scanLine } from "../lib/rules.js";
import { iban, luhn, planted } from "./helpers.js";

const rules = (line) => scanLine(line).map((f) => f.rule);
const P = planted();

test("email: an address on an ordinary domain is flagged", () => {
  assert.deepEqual(rules(`id,email\n`), []);
  assert.deepEqual(rules(`1,${P.email},x`), ["email"]);
  assert.deepEqual(rules(`"contact": "${["sam", "lee"].join("_")}@${"corp-example"}.io"`), ["email"]);
});

test("email: reserved and test domains pass", () => {
  for (const d of ["example.com", "example.net", "example.org", "sub.example.com", "mail.test", "a.test", "shop.example", "x.invalid", "box.localhost"])
    assert.deepEqual(rules(`jane.doe@${d}`), [], d);
  assert.deepEqual(rules("icon@2x.png logo@3x.svg"), [], "asset names");
  assert.deepEqual(rules("pkg@1.2.3"), [], "versions");
});

test("card: a Luhn-valid 13-19 digit number with MII 2-6 is flagged", () => {
  const card = luhn("453201511283036");
  assert.deepEqual(rules(`card,${card}`), ["card"]);
  assert.deepEqual(rules(card.match(/.{4}/g).join(" ")), ["card"]);
  assert.deepEqual(rules(card.match(/.{4}/g).join("-")), ["card"]);
});

test("card: Stripe test numbers, Luhn failures, short runs and MII 0/1/7/8/9 pass", () => {
  const card = luhn("453201511283036");
  const bad = card.slice(0, -1) + ((Number(card.slice(-1)) + 1) % 10);
  for (const v of ["4242424242424242", "4242 4242 4242 4242", "4000000000000002", "378282246310005", bad, card.slice(0, 12), "1697000000000", "978-0-306-40615-7", luhn("712345678901234")])
    assert.deepEqual(rules(v), [], v);
});

test("ssn: an issuable AAA-GG-SSSS is flagged", () => {
  assert.deepEqual(rules(`ssn: ${P.ssn}`), ["ssn"]);
  assert.deepEqual(rules(["078", "05", "1120"].join("-")), ["ssn"]);
});

test("ssn: area 000/666/9xx, group 00 and serial 0000 pass; undashed and embedded shapes pass", () => {
  for (const v of ["000-12-3456", "666-12-3456", "900-12-3456", "999-99-9999", "123-00-4567", "123-45-0000", "912-00-1234"])
    assert.deepEqual(rules(v), [], v);
  assert.deepEqual(rules(P.ssn.replace(/-/g, "")), [], "undashed nine digits are not read as an SSN");
  assert.deepEqual(rules(`1-${P.ssn}`), [], "part of a longer dashed number");
});

test("iban: a mod-97 valid IBAN of the right length is flagged, plain or in groups of 4", () => {
  assert.deepEqual(rules(`iban,${P.iban}`), ["iban"]);
  assert.deepEqual(rules(P.iban.match(/.{1,4}/g).join(" ")), ["iban"]);
  assert.deepEqual(rules(iban("GB", "WEST12345698765432")), ["iban"]);
});

test("iban: wrong checksum, check digits 00, wrong length and unknown countries pass", () => {
  const bad = P.iban.slice(0, 2) + String((Number(P.iban.slice(2, 4)) + 1) % 100).padStart(2, "0") + P.iban.slice(4);
  for (const v of [bad, "DE00370400440532013000", "GB00123456789012345678"]) assert.deepEqual(rules(v), [], v);
  // Not IBAN-shaped, so the IBAN rule passes them; their digit runs still go to the card rule like any other digits.
  for (const v of [P.iban + "1", P.iban.slice(0, -1), iban("ZZ", "370400440532013000")]) assert.ok(!rules(v).includes("iban"), v);
  // Rowsmith's own iban_invalid output (check digits 00) is not read as a card either.
  assert.deepEqual(rules("ES00" + "1".repeat(20)), []);
});

test("phone: NANP numbers outside 555-0100..0199 and plausible E.164 numbers are flagged", () => {
  assert.deepEqual(rules(P.phone), ["phone"]);
  assert.deepEqual(rules("(212) 263-9876"), ["phone"]);
  assert.deepEqual(rules("212.263.9876"), ["phone"]);
  assert.deepEqual(rules("+1 212 263 9876"), ["phone"]);
  assert.deepEqual(rules("+4930" + "901820"), ["phone"]);
});

test("phone: fictional ranges, invalid NANP forms and bare digit runs pass", () => {
  for (const v of ["+1-201-555-0123", "(415) 555-0199", "212-555-0100", "+447700900123", "+442079460999", "123-456-7890",
    "212-111-4567", "911-263-1234", "296-263-1234", "2122639876", "+1234567", "+123456789012", "212-263.9876", "1.2.3"])
    assert.deepEqual(rules(v), [], v);
});

test("masking per type: SSN and phone last 2 digits, card last 4, email first character plus domain, IBAN country plus last 2", () => {
  assert.equal(mask("ssn", "219091234"), "***-**-**34");
  assert.equal(mask("phone", "+14152631234"), "********34");
  assert.equal(mask("card", "4532015112830366"), "****0366");
  assert.equal(mask("email", "jane.doe@acme-mail.co"), "j***@acme-mail.co");
  assert.equal(mask("iban", "DE89370400440532013000"), "DE******00");
  for (const f of scanLine(Object.values(P).join(" , "))) {
    const m = mask(f.rule, f.normalized);
    const shownDigits = m.replace(/[^0-9]/g, "");
    const limit = { ssn: 2, phone: 2, card: 4, iban: 2, email: Infinity }[f.rule];
    if (f.rule !== "email") assert.ok(shownDigits.length <= limit, `${f.rule}: ${m}`);
    assert.ok(!m.includes(f.normalized));
  }
});

test("columns are 1-based positions in the line", () => {
  const [f] = scanLine(`ab,${P.email}`);
  assert.equal(f.column, 4);
});
