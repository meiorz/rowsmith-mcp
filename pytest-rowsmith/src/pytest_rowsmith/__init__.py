"""pytest-rowsmith: reproducible fake test data from the Rowsmith API, cached for offline test runs.

The client sends schemas only (column definitions, or a JSON Schema without its example and default values),
never data. It uses the standard library alone (urllib),
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
KEPT_HEADERS = ("content-type", "x-generator-version", "x-seed", "x-reproduce", "x-schema-version", "x-schema-unmapped",
                "x-request-sha256", "x-output-sha256")
# Schema keys whose values are examples or defaults: removed before a schema is sent (the service ignores them too).
# Keys directly inside these maps are property or schema names, and are kept.
EXAMPLE_KEYS = frozenset(("example", "examples", "default", "const"))
NAME_MAPS = frozenset(("properties", "patternProperties", "$defs", "definitions", "schemas", "dependentSchemas"))
CACHE_PREFIX = "rowsmith/v1/"

MANIFEST_VERSION = 1

__all__ = ["__version__", "Rowsmith", "RowsmithError", "RowsmithResult", "request_body", "assert_golden", "manifest_entry",
           "DEFAULT_URL", "USER_AGENT", "MANIFEST_VERSION"]


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
    def output_sha256(self):
        """The service's X-Output-SHA256 (sha256 of the body bytes); without that header, the same hash computed
        here from the body bytes."""
        return self.headers.get("x-output-sha256") or self.sha256

    @property
    def request_sha256(self):
        """The service's X-Request-SHA256: the sha256 of the canonical request that X-Reproduce encodes (defaults
        filled in, version pinned; for a schema request, the mapped columns). Without that header, the sha256 of the
        body in a body-b64url X-Reproduce line (the exact bytes); otherwise None (run once with --rowsmith-refresh)."""
        value = self.headers.get("x-request-sha256")
        if value:
            return value
        line = self.headers.get("x-reproduce") or ""
        if line.startswith("POST /v1/generate body-b64url="):
            b64 = line.split("=", 1)[1]
            return hashlib.sha256(base64.urlsafe_b64decode(b64 + "=" * (-len(b64) % 4))).hexdigest()
        return None

    @property
    def schema_version(self):
        """X-Schema-Version for a schema request; None for a columns request."""
        return self.headers.get("x-schema-version")

    @property
    def generator_version(self):
        return self.headers.get("x-generator-version")

    @property
    def seed(self):
        value = self.headers.get("x-seed")
        return int(value) if value is not None else None

    @property
    def schema_unmapped(self):
        """For a schema request: the paths of the properties the service could not map (X-Schema-Unmapped),
        e.g. ["tags", "address.zip"]; an empty list when every property mapped or for a columns request."""
        value = self.headers.get("x-schema-unmapped")
        return value.split(",") if value else []

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


def _self_contained(result):
    """A reproduce line that regenerates the bytes by itself: X-Reproduce when it carries the body, otherwise the
    request this client sent (version pinned too, so it regenerates the same bytes or is refused with 409)."""
    line = result.headers.get("x-reproduce") or ""
    return line if line.startswith("POST /v1/generate body-b64url=") else _request_line(result.request_body)


def manifest_entry(result, name):
    """One golden-manifest entry for a RowsmithResult: a dict with name, request_sha256, output_sha256,
    output_version, schema_version (None for a columns request) and reproduce. Collect entries as
    {"rowsmith_manifest": 1, "entries": [...]} and keep the file beside your eval."""
    if not isinstance(name, str) or not name:
        raise TypeError("name must be a non-empty string, e.g. \"orders-v1\"")
    request_sha256 = result.request_sha256
    if request_sha256 is None:
        raise ValueError("this answer has no request sha256 (no X-Request-SHA256 header and no body-b64url X-Reproduce line); run once with --rowsmith-refresh")
    return {
        "name": name,
        "request_sha256": request_sha256,
        "output_sha256": result.sha256,
        "output_version": result.generator_version,
        "schema_version": result.schema_version,
        "reproduce": _self_contained(result),
    }


def assert_golden(result, expected):
    """Fails (AssertionError) unless the sha256 of result's body bytes is ``expected``: a hex string, or a manifest
    entry dict (whose request_sha256 must then match too). The message names both hashes and the reproduce line."""
    __tracebackhide__ = True
    entry = expected if isinstance(expected, dict) else {"output_sha256": expected}
    want = entry.get("output_sha256")
    if not isinstance(want, str) or len(want) != 64:
        raise TypeError("expected must be a 64-character sha256 hex string or a manifest entry")
    label = " (%s)" % entry["name"] if entry.get("name") else ""
    lines = []
    if entry.get("request_sha256") and entry["request_sha256"] != result.request_sha256:
        lines.append("Rowsmith request differs from the golden entry%s: expected request sha256 %s, got %s."
                     % (label, entry["request_sha256"], result.request_sha256))
    if result.sha256 != want.lower():
        lines.append("Rowsmith output differs from the golden entry%s: expected output sha256 %s, got %s "
                     "(output version %s, schema version %s, %s)."
                     % (label, want, result.sha256, result.generator_version, result.schema_version or "none",
                        "from the cache" if result.from_cache else "from the service"))
    if lines:
        lines.append("Reproduce: %s" % _self_contained(result))
        raise AssertionError("\n".join(lines))


def strip_examples(value, names=False):
    """A copy of a JSON Schema without example, examples, default, const and x-* keys (their values never leave
    this machine). Keys directly inside properties, $defs, definitions and components.schemas are names, and kept."""
    if isinstance(value, list):
        return [strip_examples(v) for v in value]
    if not isinstance(value, dict):
        return value
    out = {}
    for k, v in value.items():
        if not names and (k in EXAMPLE_KEYS or (isinstance(k, str) and k.startswith("x-"))):
            continue
        out[k] = strip_examples(v, not names and k in NAME_MAPS)
    return out


def _ref_target(ref):
    """Mirrors Doc.lookup in the service (src/schemain.ts): (container, name) for a local $ref, else None.
    #/$defs/X and #/definitions/X are read from the document root, #/components/schemas/X from
    components.schemas; parts are unescaped (~1 is /, ~0 is ~) after splitting on /; refs over 512 UTF-16 units
    are not followed."""
    if not isinstance(ref, str) or not ref.startswith("#/") or len(ref.encode("utf-16-le")) // 2 > 512:
        return None
    parts = [p.replace("~1", "/").replace("~0", "~") for p in ref[2:].split("/")]
    if len(parts) == 2 and parts[0] in ("$defs", "definitions"):
        return parts[0], parts[1]
    if len(parts) == 3 and parts[0] == "components" and parts[1] == "schemas":
        return "components", parts[2]
    return None


def minimal_openapi(schema):
    """For {"openapi": <document>, "component": <name>}: the same wrapper holding only the named component and the
    schemas it reaches through local $refs (the forms the service follows), transitively and each once, so cycles
    end. Kept schemas keep their names and paths and the document's order; paths, servers, security, info and
    unreached schemas are not sent. Applied after strip_examples, so a $ref inside an example, default, const or
    x-* value is never followed. A missing or non-local ref is not followed (the service reports it unmapped, as
    with the full document). Any other input is returned as is."""
    if not isinstance(schema, dict) or not isinstance(schema.get("component"), str) or not isinstance(schema.get("openapi"), dict):
        return schema
    if any(k not in ("openapi", "component") for k in schema):
        return schema  # the service refuses it
    doc = schema["openapi"]
    comps = doc.get("components")
    containers = {
        "components": comps["schemas"] if isinstance(comps, dict) and isinstance(comps.get("schemas"), dict) else None,
        "$defs": doc["$defs"] if isinstance(doc.get("$defs"), dict) else None,
        "definitions": doc["definitions"] if isinstance(doc.get("definitions"), dict) else None,
    }
    reached = {"components": set(), "$defs": set(), "definitions": set()}
    todo = [("components", schema["component"])]
    while todo:
        where, name = todo.pop()
        container = containers[where]
        if container is None or name in reached[where]:
            continue
        target = container.get(name)
        if not isinstance(target, dict):
            continue  # missing: left for the service to report
        reached[where].add(name)
        stack = [target]
        while stack:
            v = stack.pop()
            if isinstance(v, list):
                stack.extend(v)
            elif isinstance(v, dict):
                for k, x in v.items():
                    t = _ref_target(x) if k == "$ref" else None
                    if t:
                        todo.append(t)
                    else:
                        stack.append(x)

    def keep(where):
        return {n: s for n, s in (containers[where] or {}).items() if n in reached[where]}

    out = {}
    if "openapi" in doc:
        out["openapi"] = doc["openapi"]
    out["components"] = {"schemas": keep("components")}
    if reached["$defs"]:
        out["$defs"] = keep("$defs")
    if reached["definitions"]:
        out["definitions"] = keep("definitions")
    return {"openapi": out, "component": schema["component"]}


def request_body(columns=None, rows=10, seed=1, format="json", table=None, version="1", schema=None):
    """The exact JSON bytes sent to POST /v1/generate. Key order is fixed, so the bytes (and the cache key,
    their sha256) depend only on the arguments. Pass exactly one of ``columns`` (the column grammar) and
    ``schema`` (a JSON Schema dict, e.g. a Pydantic ``model_json_schema()`` or Zod export, or
    ``{"openapi": <document>, "component": "<name>"}``)."""
    if (columns is None) == (schema is None):
        raise ValueError("pass exactly one of columns and schema")
    if schema is not None and not isinstance(schema, dict):
        raise TypeError("schema must be a dict (a JSON Schema object)")
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
    if schema is not None:
        body["schema"] = minimal_openapi(strip_examples(schema))
    else:
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

    # The golden-manifest helpers, on the fixture too: rowsmith.assert_golden(...), rowsmith.manifest_entry(...).
    assert_golden = staticmethod(assert_golden)
    manifest_entry = staticmethod(manifest_entry)

    def generate(self, columns=None, rows=10, seed=1, format="json", table=None, version="1", schema=None):
        """Rows for csv and json (a list of dicts), the SQL text for sql. Pass columns or schema."""
        return self.fetch(columns, rows=rows, seed=seed, format=format, table=table, version=version, schema=schema).parsed()

    def fetch(self, columns=None, rows=10, seed=1, format="json", table=None, version="1", schema=None):
        """The full answer (bytes, headers, reproduce line) as a RowsmithResult. Pass columns or schema."""
        body = request_body(columns, rows=rows, seed=seed, format=format, table=table, version=version, schema=schema)
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
