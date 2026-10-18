"""The publish workflow (../.github/workflows/pytest-rowsmith-publish.yml, beside this package in the repo):
its trigger, permissions and environment are exactly as agreed. Skipped only where the workflow is not shipped
(an unpacked sdist has no .github folder)."""
import pathlib
import re

import pytest

REPO = pathlib.Path(__file__).resolve().parent.parent.parent
WORKFLOW = REPO / ".github" / "workflows" / "pytest-rowsmith-publish.yml"


def _lines():
    if not (REPO / ".github").is_dir():
        pytest.skip("no .github folder beside the package (not a repository checkout)")
    text = WORKFLOW.read_text(encoding="utf-8")
    return [l.rstrip() for l in text.splitlines() if l.strip() and not l.lstrip().startswith("#")]


def _indent(line):
    return len(line) - len(line.lstrip(" "))


def _block(lines, header, indent):
    """The lines under `header` (a line at `indent`), up to the next line at that indent or less."""
    for i, l in enumerate(lines):
        if _indent(l) == indent and l.strip() == header:
            out = []
            for m in lines[i + 1:]:
                if _indent(m) <= indent:
                    break
                out.append(m)
            return out
    raise AssertionError("%r not found at indent %d" % (header, indent))


def _top(lines):
    return [l for l in lines if _indent(l) == 0]


def test_trigger_is_only_a_tag_push_matching_the_package_pattern():
    lines = _lines()
    assert [l.strip() for l in _block(lines, "on:", 0)] == ["push:", "tags:", '- "pytest-rowsmith-v*.*.*"']
    assert sum(1 for l in _top(lines) if l.startswith("on")) == 1


def test_permissions_build_reads_contents_and_only_publish_gets_id_token():
    lines = _lines()
    assert "permissions: {}" in _top(lines)
    jobs = _block(lines, "jobs:", 0)
    assert [l.strip() for l in jobs if _indent(l) == 2] == ["test:", "build:", "publish:"]
    test = _block(jobs, "test:", 2)
    build = _block(jobs, "build:", 2)
    publish = _block(jobs, "publish:", 2)
    assert [l.strip() for l in _block(test, "permissions:", 4)] == ["contents: read"]
    assert [l.strip() for l in _block(build, "permissions:", 4)] == ["contents: read"]
    assert [l.strip() for l in _block(publish, "permissions:", 4)] == ["id-token: write"]
    assert sum("id-token" in l for l in lines) == 1


def test_environment_pypi_on_publish_only():
    lines = _lines()
    jobs = _block(lines, "jobs:", 0)
    test = _block(jobs, "test:", 2)
    build = _block(jobs, "build:", 2)
    publish = _block(jobs, "publish:", 2)
    assert [l.strip() for l in publish if _indent(l) == 4 and l.strip().startswith("environment")] == ["environment: pypi"]
    assert not any("environment" in l for l in build + test)
    assert [l.strip() for l in publish if _indent(l) == 4 and l.strip().startswith("needs")] == ["needs: build"]


def test_actions_are_pinned_to_full_commit_shas_and_publish_uses_pypa():
    lines = _lines()
    uses = [l.strip() for l in lines if re.match(r"^\s*-?\s*uses:", l)]
    assert uses
    for u in uses:
        assert re.search(r"@[0-9a-f]{40}(\s|$)", u), u
    assert any(re.search(r"uses: pypa/gh-action-pypi-publish@[0-9a-f]{40}\b", u) for u in uses)
    publish = _block(_block(lines, "jobs:", 0), "publish:", 2)
    assert any("pypa/gh-action-pypi-publish@" in l for l in publish)


def test_test_job_runs_python_3_9_and_3_13_and_build_needs_it():
    jobs = _block(_lines(), "jobs:", 0)
    test = _block(jobs, "test:", 2)
    build = _block(jobs, "build:", 2)
    matrix = [l.strip() for l in _block(_block(test, "strategy:", 4), "matrix:", 6)]
    assert matrix == ["include:", '- python: "3.9"', 'pytest: "8.4.2"', '- python: "3.13"', 'pytest: "9.1.1"']
    assert "python-version: ${{ matrix.python }}" in [l.strip() for l in test]
    assert any("actions/setup-python@5fda3b95a4ea91299a34e894583c3862153e4b97" in l for l in test)
    assert any('pip install "pytest==$PYTEST_PIN"' in l for l in test)
    assert any("python -m pytest -q -p no:cacheprovider -W error" in l for l in test)
    assert [l.strip() for l in test if _indent(l) == 4 and l.strip().startswith("needs")] == []
    assert [l.strip() for l in build if _indent(l) == 4 and l.strip().startswith("needs")] == ["needs: test"]
    assert 'python-version: "3.12"' in [l.strip() for l in build]


def test_build_pins_the_backend_and_builds_without_isolation():
    build = _block(_block(_lines(), "jobs:", 0), "build:", 2)
    text = "\n".join(build)
    assert "run: python -m pip install setuptools==84.0.0 build==1.6.1 pytest==9.1.1" in text
    assert "run: python -m build --no-isolation" in text
    assert text.index("pytest -q -p no:cacheprovider -W error") < text.index("python -m build --no-isolation")


def test_sha256_of_the_artifacts_and_tool_versions_go_to_the_job_summary():
    build = _block(_block(_lines(), "jobs:", 0), "build:", 2)
    text = "\n".join(build)
    assert "sha256sum" in text and "$GITHUB_STEP_SUMMARY" in text
    assert '("setuptools", "build", "pytest")' in text
