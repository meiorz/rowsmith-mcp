// Parity with the Rowsmith Worker's card detector (src/cards.ts containsCardNumber): the shared corpus
// test/card-corpus.json is checked here and by the Worker's test/lint-parity.test.ts, with identical verdicts.
import assert from "node:assert/strict";
import { test } from "node:test";
import { containsCardNumber, findCardNumbers, luhnValid, STRIPE_LIST_AS_OF, STRIPE_TEST_CARDS } from "../lib/cards.js";
import { expand, loadCorpus } from "./helpers.js";

const corpus = loadCorpus();

test("corpus: every case gets the corpus verdict", () => {
  assert.ok(corpus.cases.length >= 20);
  for (const c of corpus.cases) assert.equal(containsCardNumber(expand(c.text)), c.card, c.note);
});

test("corpus: findCardNumbers is non-empty exactly when containsCardNumber is true", () => {
  for (const c of corpus.cases) assert.equal(findCardNumbers(expand(c.text)).length > 0, c.card, c.note);
});

test("corpus: the Stripe test list and its date match the package's list", () => {
  assert.equal(corpus.stripe_list_as_of, STRIPE_LIST_AS_OF);
  assert.deepEqual([...corpus.stripe_test_cards].sort(), [...STRIPE_TEST_CARDS].sort());
  for (const n of STRIPE_TEST_CARDS) assert.equal(containsCardNumber(n), false, n);
});

test("corpus: the committed file holds no card-like number outside the Stripe list", () => {
  const raw = JSON.stringify(corpus.cases.map((c) => c.text));
  // Unexpanded, no case (template digits included) holds a card-like number, so the file itself scans clean.
  for (const c of corpus.cases) assert.equal(containsCardNumber(c.text), false, `unexpanded: ${c.note}`);
  assert.ok(raw.includes("{L:"));
});

test("luhn: known values", () => {
  assert.equal(luhnValid("4242424242424242"), true);
  assert.equal(luhnValid("4242424242424241"), false);
});
