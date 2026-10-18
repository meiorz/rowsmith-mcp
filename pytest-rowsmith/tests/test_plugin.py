"""Offline tests of the plugin as pytest loads it: the fixture, pytest's cache, --rowsmith-refresh, the URL
settings, and no network use at import or plugin load."""
import os
import pathlib
import subprocess
import sys
import textwrap

import pytest

import pytest_rowsmith

# Inner pytester runs load only this plugin, explicitly: autoloading is off, so other installed plugins stay out.
INNER_ARGS = ("-p", "pytest_rowsmith.plugin")


@pytest.fixture
def pytester(pytester, monkeypatch):
    monkeypatch.setenv("PYTEST_DISABLE_PLUGIN_AUTOLOAD", "1")
    return pytester

INNER_TEST = """
def test_people(rowsmith):
    rows = rowsmith.generate([{"name": "id", "type": "sequence"}], rows=2, seed=3, format="csv")
    assert rows == [{"id": "1", "name": "Ada"}, {"id": "2", "name": "Lovelace, A"}]
    res = rowsmith.fetch([{"name": "id", "type": "sequence"}], rows=2, seed=3, format="csv")
    assert res.reproduce.startswith("POST /v1/generate body-b64url=")
"""


def test_fixture_uses_pytest_cache_and_then_runs_offline(pytester, stub, monkeypatch):
    monkeypatch.setenv("ROWSMITH_URL", stub.url)
    pytester.makepyfile(INNER_TEST)
    pytester.runpytest(*INNER_ARGS).assert_outcomes(passed=1)
    assert len(stub.requests) == 1
    assert stub.requests[0]["headers"]["x-rowsmith-tool"] == "pytest"
    entries = list((pytester.path / ".pytest_cache" / "v" / "rowsmith" / "v1").iterdir())
    assert len(entries) == 1 and len(entries[0].name) == 64

    stub.server.shutdown()
    stub.server.server_close()
    pytester.runpytest(*INNER_ARGS).assert_outcomes(passed=1)  # offline: answered from .pytest_cache
    assert len(stub.requests) == 1


def test_refresh_option_calls_again(pytester, stub, monkeypatch):
    monkeypatch.setenv("ROWSMITH_URL", stub.url)
    pytester.makepyfile(INNER_TEST)
    pytester.runpytest(*INNER_ARGS).assert_outcomes(passed=1)
    pytester.runpytest(*INNER_ARGS).assert_outcomes(passed=1)
    assert len(stub.requests) == 1
    pytester.runpytest(*INNER_ARGS, "--rowsmith-refresh").assert_outcomes(passed=1)
    assert len(stub.requests) == 2  # once per schema in the refreshing run, not once per call


def test_ini_url_and_env_override(pytester, stub, monkeypatch):
    monkeypatch.delenv("ROWSMITH_URL", raising=False)
    pytester.makeini("[pytest]\nrowsmith_url = %s\n" % stub.url)
    pytester.makepyfile(INNER_TEST)
    pytester.runpytest(*INNER_ARGS, "-p", "no:cacheprovider").assert_outcomes(passed=1)
    assert len(stub.requests) == 1
    monkeypatch.setenv("ROWSMITH_URL", "http://127.0.0.1:9")
    pytester.makepyfile(test_url="def test_url(rowsmith):\n    assert rowsmith.base_url == 'http://127.0.0.1:9'\n")
    pytester.runpytest(*INNER_ARGS, "test_url.py").assert_outcomes(passed=1)


def test_default_url():
    assert pytest_rowsmith.DEFAULT_URL == "https://testdata-api.re-jam620.workers.dev"


NO_SOCKET = r"""
import socket, sys

def refuse(*a, **k):
    raise AssertionError("network use during import or plugin load")

class NoSocket(socket.socket):
    def __init__(self, *a, **k):
        refuse()

socket.socket = NoSocket
socket.create_connection = refuse
socket.getaddrinfo = refuse
socket.socketpair = refuse

import pytest_rowsmith, pytest_rowsmith.plugin  # import opens nothing
import pytest
sys.exit(pytest.main([sys.argv[1], "-q", "-p", "pytest_rowsmith.plugin", "-p", "no:cacheprovider", "--rowsmith-refresh"]))
"""

NO_SOCKET_TEST = """
def test_plain():
    assert True

def test_fixture_without_a_call(rowsmith):
    assert rowsmith.network_calls == 0

def test_the_guard_catches_a_real_call(rowsmith):
    import pytest
    with pytest.raises(AssertionError, match="network use"):
        rowsmith.generate([{"name": "id", "type": "uuid"}])
"""


def test_import_and_plugin_load_open_no_socket(tmp_path):
    (tmp_path / "check.py").write_text(NO_SOCKET, encoding="utf-8")
    (tmp_path / "test_inner.py").write_text(textwrap.dedent(NO_SOCKET_TEST), encoding="utf-8")
    src = str(pathlib.Path(pytest_rowsmith.__file__).resolve().parent.parent)
    env = dict(os.environ)
    env["PYTHONPATH"] = src + os.pathsep + env.get("PYTHONPATH", "")
    env["PYTEST_DISABLE_PLUGIN_AUTOLOAD"] = "1"  # load only this plugin, explicitly
    env.pop("ROWSMITH_LIVE", None)
    p = subprocess.run([sys.executable, str(tmp_path / "check.py"), str(tmp_path / "test_inner.py")],
                       cwd=str(tmp_path), env=env, capture_output=True, text=True, timeout=120)
    assert p.returncode == 0, p.stdout + p.stderr
    assert "3 passed" in p.stdout
