// Offline stand-in for POST /v1/generate, for the example's smoke run only: it answers the golden request with the
// Worker's recorded bytes (fixtures/golden-json.json, checked against the handler by test/playwright-fixture.test.ts
// in the service's repo) and refuses anything else. Binds to 127.0.0.1 only.
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { isDeepStrictEqual } from "node:util";

const fx = JSON.parse(readFileSync(new URL("./fixtures/golden-json.json", import.meta.url), "utf8"));
const PORT = Number(process.env.PORT ?? 8787);

createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    let body = null;
    try {
      body = JSON.parse(raw);
    } catch {
      // not JSON
    }
    const ok = req.method === "POST" && req.url === "/v1/generate" && body && (body.version ?? "1") === "1";
    if (ok) delete body.version;
    if (!ok || !isDeepStrictEqual(body, fx.request)) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "the stub answers only the recorded golden request", next: "run against the real service" }));
      return;
    }
    res.writeHead(200, fx.headers);
    res.end(fx.body);
  });
}).listen(PORT, "127.0.0.1", () => console.log(`stub on http://127.0.0.1:${PORT}`));
