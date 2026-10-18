#!/usr/bin/env node
// Entry point: runs the Rowsmith MCP server over stdio. One GET of /pricing.json at startup decides whether the
// sandbox tools are listed; if that check fails they stay hidden and the server says why.
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer, sandboxStatus } from "./server.js";

const status = await sandboxStatus();
await createServer({ sandbox: status === "advertised", sandboxCheckFailed: status === "failed" }).connect(new StdioServerTransport());
