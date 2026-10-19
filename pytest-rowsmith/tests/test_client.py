"""Offline tests of the client: request bytes and headers, parsing, cache, retries and error messages."""
import base64
import hashlib
import json
import pathlib
import socket

import pytest

import pytest_rowsmith
from pytest_rowsmith import Rowsmith, RowsmithError, request_body

from conftest import CSV_BODY, JSON_BODY, REPRODUCE, SQL_BODY

COLUMNS = [{"name": "id", "type": "sequence"}, {"name": "name", "type": "first_name"}]
ROOT = pathlib.Path(__file__).resolve().parent.parent


class DictCache:
    """Same get/set shape as pytest's config.cache, stored as JSON text like the real one."""

    def __init__(self):
        self.data = {}

    def get(self, key, default):
        return json.loads(self.data[key]) if key in self.data else default

    def set(self, key, value):
        self.data[key] = json.dumps(value)


def client(stub, **kw):
    kw.setdefault("retry_delay", 0)
    return Rowsmith(base_url=stub.url, **kw)


def test_version_is_pinned_once_and_sent_in_the_user_agent():
    assert pytest_rowsmith.__version__ == "0.2.0"
    assert pytest_rowsmith.USER_AGENT == "pytest-rowsmith/0.2.0"
    pyproject = (ROOT / "pyproject.toml").read_text(encoding="utf-8")
    assert 'version = { attr = "pytest_rowsmith.__version__" }' in pyproject
    assert 'dynamic = ["version"]' in pyproject


def test_request_body_and_headers(stub):
    rs = client(stub)
    rs.generate(COLUMNS, rows=3, seed=7, format="csv", table="people")
    (r,) = stub.requests
    assert r["path"] == "/v1/generate"
    assert r["body"] == request_body(COLUMNS, rows=3, seed=7, format="csv", table="people")
    assert r["body"] == (
        b'{"table":"people","rows":3,"seed":7,"format":"csv","version":"1",'
        b'"columns":[{"name":"id","type":"sequence"},{"name":"name","type":"first_name"}]}'
    )
    h = r["headers"]
    assert h["user-agent"] == "pytest-rowsmith/0.2.0"
    assert not h["user-agent"].startswith("Python-urllib")
    assert h["x-rowsmith-tool"] == "pytest"
    assert h["content-type"] == "application/json"


def test_seed_and_version_are_always_sent_with_deterministic_defaults(stub):
    client(stub).generate(COLUMNS)
    body = json.loads(stub.requests[0]["body"])
    assert body == {"rows": 10, "seed": 1, "format": "json", "version": "1", "columns": COLUMNS}
    assert "table" not in body


def test_csv_json_sql_parsing_and_raw_bytes(stub):
    rs = client(stub)
    assert rs.generate(COLUMNS, format="csv") == [{"id": "1", "name": "Ada"}, {"id": "2", "name": "Lovelace, A"}]
    assert rs.generate(COLUMNS, format="json") == [
        {"id": 1, "name": "Ada", "email": None},
        {"id": 2, "name": "Bo", "email": "bo@example.com"},
    ]
    assert rs.generate(COLUMNS, format="sql") == SQL_BODY.decode()
    res = rs.fetch(COLUMNS, format="csv")
    assert res.body == CSV_BODY
    assert res.sha256 == hashlib.sha256(CSV_BODY).hexdigest()
    assert res.generator_version == "1" and res.seed == 1
    assert res.reproduce == REPRODUCE
    assert rs.fetch(COLUMNS, format="json").body == JSON_BODY


def test_json_result_without_x_reproduce_gives_the_request_sent():
    body = request_body(COLUMNS)
    res = pytest_rowsmith.RowsmithResult(b"[]", {}, body, False, "json")
    assert res.reproduce == "POST /v1/generate body-b64url=" + base64.urlsafe_b64encode(body).decode().rstrip("=")


def test_bad_arguments_are_refused_before_any_call(stub):
    rs = client(stub)
    with pytest.raises(ValueError):
        rs.generate(COLUMNS, format="xml")
    with pytest.raises(TypeError):
        rs.generate(COLUMNS, seed="1")
    with pytest.raises(TypeError):
        rs.generate(COLUMNS, version=1)
    assert stub.requests == []


def test_cache_miss_then_hit_works_offline_and_keeps_the_reproduce_line(stub):
    cache = DictCache()
    first = client(stub, cache=cache).fetch(COLUMNS, format="csv")
    assert not first.from_cache
    assert len(stub.requests) == 1
    key = "rowsmith/v1/" + hashlib.sha256(request_body(COLUMNS, format="csv")).hexdigest()
    assert list(cache.data) == [key]
    stored = json.loads(cache.data[key])
    assert set(stored) == {"body_b64", "body_sha256", "headers"}
    assert set(stored["headers"]) == {"content-type", "x-generator-version", "x-seed", "x-reproduce"}

    offline = Rowsmith(base_url="http://127.0.0.1:9", cache=cache, retry_delay=0)
    hit = offline.fetch(COLUMNS, format="csv")
    assert hit.from_cache
    assert hit.body == CSV_BODY
    assert hit.reproduce == REPRODUCE
    assert offline.network_calls == 0
    assert len(stub.requests) == 1


