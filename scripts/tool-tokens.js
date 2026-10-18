// Measures the size of this server's tool definitions as a client sees them: the JSON of the tools/list result
// (names, titles, descriptions, input schemas), in characters, and tokens approximated as characters / 4.
// Usage: node scripts/tool-tokens.js
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../server.js";

export async function measureTools(options = {}) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const server = createServer(options);
  await server.connect(serverSide);
  const client = new Client({ name: "measure", version: "0" });
  await client.connect(clientSide);
  const { tools } = await client.listTools();
  await client.close();
  await server.close();
  const chars = JSON.stringify(tools).length;
  return { tools: tools.length, chars, tokens: Math.ceil(chars / 4) };
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("tool-tokens.js")) {
  for (const sandbox of [false, true]) {
    const m = await measureTools({ sandbox });
    console.log(`${sandbox ? "with sandbox" : "default"}: ${m.tools} tools, ${m.chars} characters, about ${m.tokens} tokens (characters / 4)`);
  }
}
