"""Test helpers: a local stub of the Rowsmith API (http.server in a thread), so the suite runs offline."""
import json
import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from importlib.metadata import entry_points

_EPS = entry_points(group="pytest11") if sys.version_info >= (3, 10) else entry_points().get("pytest11", [])

# When the package is installed, pytest loads the plugin from its entry point; otherwise (running from a checkout
# with src on sys.path) load it here. Loading it twice would fail. Inner pytester runs disable autoloading and load
# it with -p instead (see INNER_ARGS in test_plugin.py).
INSTALLED = any(ep.value == "pytest_rowsmith.plugin" for ep in _EPS)
pytest_plugins = ["pytester"] + ([] if INSTALLED else ["pytest_rowsmith.plugin"])

CSV_BODY = b"id,name\r\n1,Ada\r\n2,\"Lovelace, A\"\r\n"
JSON_BODY = b'[{"id":1,"name":"Ada","email":null},{"id":2,"name":"Bo","email":"bo@example.com"}]'
SQL_BODY = b'INSERT INTO "t" ("id") VALUES (1);\nINSERT INTO "t" ("id") VALUES (2);\n'
REPRODUCE = "POST /v1/generate body-b64url=c3R1Yg"


class Stub:
    """Records every request; answers from a queue of (status, headers, body), else a default by format."""

    def __init__(self):
        self.requests = []
        self.queue = []
        self.server = None

    @property
    def url(self):
        return "http://127.0.0.1:%d" % self.server.server_address[1]

    def answer(self, status, body, headers=None):
        self.queue.append((status, headers or {}, body))

    def default(self, body):
        fmt = json.loads(body).get("format")
        if fmt == "csv":
            return 200, {"content-type": "text/csv", "x-generator-version": "1", "x-seed": "1", "x-reproduce": REPRODUCE}, CSV_BODY
        if fmt == "sql":
            return 200, {"content-type": "application/sql", "x-generator-version": "1", "x-seed": "1", "x-reproduce": REPRODUCE}, SQL_BODY
        return 200, {"content-type": "application/json", "x-generator-version": "1", "x-seed": "1"}, JSON_BODY


def _handler(stub):
    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            body = self.rfile.read(int(self.headers.get("content-length", "0")))
            stub.requests.append({"path": self.path, "headers": {k.lower(): v for k, v in self.headers.items()}, "body": body})
            status, headers, out = stub.queue.pop(0) if stub.queue else stub.default(body)
            self.send_response(status)
            for k, v in headers.items():
                self.send_header(k, v)
            self.send_header("content-length", str(len(out)))
            self.end_headers()
            self.wfile.write(out)

        def log_message(self, *args):
            pass

    return Handler


@pytest.fixture
def stub():
    s = Stub()
    s.server = ThreadingHTTPServer(("127.0.0.1", 0), _handler(s))
    t = threading.Thread(target=s.server.serve_forever, daemon=True)
    t.start()
    yield s
    s.server.shutdown()
    s.server.server_close()


def pytest_collection_modifyitems(config, items):
    """The live golden test is excluded from the default run: it is deselected unless ROWSMITH_LIVE=1."""
    if os.environ.get("ROWSMITH_LIVE") == "1":
        return
    live = [i for i in items if i.get_closest_marker("live")]
    if live:
        config.hook.pytest_deselected(items=live)
        items[:] = [i for i in items if not i.get_closest_marker("live")]