def test_a_different_request_is_a_cache_miss(stub):
    cache = DictCache()
    rs = client(stub, cache=cache)
    rs.generate(COLUMNS, seed=1)
    rs.generate(COLUMNS, seed=2)
    rs.generate(COLUMNS, seed=1, version="2")
    assert len(stub.requests) == 3
    assert len(cache.data) == 3


def test_refresh_bypasses_the_cache_once_per_request_and_replaces_it(stub):
    cache = DictCache()
    client(stub, cache=cache).generate(COLUMNS, format="csv")
    stub.answer(200, b"id,name\r\n9,Zed\r\n", {"content-type": "text/csv", "x-reproduce": "POST /v1/generate body-b64url=bmV3"})
    rs = client(stub, cache=cache, refresh=True)
    assert rs.generate(COLUMNS, format="csv") == [{"id": "9", "name": "Zed"}]
    assert rs.generate(COLUMNS, format="csv") == [{"id": "9", "name": "Zed"}]
    assert len(stub.requests) == 2
    again = client(stub, cache=cache).fetch(COLUMNS, format="csv")
    assert again.from_cache and again.body == b"id,name\r\n9,Zed\r\n"
    assert again.reproduce == "POST /v1/generate body-b64url=bmV3"


def test_a_damaged_cache_entry_is_fetched_again(stub):
    cache = DictCache()
    client(stub, cache=cache).generate(COLUMNS)
    (key,) = cache.data
    entry = json.loads(cache.data[key])
    entry["body_b64"] = base64.b64encode(b"tampered").decode()
    cache.data[key] = json.dumps(entry)
    assert client(stub, cache=cache).fetch(COLUMNS).body == JSON_BODY
    assert len(stub.requests) == 2


def test_409_error_names_status_next_and_reproduce_without_retry(stub):
    stub.answer(409, json.dumps({"error": "Generator version 9 is not served.", "next": "Send version 1."}).encode(),
                {"content-type": "application/json"})
    with pytest.raises(RowsmithError) as ei:
        client(stub).generate(COLUMNS, version="9")
    e = ei.value
    msg = str(e)
    assert e.status == 409
    assert "HTTP 409" in msg
    assert "Generator version 9 is not served." in msg
    assert "Next: Send version 1." in msg
    sent = stub.requests[0]["body"]
    assert "Reproduce: POST /v1/generate body-b64url=" + base64.urlsafe_b64encode(sent).decode().rstrip("=") in msg
    assert len(stub.requests) == 1  # no retry on 4xx


def test_error_uses_the_services_x_reproduce_when_present(stub):
    stub.answer(400, b'{"error":"bad column","next":"See GET /v1/types."}', {"x-reproduce": REPRODUCE})
    with pytest.raises(RowsmithError) as ei:
        client(stub).generate(COLUMNS)
    assert "Reproduce: " + REPRODUCE in str(ei.value)
    assert "Next: See GET /v1/types." in str(ei.value)


def test_429_mentions_retry_after(stub):
    stub.answer(429, b'{"error":"Daily limit reached.","next":"Try tomorrow."}', {"retry-after": "3600"})
    with pytest.raises(RowsmithError) as ei:
        client(stub).generate(COLUMNS)
    assert "HTTP 429" in str(ei.value) and "Retry-After: 3600 s" in str(ei.value)
    assert len(stub.requests) == 1


def test_one_retry_on_5xx_then_success(stub):
    cache = DictCache()
    stub.answer(503, b'{"error":"busy"}')
    assert client(stub, cache=cache).generate(COLUMNS)[0]["name"] == "Ada"
    assert len(stub.requests) == 2
    assert len(cache.data) == 1


def test_exactly_one_retry_on_5xx_then_a_clear_failure_and_nothing_cached(stub):
    cache = DictCache()
    stub.answer(500, b'{"error":"boom"}')
    stub.answer(502, b"<html>bad gateway</html>")
    stub.answer(200, JSON_BODY)  # never reached
    with pytest.raises(RowsmithError) as ei:
        client(stub, cache=cache).generate(COLUMNS)
    assert ei.value.status == 502 and "HTTP 502" in str(ei.value)
    assert "Reproduce: POST /v1/generate body-b64url=" in str(ei.value)
    assert len(stub.requests) == 2
    assert cache.data == {}


def test_network_error_retries_once_then_fails_clearly():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()  # nothing listens on this port now
    rs = Rowsmith(base_url="http://127.0.0.1:%d" % port, retry_delay=0, timeout=5)
    with pytest.raises(RowsmithError) as ei:
        rs.generate(COLUMNS)
    assert ei.value.status is None
    assert "no HTTP answer" in str(ei.value)
    assert "Reproduce: POST /v1/generate body-b64url=" in str(ei.value)
    assert rs.network_calls == 2


def test_default_timeout_is_30_seconds():
    assert Rowsmith().timeout == 30.0


