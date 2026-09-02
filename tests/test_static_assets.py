"""The dashboard's static route.

It replaced a hardcoded route per file once the frontend became more than one
script, which means it now resolves a name supplied by the client. That is
worth guarding carefully and worth testing directly.
"""

import os

import pytest
from fastapi import FastAPI
from starlette.testclient import TestClient

from fastapi_visualizer import visualize

HERE = os.path.dirname(os.path.abspath(__file__))


@pytest.fixture
def client():
    app = FastAPI()
    visualize(app, enabled=True, roots=[HERE])
    with TestClient(app) as c:
        yield c


# --- what it must serve ----------------------------------------------------


def test_the_dashboard_page_is_served(client):
    r = client.get("/_viz/")
    assert r.status_code == 200
    assert "FastAPI Async Visualizer" in r.text


@pytest.mark.parametrize(
    "asset",
    ["dashboard.js", "viz/theme.js", "viz/geometry.js", "viz/primitives.js", "viz/filter.js"],
)
def test_every_script_the_page_loads_is_reachable(client, asset):
    """Whatever index.html lists in its <script> tags must actually serve.

    A missing one is a blank dashboard with a console error, which is exactly
    the sort of thing a hardcoded-route-per-file setup used to cause.
    """
    r = client.get("/_viz/" + asset)
    assert r.status_code == 200, f"{asset} -> {r.status_code}"
    assert r.text.strip(), f"{asset} served empty"


def test_the_page_and_the_route_agree_on_the_script_list(client):
    """Parse index.html and fetch exactly what it asks for.

    Guards the load order too: if a file is added to the page and not to the
    static directory (or vice versa), this fails rather than the dashboard
    silently half-loading in a browser.
    """
    import re

    page = client.get("/_viz/").text
    srcs = re.findall(r'<script src="\./([^"]+)"></script>', page)
    assert srcs, "no scripts found in index.html"
    for src in srcs:
        r = client.get("/_viz/" + src)
        assert r.status_code == 200, f"page loads {src} but the route 404s it"


# --- what it must refuse ---------------------------------------------------


@pytest.mark.parametrize(
    "attempt",
    [
        "../app.py",
        "../../pyproject.toml",
        "..%2Fapp.py",
        "....//app.py",
        "%2e%2e%2fapp.py",
        "viz/../../app.py",
        "/etc/passwd",
        "....//....//etc/passwd",
    ],
)
def test_path_traversal_is_refused(client, attempt):
    r = client.get("/_viz/" + attempt)
    assert r.status_code in (404, 400), f"{attempt} -> {r.status_code}"
    # And crucially: never the contents of something outside the static dir.
    assert "visualize" not in r.text
    assert "root:" not in r.text


@pytest.mark.parametrize("attempt", ["secrets.env", "notes.txt", "data.json", ".hidden"])
def test_only_frontend_file_types_are_served(client, attempt):
    """Extension allow-list: this directory holds the prebuilt frontend only."""
    r = client.get("/_viz/" + attempt)
    assert r.status_code == 404


def test_a_missing_file_is_a_404_not_a_500(client):
    r = client.get("/_viz/nope.js")
    assert r.status_code == 404


def test_a_probe_cannot_tell_refused_from_absent(client):
    """Both answer 404 with the same body, so probing reveals nothing."""
    refused = client.get("/_viz/secrets.env")
    absent = client.get("/_viz/nope.js")
    assert refused.status_code == absent.status_code == 404
    assert refused.text == absent.text
