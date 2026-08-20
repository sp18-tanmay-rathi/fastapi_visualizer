"""Run the dashboard's JS playback tests from pytest.

The dashboard is vanilla JS with no build step and no npm dependency, so node
is NOT a required dev tool for this project — this test skips when it is
absent rather than failing. See tests/js/playback_test.js for what it covers.
"""

import pathlib
import shutil
import subprocess

import pytest

JS_TEST = pathlib.Path(__file__).parent / "js" / "playback_test.js"

# This test does not build an app, so the autouse enable fixture is irrelevant
# here — it just shells out to node.


@pytest.mark.skipif(shutil.which("node") is None, reason="node not installed")
def test_dashboard_playback_js():
    result = subprocess.run(
        [shutil.which("node"), str(JS_TEST)],
        capture_output=True,
        text=True,
        timeout=120,
    )
    # Always surface the JS output — a bare exit code is useless for debugging.
    if result.returncode != 0:
        pytest.fail(
            "dashboard playback tests failed\n"
            f"--- stdout ---\n{result.stdout}\n--- stderr ---\n{result.stderr}"
        )
    assert "all playback tests passed" in result.stdout
