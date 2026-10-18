"""The one live test: the golden request through the real API. Opt-in: it runs only with ROWSMITH_LIVE=1 (it is
deselected otherwise), and it counts against the caller's daily limit."""
import os

import pytest

from pytest_rowsmith import DEFAULT_URL, Rowsmith

GOLDEN_SHA256 = "50db558e2e8c54353ac38a3125deb91642895db302eec334afeec2406537f821"
# ALL_TYPES_REQUEST from the service's test/helpers.ts with rows 5, seed 42, format csv (the canary's request).
GOLDEN_TABLE = "orders"
GOLDEN_COLUMNS = [
    {"name": "id", "type": "uuid"},
    {"name": "order_no", "type": "sequence", "prefix": "ord_", "pad": 4},
    {"name": "qty", "type": "integer", "min": 1, "max": 9},
    {"name": "total_usd", "type": "decimal", "min": 0.01, "max": 500, "scale": 2},
    {"name": "paid", "type": "boolean", "p_true": 0.8},
    {"name": "status", "type": "enum", "values": ["paid", "refunded", "partially_refunded"], "weights": [8, 1, 1]},
    {"name": "placed_on", "type": "date", "from": "2026-01-01", "to": "2026-12-31"},
    {"name": "placed_at", "type": "datetime", "from": "2026-03-08T00:00:00Z", "to": "2026-03-09T00:00:00Z"},
    {"name": "customer", "type": "full_name"},
    {"name": "email", "type": "email", "null_rate": 0.1},
    {"name": "phone", "type": "phone"},
    {"name": "card", "type": "test_card"},
    {"name": "ssn", "type": "ssn_invalid"},
    {"name": "iban", "type": "iban_invalid"},
    {"name": "note", "type": "text", "min_words": 2, "max_words": 6},
]


@pytest.mark.live
def test_golden_request_is_byte_identical():
    rs = Rowsmith(base_url=os.environ.get("ROWSMITH_URL") or DEFAULT_URL, cache=None)
    res = rs.fetch(GOLDEN_COLUMNS, rows=5, seed=42, format="csv", table=GOLDEN_TABLE, version="1")
    assert rs.network_calls == 1
    assert res.generator_version == "1"
    assert res.seed == 42
    assert res.reproduce.startswith("POST /v1/generate body-")
    assert res.sha256 == GOLDEN_SHA256
    rows = res.parsed()
    assert len(rows) == 5 and rows[0]["order_no"] == "ord_0001"
