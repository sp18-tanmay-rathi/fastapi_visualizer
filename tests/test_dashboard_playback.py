"""Run the dashboard's JS playback tests from pytest.

The dashboard is vanilla JS with no build step and no npm dependency, so node
is NOT a required dev tool for this project — this test skips when it is
absent rather than failing. See tests/js/playback_test.js for what it covers.
"""

import pathlib
import shutil
import subprocess

import pytest

JS_DIR = pathlib.Path(__file__).parent / "js"
JS_TESTS = sorted(p.name for p in JS_DIR.glob("*_test.js"))

# This test does not build an app, so the autouse enable fixture is irrelevant
# here — it just shells out to node.


@pytest.mark.skipif(shutil.which("node") is None, reason="node not installed")
@pytest.mark.parametrize("script", JS_TESTS)
def test_dashboard_js(script):
    result = subprocess.run(
        [shutil.which("node"), str(JS_DIR / script)],
        capture_output=True,
        text=True,
        timeout=120,
    )
    # Always surface the JS output — a bare exit code is useless for debugging.
    if result.returncode != 0:
        pytest.fail(
            f"dashboard JS tests failed ({script})\n"
            f"--- stdout ---\n{result.stdout}\n--- stderr ---\n{result.stderr}"
        )
    assert "passed" in result.stdout
