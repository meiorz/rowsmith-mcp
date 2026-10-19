// The Open Plugins files for cursor.directory (.mcp.json and .cursor-plugin/plugin.json, CTO and COO, cycle 7): the
// launch line pins the published version with no env, token or secret; the text is the cleared listing copy.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const read = async (rel) => JSON.parse(await readFile(new URL(rel, import.meta.url), "utf8"));
const LISTINGS = new URL("../../listings/LISTINGS.md", import.meta.url);

test(".mcp.json launches the pinned published version with npx and nothing else", async () => {
  const pkg = await read("../package.json");
  const mcp = await read("../.mcp.json");
  assert.deepEqual(Object.keys(mcp), ["mcpServers"]);
  assert.deepEqual(mcp.mcpServers, { rowsmith: { command: "npx", args: ["-y", `rowsmith-mcp@${pkg.version}`] } });
});

test(".cursor-plugin/plugin.json names the plugin and carries no email address", async () => {
  const pkg = await read("../package.json");
  const plugin = await read("../.cursor-plugin/plugin.json");
  assert.match(plugin.name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/); // kebab-case, as the template requires
  assert.equal(plugin.version, pkg.version);
  assert.equal(plugin.license, pkg.license);
  assert.deepEqual(plugin.author, { name: "meiorz" });
  assert.doesNotMatch(JSON.stringify(plugin), /@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
  assert.doesNotMatch(JSON.stringify(plugin), /sandbox|payment|charge|refund|realistic/i);
});

test("the plugin description is the cleared one-line copy in listings/LISTINGS.md", { skip: existsSync(LISTINGS) ? false : "needs ../../listings/LISTINGS.md, which exists only in the private monorepo" }, async () => {
  const plugin = await read("../.cursor-plugin/plugin.json");
  const listings = await readFile(LISTINGS, "utf8");
  const line = listings.match(/^\*\*One line \(≤ 100 chars\):\*\* (.+)$/m);
  assert.ok(line, "LISTINGS.md has a One line entry");
  assert.equal(plugin.description, line[1]);
  assert.ok(plugin.description.length <= 100);
});
