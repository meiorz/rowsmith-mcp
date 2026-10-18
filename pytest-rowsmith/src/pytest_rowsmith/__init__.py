"""pytest-rowsmith: reproducible fake test data from the Rowsmith API, cached for offline test runs.

The client sends schemas only (column definitions), never data. It uses the standard library alone (urllib),
and reaches the network only when a generate call misses the cache or the cache is bypassed with
``--rowsmith-refresh``. Importing this package or loading the plugin opens no connection.
"""
import base64
import csv
import hashlib
import io
import json
import socket
import time
import urllib.error
import urllib.request
from http.client import HTTPException

# The one place the version is set. pyproject.toml reads it from here, and the User-Agent carries it.
__version__ = "0.1.0"

DEFAULT_URL = "https://testdata-api.re-jam620.workers.dev"
USER_AGENT = "pytest-rowsmith/" + __version__
TOOL_HEADER = "pytest"
TIMEOUT_S = 30.0
FORMATS = ("csv", "json", "sql")
# Response headers kept in the cache beside the body bytes.
KEPT_HEADERS = ("content-type", "x-generator-version", "x-seed", "x-reproduce")
CACHE_PREFIX = "rowsmith/v1/"

__all__ = ["__version__", "Rowsmith", "RowsmithError", "RowsmithResult", "request_body", "DEFAULT_URL", "USER_AGENT"]


class RowsmithError(Exception):
    """A generate call that did not return data: an HTTP error from the service or a network failure.

    Attributes: ``status`` (int, or None when no HTTP answer arrived), ``error`` and ``next`` (the service's
    text, when it sent them) and ``reproduce`` (the X-Reproduce line when the service sent one, otherwise the
    request that was sent, in the same form).
    """

    def __init__(self, status, error, next_step, reproduce, url):
        self.status = status
        self.error = error
        self.next = next_step
        self.reproduce = reproduce
        self.url = url
        if status is None:
            head = "Rowsmith API call failed with no HTTP answer: %s" % (error or "network error")
        else:
            head = "Rowsmith API answered HTTP %d: %s" % (status, error or "(no error text)")
        parts = [head]
        if next_step:
            parts.append("Next: %s" % next_step)
        parts.append("Reproduce: %s" % reproduce)
        parts.append("URL: %s" % url)
        super().__init__("\n".join(parts))


class RowsmithResult:
    """The bytes and kept headers of one generate answer, from the network or from the cache."""

    def __init__(self, body, headers, request_body, from_cache, fmt):
        self.body = body  # bytes, exactly as the service sent them
        self.headers = dict(headers)  # lower-case names; only KEPT_HEADERS
        self.request_body = request_body  # the exact bytes sent (and hashed for the cache key)
        self.from_cache = from_cache
        self.format = fmt

    @property
    def text(self):
        return self.body.decode("utf-8")

    @property
    def sha256(self):
        return hashlib.sha256(self.body).hexdigest()

    @property
    def generator_version(self):
        return self.headers.get("x-generator-version")

    @property
    def seed(self):
        value = self.headers.get("x-seed")
        return int(value) if value is not None else None

    @property
    def reproduce(self):
        """The service's X-Reproduce line (CSV and SQL answers carry one; JSON answers do not, so for JSON
        this is the request that was sent, in the same form)."""
        return self.headers.get("x-reproduce") or _request_line(self.request_body)

    def parsed(self):
        """List of dicts for csv and json; the text itself for sql. CSV values are strings."""
        if self.format == "json":
            return json.loads(self.text)
        if self.format == "csv":
            return list(csv.DictReader(io.StringIO(self.text, newline="")))
        return self.text


