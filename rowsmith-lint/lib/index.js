// Library entry: the same scanner the CLI uses. Findings carry the normalized value for in-process use only;
// print them through publicFinding (masked) and never log the raw value.
export { containsCardNumber, findCardNumbers, STRIPE_LIST_AS_OF, STRIPE_TEST_CARDS } from "./cards.js";
export { DEFAULT_INCLUDE } from "./glob.js";
export { mask, RULES, scanLine } from "./rules.js";
export { publicFinding, readAllowlist, scan } from "./scan.js";
export { main, VERSION } from "./cli.js";
