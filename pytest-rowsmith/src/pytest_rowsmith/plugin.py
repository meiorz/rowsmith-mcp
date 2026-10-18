"""The pytest plugin: the ``rowsmith`` fixture, the ``--rowsmith-refresh`` option and the ``rowsmith_url`` ini
option. Loading it defines hooks only; it opens no connection."""
import os

import pytest

from . import DEFAULT_URL, Rowsmith


def pytest_addoption(parser):
    group = parser.getgroup("rowsmith", "Rowsmith fake test data")
    group.addoption(
        "--rowsmith-refresh",
        action="store_true",
        default=False,
        help="Ignore cached Rowsmith answers: call the API once per schema in this run and replace the cache.",
    )
    parser.addini(
        "rowsmith_url",
        help="Base URL of the Rowsmith API (default %s). The ROWSMITH_URL environment variable wins." % DEFAULT_URL,
        default="",
    )


def base_url(config):
    return os.environ.get("ROWSMITH_URL") or config.getini("rowsmith_url") or DEFAULT_URL


@pytest.fixture(scope="session")
def rowsmith(pytestconfig):
    """A Rowsmith client whose answers are cached in pytest's cache (.pytest_cache), keyed by the request."""
    return Rowsmith(
        base_url=base_url(pytestconfig),
        cache=getattr(pytestconfig, "cache", None),
        refresh=pytestconfig.getoption("rowsmith_refresh"),
    )