def request_body(columns, rows=10, seed=1, format="json", table=None, version="1"):
    """The exact JSON bytes sent to POST /v1/generate. Key order is fixed, so the bytes (and the cache key,
    their sha256) depend only on the arguments."""
    if format not in FORMATS:
        raise ValueError("format must be one of %s, not %r" % (", ".join(FORMATS), format))
    if isinstance(seed, bool) or not isinstance(seed, int):
        raise TypeError("seed must be an int")
    if isinstance(rows, bool) or not isinstance(rows, int):
        raise TypeError("rows must be an int")
    if not isinstance(version, str) or not version:
        raise TypeError("version must be a non-empty string, e.g. \"1\"")
    body = {}
    if table is not None:
        body["table"] = table
    body["rows"] = rows
    body["seed"] = seed
    body["format"] = format
    body["version"] = version
    body["columns"] = list(columns)
    return json.dumps(body, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def _request_line(body):
    b64 = base64.urlsafe_b64encode(body).decode("ascii").rstrip("=")
    return "POST /v1/generate body-b64url=" + b64


class Rowsmith:
    """Client behind the ``rowsmith`` fixture.

    ``cache`` is any object with ``get(key, default)`` and ``set(key, value)`` taking JSON values, such as
    pytest's ``config.cache``; None keeps answers in memory for the life of the client only.
    """

    def __init__(self, base_url=DEFAULT_URL, cache=None, refresh=False, timeout=TIMEOUT_S, retry_delay=1.0):
        self.base_url = base_url.rstrip("/")
        self.cache = cache
        self.refresh = refresh
        self.timeout = timeout
        self.retry_delay = retry_delay
        self.network_calls = 0
        self._memory = {}

    def generate(self, columns, rows=10, seed=1, format="json", table=None, version="1"):
        """Rows for csv and json (a list of dicts), the SQL text for sql."""
        return self.fetch(columns, rows=rows, seed=seed, format=format, table=table, version=version).parsed()

    def fetch(self, columns, rows=10, seed=1, format="json", table=None, version="1"):
        """The full answer (bytes, headers, reproduce line) as a RowsmithResult."""
        body = request_body(columns, rows=rows, seed=seed, format=format, table=table, version=version)
        key = CACHE_PREFIX + hashlib.sha256(body).hexdigest()
        if key in self._memory:
            return self._memory[key]
        result = None if self.refresh else self._from_cache(key, body, format)
        if result is None:
            status, headers, data = self._post(body)
            kept = {h: headers[h] for h in KEPT_HEADERS if h in headers}
            result = RowsmithResult(data, kept, body, False, format)
            if self.cache is not None:
                self.cache.set(key, {
                    "body_b64": base64.b64encode(data).decode("ascii"),
                    "body_sha256": hashlib.sha256(data).hexdigest(),
                    "headers": kept,
                })
        self._memory[key] = result
        return result

    def _from_cache(self, key, body, fmt):
        if self.cache is None:
            return None
        entry = self.cache.get(key, None)
        if not isinstance(entry, dict):
            return None
        try:
            data = base64.b64decode(entry["body_b64"], validate=True)
            headers = dict(entry["headers"])
        except (KeyError, TypeError, ValueError):
            return None
        if hashlib.sha256(data).hexdigest() != entry.get("body_sha256"):
            return None
        return RowsmithResult(data, headers, body, True, fmt)

    def _post(self, body):
        url = self.base_url + "/v1/generate"
        attempts = 2  # no retry on 4xx; exactly one retry on a 5xx or a network error
        for attempt in range(attempts):
            last = attempt == attempts - 1
            req = urllib.request.Request(url, data=body, method="POST", headers={
                "Content-Type": "application/json",
                "Accept": "*/*",
                "User-Agent": USER_AGENT,
                "x-rowsmith-tool": TOOL_HEADER,
            })
            self.network_calls += 1
            try:
                with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                    headers = {k.lower(): v for k, v in resp.headers.items()}
                    return resp.status, headers, resp.read()
            except urllib.error.HTTPError as e:
                headers = {k.lower(): v for k, v in (e.headers or {}).items()}
                try:
                    raw = e.read()
                except (OSError, HTTPException):
                    raw = b""
                if e.code >= 500 and not last:
                    time.sleep(self.retry_delay)
                    continue
                raise self._http_error(e.code, headers, raw, body, url) from None
            except (urllib.error.URLError, socket.timeout, OSError, HTTPException) as e:
                if not last:
                    time.sleep(self.retry_delay)
                    continue
                reason = getattr(e, "reason", None) or e
                raise RowsmithError(None, "%s: %s" % (type(e).__name__, reason), None, _request_line(body), url) from None
        raise AssertionError("unreachable")

    @staticmethod
    def _http_error(status, headers, raw, body, url):
        error = nxt = None
        try:
            doc = json.loads(raw.decode("utf-8"))
            if isinstance(doc, dict):
                error = doc.get("error")
                nxt = doc.get("next")
        except (UnicodeDecodeError, ValueError):
            text = raw.decode("utf-8", "replace").strip()
            error = text[:300] if text else None
        if status == 429 and headers.get("retry-after"):
            nxt = (nxt + " " if nxt else "") + "(Retry-After: %s s)" % headers["retry-after"]
        reproduce = headers.get("x-reproduce") or _request_line(body)
        return RowsmithError(status, error, nxt, reproduce, url)
