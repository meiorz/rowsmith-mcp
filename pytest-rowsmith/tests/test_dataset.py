"""Offline tests of related tables in one call: rowsmith.dataset() and rowsmith.sqlite(), against the stub. The
stub answers with the Worker's real bytes for the documented example (tests/fixtures/dataset_example.json, which
the service's test suite checks against the handler)."""
import hashlib
import json
import pathlib
import sqlite3

import pytest

from pytest_rowsmith import Rowsmith, RowsmithError, build_sqlite, dataset_body

FIXTURE = json.loads((pathlib.Path(__file__).parent / "fixtures" / "dataset_example.json").read_text(encoding="utf-8"))
TABLES = FIXTURE["request"]["tables"]


class DictCache:
    def __init__(self):
        self.data = {}

    def get(self, key, default):
        return json.loads(self.data[key]) if key in self.data else default

    def set(self, key, value):
        self.data[key] = json.dumps(value)


def answer(stub, fmt):
    stub.answer(200, FIXTURE[fmt]["body"].encode("utf-8"), FIXTURE[fmt]["headers"])


def client(stub, **kw):
    kw.setdefault("retry_delay", 0)
    return Rowsmith(base_url=stub.url, **kw)


def test_dataset_body_bytes_are_fixed_and_schemas_are_cleaned():
    assert dataset_body(TABLES, seed=42) == (
        b'{"seed":42,"format":"sql","version":"1","dataset_version":"1","tables":' + json.dumps(TABLES, separators=(",", ":")).encode() + b"}"
    )
    body = json.loads(dataset_body([{"name": "u", "schema": {"type": "object", "properties": {"e": {"type": "string", "examples": ["planted"]}}}}]))
    assert body["tables"][0]["schema"] == {"type": "object", "properties": {"e": {"type": "string"}}}
    for bad, err in (([], TypeError), (["x"], TypeError)):
        with pytest.raises(err):
            dataset_body(bad)
    with pytest.raises(ValueError):
        dataset_body(TABLES, format="csv")


def test_dataset_posts_to_v1_dataset_and_returns_the_tables_with_matching_keys(stub):
    answer(stub, "json")
    rs = client(stub)
    tables = rs.dataset(TABLES, seed=42)
    (r,) = stub.requests
    assert r["path"] == "/v1/dataset"
    assert r["body"] == dataset_body(TABLES, seed=42, format="json")
    assert r["headers"]["x-rowsmith-tool"] == "pytest"
    assert list(tables) == ["customers", "orders"]
    ids = {c["id"] for c in tables["customers"]}
    assert len(tables["orders"]) == 5
    assert all(o["customer_id"] in ids for o in tables["orders"])
    assert rs.dataset(TABLES, seed=42) == tables
    assert len(stub.requests) == 1  # answered from memory


def test_rows_sha256_is_the_same_for_sql_and_json_and_matches_the_json_rows(stub):
    rs = client(stub)
    answer(stub, "sql")
    answer(stub, "json")
    sql = rs.fetch_dataset(TABLES, seed=42, format="sql")
    js = rs.fetch_dataset(TABLES, seed=42, format="json")
    assert sql.rows_sha256 == js.rows_sha256
    assert list(sql.rows_sha256) == ["customers", "orders"]
    for name, rows in js.parsed()["tables"].items():
        canonical = json.dumps([list(r.values()) for r in rows], separators=(",", ":"), ensure_ascii=False)
        assert hashlib.sha256(canonical.encode("utf-8")).hexdigest() == sql.rows_sha256[name]
    assert sql.dataset_version == "1"
    assert sql.reproduce.startswith("POST /v1/dataset body-b64url=")
    assert sql.request_sha256 == FIXTURE["sql"]["headers"]["x-request-sha256"]
    assert sql.output_sha256 == sql.sha256