# A Pydantic-style export with real-looking values in example, examples, default, const and x-* keys.
SCHEMA = {
    "title": "User",
    "type": "object",
    "examples": [{"email": "jane.realperson@mail.example"}],
    "x-owner": "Janet Realperson",
    "properties": {
        "id": {"type": "string", "format": "uuid"},
        "email": {"anyOf": [{"type": "string", "format": "email"}, {"type": "null"}], "default": "jane.realperson@mail.example"},
        "default": {"type": "string", "const": "fixed", "x-faker": "name"},
        "tags": {"type": "array", "items": {"type": "string", "example": "vip"}},
    },
    "$defs": {"examples": {"type": "integer", "default": 3}},
}
SENT_SCHEMA = {
    "title": "User",
    "type": "object",
    "properties": {
        "id": {"type": "string", "format": "uuid"},
        "email": {"anyOf": [{"type": "string", "format": "email"}, {"type": "null"}]},
        "default": {"type": "string"},
        "tags": {"type": "array", "items": {"type": "string"}},
    },
    "$defs": {"examples": {"type": "integer"}},
}


def test_schema_is_sent_instead_of_columns_without_example_or_default_values(stub):
    before = json.dumps(SCHEMA)
    stub.answer(200, JSON_BODY, {"content-type": "application/json", "x-generator-version": "1", "x-seed": "4",
                                 "x-schema-version": "1", "x-schema-unmapped": "tags,address.zip"})
    res = client(stub).fetch(schema=SCHEMA, rows=2, seed=4)
    assert json.dumps(SCHEMA) == before  # the caller's dict is not changed
    (r,) = stub.requests
    assert json.loads(r["body"]) == {"rows": 2, "seed": 4, "format": "json", "version": "1", "schema": SENT_SCHEMA}
    assert r["body"] == request_body(schema=SCHEMA, rows=2, seed=4)
    for planted in (b"realperson", b"Realperson", b"vip", b"fixed", b"x-faker", b"x-owner"):
        assert planted not in r["body"]
    assert res.schema_unmapped == ["tags", "address.zip"]
    assert res.headers["x-schema-version"] == "1"
    # A JSON answer carries no X-Reproduce, so the reproduce line is the request sent: without the planted values.
    assert b"realperson" not in base64.urlsafe_b64decode(res.reproduce.split("=", 1)[1] + "==")
    assert client(stub).fetch(COLUMNS).schema_unmapped == []


def test_schema_requests_are_cached_by_the_sent_bytes(stub):
    cache = DictCache()
    first = client(stub, cache=cache).generate(schema=SCHEMA, format="csv")
    key = "rowsmith/v1/" + hashlib.sha256(request_body(schema=SCHEMA, format="csv")).hexdigest()
    assert list(cache.data) == [key]
    offline = Rowsmith(base_url="http://127.0.0.1:9", cache=cache, retry_delay=0)
    assert offline.generate(schema=SCHEMA, format="csv") == first
    assert offline.network_calls == 0


def test_exactly_one_of_columns_and_schema_before_any_call(stub):
    rs = client(stub)
    with pytest.raises(ValueError):
        rs.generate()
    with pytest.raises(ValueError):
        rs.generate(COLUMNS, schema=SCHEMA)
    with pytest.raises(TypeError):
        rs.generate(schema="CREATE TABLE t (id int)")
    assert stub.requests == []


FIXTURE = json.loads((ROOT / "tests" / "fixtures" / "openapi_closure.json").read_text(encoding="utf-8"))


def test_openapi_component_sends_only_its_ref_closure_shared_fixture(stub):
    from pytest_rowsmith import minimal_openapi, strip_examples

    closure = minimal_openapi(strip_examples(FIXTURE["input"]))
    # Same bytes as the shared fixture's expected closure (key order included), which the vitest suite runs
    # through the Worker against the full document for byte-identical output.
    assert json.dumps(closure) == json.dumps(FIXTURE["expected"])
    client(stub).generate(schema=FIXTURE["input"], rows=2)
    body = stub.requests[0]["body"]
    assert json.dumps(json.loads(body)["schema"]) == json.dumps(FIXTURE["expected"])
    for gone in (b"paths", b"servers", b"security", b"info", b"Unused", b"Secret", b"realperson"):
        assert gone not in body


def test_openapi_closure_ends_on_cycles():
    from pytest_rowsmith import minimal_openapi

    schemas = {
        "S%d" % i: {"type": "object", "properties": {"next": {"$ref": "#/components/schemas/S%d" % ((i + 1) % 200)},
                                                     "self": {"$ref": "#/components/schemas/S%d" % i}}}
        for i in range(200)
    }
    r = minimal_openapi({"openapi": {"openapi": "3.1.0", "paths": {"/x": {}}, "components": {"schemas": schemas}}, "component": "S5"})
    assert len(r["openapi"]["components"]["schemas"]) == 200
    assert list(r["openapi"]) == ["openapi", "components"]
    assert minimal_openapi({"type": "object"}) == {"type": "object"}
