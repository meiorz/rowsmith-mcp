"""Refresh the dbt seeds from Rowsmith (Python standard library only; Python 3.9 or later).

POSTs request.json to /v1/dataset in JSON form and writes, under seeds/:
  customers.csv, orders.csv   one CSV per table (format below)
  manifest.json               the request, X-Request-SHA256, X-Output-SHA256, the per-table X-Dataset-Rows-SHA256
                              and the sha256 of each CSV

The service answers SQL or JSON, not CSV, so this script converts the JSON rows. The CSV format, which
test/dbt-seeds.test.ts implements byte for byte in TypeScript:
  - UTF-8 without a BOM; every line ends with LF ("\\n"), the last one included.
  - The first line is the column names in the order of the request's columns.
  - Then one line per row, in the order of the response's rows, fields in the same column order, joined by ",".
  - A field is: null -> empty; true/false -> true/false; a number -> its JSON text exactly as the response wrote it
    (the decimal 12.5 stays 12.5, never 12.50); a string -> itself; the empty string -> "".
  - A field (or column name) that contains a comma, a double quote, CR or LF is wrapped in double quotes, with each
    double quote inside doubled (RFC 4180). No other field is quoted.

Before writing anything it checks the response against its own headers: X-Output-SHA256 against the body and each
table's X-Dataset-Rows-SHA256 against its rows. Set ROWSMITH_URL to use another base URL.
"""
import hashlib
import json
import os
import pathlib
import sys
import urllib.error
import urllib.request

VERSION = "0.1.0"
HERE = pathlib.Path(__file__).resolve().parent
DEFAULT_URL = "https://testdata-api.re-jam620.workers.dev"
NOTE = ("Rowsmith's answer to request.json (POST /v1/dataset, JSON form), converted to one CSV per table by "
        "fetch_seeds.py; test/dbt-seeds.test.ts checks these files against the handler.")


class _Num(str):
    """A JSON number kept as the exact text the response wrote."""


def _loads(raw):
    return json.loads(raw, parse_int=_Num, parse_float=_Num)


def _field(v):
    if v is None:
        return ""
    if v is True:
        return "true"
    if v is False:
        return "false"
    if isinstance(v, _Num):
        return str(v)
    if isinstance(v, str):
        if v == "":
            return '""'
        if any(ch in v for ch in ',"\r\n'):
            return '"' + v.replace('"', '""') + '"'
        return v
    raise ValueError(f"unexpected value in a row: {v!r}")


def to_csv(columns, rows):
    """columns: names in request order; rows: the response's row objects. Returns the CSV bytes."""
    lines = [",".join(_field(c) for c in columns)]
    for row in rows:
        lines.append(",".join(_field(row[c]) for c in columns))
    return ("\n".join(lines) + "\n").encode("utf-8")


def _js_json(v):
    """JSON.stringify of a value, for the row hash: numbers as their response text, strings as JavaScript escapes them."""
    if v is None:
        return "null"
    if v is True:
        return "true"
    if v is False:
        return "false"
    if isinstance(v, _Num):
        return str(v)
    if isinstance(v, str):
        return json.dumps(v, ensure_ascii=False)
    if isinstance(v, list):
        return "[" + ",".join(_js_json(x) for x in v) + "]"
    raise ValueError(f"unexpected value in a row: {v!r}")


def _sha(b):
    return hashlib.sha256(b).hexdigest()


def request_body(request):
    return json.dumps(request, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def convert(request, body, headers):
    """Pure: the response body (bytes) and headers (lowercase names) -> {file name: bytes} for seeds/."""
    want = headers.get("x-output-sha256")
    if want is not None and _sha(body) != want:
        raise ValueError("the body does not match its X-Output-SHA256")
    hashes = dict(p.split("=", 1) for p in headers["x-dataset-rows-sha256"].split(","))
    tables = _loads(body.decode("utf-8"))["tables"]
    files, seeds = {}, {}
    for t in request["tables"]:
        name, columns = t["name"], [c["name"] for c in t["columns"]]
        rows = tables[name]
        if len(rows) != t["rows"]:
            raise ValueError(f"{name}: {len(rows)} rows, the request asked for {t['rows']}")
        as_arrays = _js_json([[row[c] for c in columns] for row in rows]).encode("utf-8")
        if _sha(as_arrays) != hashes[name]:
            raise ValueError(f"{name}: the rows do not match X-Dataset-Rows-SHA256")
        files[name + ".csv"] = to_csv(columns, rows)
        seeds[name + ".csv"] = _sha(files[name + ".csv"])
    manifest = {
        "note": NOTE,
        "request": request,
        "x-generator-version": headers["x-generator-version"],
        "x-dataset-version": headers["x-dataset-version"],
        "x-request-sha256": headers["x-request-sha256"],
        "x-output-sha256": want,
        "x-dataset-rows-sha256": {t["name"]: hashes[t["name"]] for t in request["tables"]},
        "seeds-sha256": seeds,
    }
    files["manifest.json"] = (json.dumps(manifest, indent=2, ensure_ascii=False) + "\n").encode("utf-8")
    return files


def fetch(base, request):
    req = urllib.request.Request(
        base.rstrip("/") + "/v1/dataset",
        data=request_body(request),
        headers={
            "content-type": "application/json",
            "accept": "application/json",
            "user-agent": f"rowsmith-dbt/{VERSION}",
            "x-rowsmith-tool": "dbt",
        },
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        return resp.read(), {k.lower(): v for k, v in resp.headers.items()}


def main():
    request = json.loads((HERE / "request.json").read_text(encoding="utf-8"))
    base = os.environ.get("ROWSMITH_URL") or DEFAULT_URL
    try:
        body, headers = fetch(base, request)
    except urllib.error.HTTPError as e:
        print(f"fetch_seeds: HTTP {e.code}: {e.read().decode('utf-8', 'replace')}", file=sys.stderr)
        return 1
    files = convert(request, body, headers)
    out = HERE / "seeds"
    out.mkdir(exist_ok=True)
    for name, data in files.items():
        (out / name).write_bytes(data)
        print(f"wrote seeds/{name} ({len(data)} bytes, sha256 {_sha(data)})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