def test_sqlite_builds_a_new_file_with_foreign_keys_enforced_and_caches_the_sql(stub, tmp_path):
    answer(stub, "sql")
    cache = DictCache()
    made = []

    def tmp_dir():
        d = tmp_path / ("d%d" % len(made))
        d.mkdir()
        made.append(d)
        return d

    rs = client(stub, cache=cache, tmp_dir=tmp_dir)
    path = rs.sqlite(TABLES, seed=42)
    assert path.parent == made[0] and path.suffix == ".sqlite"
    con = sqlite3.connect(str(path))
    try:
        assert con.execute("SELECT COUNT(*) FROM customers").fetchone()[0] == 3
        assert con.execute("SELECT COUNT(*) FROM orders WHERE customer_id NOT IN (SELECT id FROM customers)").fetchone()[0] == 0
        con.execute("PRAGMA foreign_keys = ON")
        with pytest.raises(sqlite3.IntegrityError):
            con.execute("INSERT INTO orders (id, customer_id, total) VALUES (99, 'nope', 1)")
    finally:
        con.close()
    again = rs.sqlite(TABLES, seed=42)
    assert again != path and again.exists()
    assert len(stub.requests) == 1
    # A new client (a new session) is answered from the cache, offline.
    stub.server.shutdown()
    stub.server.server_close()
    offline = client(stub, cache=cache, tmp_dir=tmp_dir).sqlite(TABLES, seed=42)
    assert offline.exists()
    assert all(k.startswith("rowsmith/dataset/v1/") for k in cache.data)


def test_sqlite_honours_path_and_refuses_an_existing_file(stub, tmp_path):
    answer(stub, "sql")
    rs = client(stub)
    target = tmp_path / "shop.sqlite"
    assert rs.sqlite(TABLES, seed=42, path=target) == target
    with pytest.raises(FileExistsError):
        rs.sqlite(TABLES, seed=42, path=target)


def test_build_sqlite_reports_broken_foreign_keys(tmp_path):
    sql = ('CREATE TABLE "a" ("id" TEXT NOT NULL, PRIMARY KEY ("id"));\n'
           'CREATE TABLE "b" ("a_id" TEXT, FOREIGN KEY ("a_id") REFERENCES "a" ("id"));\n'
           "PRAGMA foreign_keys = OFF;\nINSERT INTO \"b\" (\"a_id\") VALUES ('x');\n")
    with pytest.raises(AssertionError, match="foreign keys do not hold"):
        build_sqlite(sql, tmp_path / "x.sqlite")


def test_a_refusal_names_the_dataset_request(stub):
    stub.answer(400, json.dumps({"error": "tables[0].columns[1] refers to table customers, which comes later in tables.",
                                 "next": "Refs go only to earlier tables: move customers before orders in tables."}).encode())
    with pytest.raises(RowsmithError) as e:
        client(stub).dataset(list(reversed(TABLES)), seed=42)
    assert e.value.status == 400
    assert "comes later" in e.value.error
    assert e.value.reproduce.startswith("POST /v1/dataset body-b64url=")
    assert e.value.url.endswith("/v1/dataset")


INNER = """
import sqlite3

def test_shop(rowsmith):
    tables = %r
    path = rowsmith.sqlite(tables, seed=42)
    assert path.name.endswith(".sqlite")
    con = sqlite3.connect(str(path))
    assert con.execute("SELECT COUNT(*) FROM orders").fetchone()[0] == 5
    con.close()
""" % (TABLES,)


def test_the_fixture_builds_sqlite_files_in_pytests_tmp_path_and_caches_the_sql(pytester, stub, monkeypatch):
    monkeypatch.setenv("PYTEST_DISABLE_PLUGIN_AUTOLOAD", "1")
    monkeypatch.setenv("ROWSMITH_URL", stub.url)
    answer(stub, "sql")
    pytester.makepyfile(INNER)
    base = pytester.path / "tmpbase"
    pytester.runpytest("-p", "pytest_rowsmith.plugin", "--basetemp", str(base)).assert_outcomes(passed=1)
    assert len(stub.requests) == 1 and stub.requests[0]["path"] == "/v1/dataset"
    assert list(base.glob("rowsmith*/rowsmith-*.sqlite"))
    assert list((pytester.path / ".pytest_cache" / "v" / "rowsmith" / "dataset" / "v1").iterdir())
    stub.server.shutdown()
    stub.server.server_close()
    pytester.runpytest("-p", "pytest_rowsmith.plugin", "--basetemp", str(base)).assert_outcomes(passed=1)  # offline


def test_the_readme_example_runs_against_the_fixture(stub, tmp_path):
    readme = (pathlib.Path(__file__).resolve().parent.parent / "README.md").read_text(encoding="utf-8")
    start = readme.index("```python\nimport sqlite3\n\nSHOP = [")
    code = readme[start + len("```python\n"):readme.index("```", start + 10)]
    ns = {}
    exec(compile(code, "README.md", "exec"), ns)
    assert ns["SHOP"] == TABLES
    answer(stub, "sql")
    d = tmp_path / "r"
    d.mkdir()
    ns["test_orders_join_customers"](client(stub, tmp_dir=lambda: d))
