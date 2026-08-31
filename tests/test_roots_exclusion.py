"""Library code must never be traced, even when it sits inside a root.

Regression for a real-world case: a Django project with its virtualenv at
./venv inside the project root. Setting roots=[BASE_DIR] swept the whole of
site-packages into the trace — ~1200 call nodes for one request.
"""

import os

from fastapi_visualizer.monitor import Monitor


def test_app_code_under_root_is_traced(tmp_path):
    m = Monitor([str(tmp_path)])
    assert m._in_root(str(tmp_path / "account" / "views.py")) is True


def test_nested_virtualenv_inside_root_is_excluded(tmp_path):
    """The exact reported layout: ./venv/lib/python3.12/site-packages/..."""
    m = Monitor([str(tmp_path)])
    vendored = tmp_path / "venv" / "lib" / "python3.12" / "site-packages"
    assert m._in_root(str(vendored / "django" / "core" / "handlers" / "base.py")) is False
    assert m._in_root(str(vendored / "rest_framework" / "views.py")) is False


def test_dist_packages_inside_root_is_excluded(tmp_path):
    m = Monitor([str(tmp_path)])
    p = tmp_path / "venv" / "lib" / "python3" / "dist-packages" / "celery" / "app.py"
    assert m._in_root(str(p)) is False


def test_stdlib_is_excluded(tmp_path):
    import json  # any stdlib module with a real file

    m = Monitor([str(tmp_path)])
    assert m._in_root(json.__file__) is False


def test_installed_package_is_excluded(tmp_path):
    import django  # installed in site-packages

    m = Monitor([str(tmp_path)])
    assert m._in_root(django.__file__) is False


def test_the_visualizer_itself_is_excluded(tmp_path):
    from fastapi_visualizer import monitor as monitor_mod

    m = Monitor([str(tmp_path)])
    assert m._in_root(monitor_mod.__file__) is False


def test_a_directory_merely_named_like_a_package_is_still_traced(tmp_path):
    """Only a real `site-packages` path segment is excluded, not a substring."""
    m = Monitor([str(tmp_path)])
    assert m._in_root(str(tmp_path / "my-site-packages-helper" / "x.py")) is True
