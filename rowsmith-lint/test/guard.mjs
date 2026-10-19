// No-network guard, preloaded with `node --import <this file>`. Every way Node opens a socket or resolves a name is
// replaced by a function that prints NETWORK-GUARD and exits 99, so any network attempt fails the run loudly.
import dgram from "node:dgram";
import dns from "node:dns";
import http from "node:http";
import http2 from "node:http2";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import tls from "node:tls";

function trip(what) {
  return () => {
    process.stderr.write(`NETWORK-GUARD: ${what} blocked\n`);
    process.exit(99);
  };
}

net.Socket.prototype.connect = trip("net.Socket.connect");
net.connect = net.createConnection = trip("net.connect");
tls.connect = trip("tls.connect");
http.request = http.get = trip("http.request");
https.request = https.get = trip("https.request");
http2.connect = trip("http2.connect");
dgram.createSocket = trip("dgram.createSocket");
for (const k of ["lookup", "resolve", "resolve4", "resolve6", "resolveAny", "resolveTxt", "resolveMx", "resolveSrv", "reverse"])
  dns[k] = trip(`dns.${k}`);
for (const k of ["lookup", "resolve", "resolve4", "resolve6", "resolveAny", "reverse"]) dns.promises[k] = trip(`dns.promises.${k}`);
globalThis.fetch = trip("fetch");
if (globalThis.WebSocket) globalThis.WebSocket = trip("WebSocket");
if (globalThis.EventSource) globalThis.EventSource = trip("EventSource");
syncBuiltinESMExports();
