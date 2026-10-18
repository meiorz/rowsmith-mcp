"""Offline tests of the golden-manifest helpers: output_sha256 / request_sha256, the cache keeping them,
assert_golden and manifest_entry, on the client and through the fixture."""
import base64
import hashlib
import json

import pytest

import pytest_rowsmith
from pytest_rowsmith import Rowsmith, RowsmithResult, assert_golden, manifest_entry, request_body

from conftest import CSV_BODY, JSON_BODY, REPRODUCE
from test_client import COLUMNS, DictCache, client

REQ_SHA = "a" * 64
OUT_SHA = hashlib.sha256(CSV_BODY).hexdigest()
HASHED = {"content-type": "text/csv", "x-generator-version": "1", "x-seed": "1", "x-reproduce": REPRODUCE,
          "x-request-sha256": REQ_SHA, "x-output-sha256": OUT_SHA}
INNER_ARGS = ("-p", "pytest_rowsmith.plugin")


def test_the_headers_are_exposed_and_kept_in_the_cache_for_offline_hits(stub):
    cache = DictCache()
    stub.answer(200, CSV_BODY, HASHED)
    first = client(stub, cache=cache).fetch(COLUMNS, format="csv")
    assert (first.request_sha256, first.output_sha256) == (REQ_SHA, OUT_SHA)
    (stored,) = [json.loads(v) for v in cache.data.values()]
    assert stored["headers"]["x-request-sha256"] == REQ_SHA and stored["headers"]["x-output-sha256"] == OUT_SHA
    hit = Rowsmith(base_url="http://127.0.0.1:9", cache=cache, retry_delay=0).fetch(COLUMNS, format="csv")
    assert hit.from_cache and (hit.request_sha256, hit.output_sha256) == (REQ_SHA, OUT_SHA)


def test_without_the_headers_only_exact_sources_are_used():
    # output_sha256: from the body bytes. request_sha256: the sha256 of the body in a body-b64url X-Reproduce ...
    canonical = b'{"table":"data","rows":10,"seed":1,"format":"csv","columns":[{"name":"id","type":"uuid"}],"version":"1"}'
    line = "POST /v1/generate body-b64url=" + base64.urlsafe_b64encode(canonical).decode().rstrip("=")
    res = RowsmithResult(CSV_BODY, {"x-reproduce": line}, request_body(COLUMNS, format="csv"), True, "csv")
    assert res.output_sha256 == OUT_SHA
    assert res.request_sha256 == hashlib.sha256(canonical).hexdigest()
    # ... otherwise None, never re-derived from the request: a body-sha256 line, or a JSON answer (no X-Reproduce).
    for headers, body, fmt in (({"x-reproduce": "POST /v1/generate body-sha256=" + "b" * 64}, CSV_BODY, "csv"),
                               ({}, JSON_BODY, "json")):
        res = RowsmithResult(body, headers, request_body(COLUMNS, format=fmt), True, fmt)
        assert res.request_sha256 is None
        with pytest.raises(ValueError, match="--rowsmith-refresh"):
            manifest_entry(res, "x")


def test_assert_golden_passes_and_fails_with_both_hashes_and_the_reproduce_line():
    res = RowsmithResult(CSV_BODY, HASHED, request_body(COLUMNS, format="csv"), True, "csv")
    assert_golden(res, OUT_SHA)
    assert_golden(res, OUT_SHA.upper())
    assert_golden(res, manifest_entry(res, "orders-v1"))
    with pytest.raises(AssertionError) as ei:
        assert_golden(res, "0" * 64)
    msg = str(ei.value)
    assert "expected output sha256 " + "0" * 64 + ", got " + OUT_SHA in msg
    assert "output version 1, schema version none, from the cache" in msg
    assert msg.splitlines()[-1] == "Reproduce: " + REPRODUCE
    with pytest.raises(AssertionError) as ei:
        assert_golden(res, dict(manifest_entry(res, "orders-v1"), request_sha256="c" * 64))
    assert "request differs from the golden entry (orders-v1): expected request sha256 " + "c" * 64 in str(ei.value)
    with pytest.raises(TypeError):
        assert_golden(res, "abc")


def test_manifest_entry_shape_and_a_reproduce_line_that_stands_alone():
    sent = request_body(COLUMNS, format="csv")
    res = RowsmithResult(CSV_BODY, HASHED, sent, False, "csv")
    assert manifest_entry(res, "orders-v1") == {
        "name": "orders-v1", "request_sha256": REQ_SHA, "output_sha256": OUT_SHA, "output_version": "1",
        "schema_version": None, "reproduce": REPRODUCE,
    }
    # A JSON answer has no X-Reproduce, and the body-sha256 form does not carry the body: the request sent instead.
    mine = "POST /v1/generate body-b64url=" + base64.urlsafe_b64encode(sent).decode().rstrip("=")
    for headers in ({"x-generator-version": "1", "x-request-sha256": REQ_SHA},
                    dict(HASHED, **{"x-reproduce": "POST /v1/generate body-sha256=" + REQ_SHA})):
        assert manifest_entry(RowsmithResult(CSV_BODY, headers, sent, False, "csv"), "n")["reproduce"] == mine
    schema = RowsmithResult(CSV_BODY, dict(HASHED, **{"x-schema-version": "1"}), sent, False, "csv")
    assert manifest_entry(schema, "n")["schema_version"] == "1"
    with pytest.raises(TypeError):
        manifest_entry(res, "")
    assert pytest_rowsmith.MANIFEST_VERSION == 1


INNER = """
import json, pytest

COLUMNS = [{"name": "id", "type": "sequence"}]

def test_pass(rowsmith):
    result = rowsmith.fetch(COLUMNS, rows=2, seed=3, format="csv")
    entry = rowsmith.manifest_entry(result, "people-v1")
    assert json.loads(json.dumps(entry)) == entry
    rowsmith.assert_golden(result, entry)

def test_drift(rowsmith):
    rowsmith.assert_golden(rowsmith.fetch(COLUMNS, rows=2, seed=3, format="csv"), "0" * 64)
"""


def test_through_the_fixture_a_drift_fails_with_a_clear_message(pytester, stub, monkeypatch):
    monkeypatch.setenv("PYTEST_DISABLE_PLUGIN_AUTOLOAD", "1")
    monkeypatch.setenv("ROWSMITH_URL", stub.url)
    pytester.makepyfile(INNER)
    out = pytester.runpytest(*INNER_ARGS)
    out.assert_outcomes(passed=1, failed=1)
    out.stdout.fnmatch_lines(["*Rowsmith output differs from the golden entry: expected output sha256 " + "0" * 64 + "*",
                              "*Reproduce: " + REPRODUCE + "*"])
    assert len(stub.requests) == 1
