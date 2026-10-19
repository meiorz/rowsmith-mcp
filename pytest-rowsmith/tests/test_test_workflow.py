"""The test-only workflow (.github/workflows/pytest-rowsmith-test.yml) runs the publish workflow's matrix and offline
command on push to main and by hand, with no secret, no OIDC token and no publish step (cycle 7)."""
import pathlib

import pytest

REPO = pathlib.Path(__file__).resolve().parents[2]
TEST_WF = REPO / ".github" / "workflows" / "pytest-rowsmith-test.yml"
PUBLISH_WF = REPO / ".github" / "workflows" / "pytest-rowsmith-publish.yml"

pytestmark = pytest.mark.skipif(not TEST_WF.exists(), reason="the .github folder is not beside the package (archive)")


def _text(p):
    return p.read_text(encoding="utf-8")


def test_triggers_are_push_to_main_and_dispatch_only():
    text = _text(TEST_WF)
    assert "  push:\n    branches:\n      - main\n" in text
    assert "  workflow_dispatch:\n" in text
    assert "tags:" not in text and "pull_request" not in text


def test_no_secret_no_token_no_publish():
    text = _text(TEST_WF)
    assert "permissions: {}" in text and "contents: read" in text
    for banned in ("id-token", "secrets.", "environment:", "gh-action-pypi-publish", "upload-artifact", "python -m build"):
        assert banned not in text, banned


def test_matrix_and_command_match_the_publish_workflow():
    test_wf, publish_wf = _text(TEST_WF), _text(PUBLISH_WF)
    for line in ('- python: "3.9"', 'pytest: "8.4.2"', '- python: "3.13"', 'pytest: "9.1.1"',
                 'run: python -m pip install "pytest==$PYTEST_PIN"',
                 "run: PYTHONPATH=src python -m pytest -q -p no:cacheprovider -W error",
                 "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
                 "actions/setup-python@5fda3b95a4ea91299a34e894583c3862153e4b97"):
        assert line in test_wf, line
        assert line in publish_wf, line
