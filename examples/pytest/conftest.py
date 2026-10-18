"""A pytest fixture that loads reproducible fake orders from Rowsmith.

The CSV is cached under .fixtures/ keyed by the request, so the API is called once per schema and seed.
The same schema and seed give byte-identical output for the same generator version.
"""
import csv
import hashlib
import io
import json
import pathlib
import urllib.request

import pytest

API = "https://testdata-api.re-jam620.workers.dev/v1/generate"
REQUEST = {
    "rows": 20,
    "seed": 42,
    "format": "csv",
    "version": "1",
    "columns": [
        {"name": "order_id", "type": "sequence", "prefix": "ord_", "pad": 4},
        {"name": "email", "type": "email"},
        {"name": "total_usd", "type": "decimal", "min": 1, "max": 500},
    ],
}


def _load(request):
    body = json.dumps(request, sort_keys=True).encode()
    cache = pathlib.Path(".fixtures") / (hashlib.sha256(body).hexdigest()[:16] + ".csv")
    if not cache.exists():
        req = urllib.request.Request(API, data=body, headers={"content-type": "application/json", "user-agent": "rowsmith-example-pytest"})
        with urllib.request.urlopen(req, timeout=30) as resp:
            cache.parent.mkdir(exist_ok=True)
            cache.write_bytes(resp.read())
    return list(csv.DictReader(io.StringIO(cache.read_text())))


@pytest.fixture(scope="session")
def orders():
    return _load(REQUEST)
