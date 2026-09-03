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


# --- imports are not calls -------------------------------------------------
#
# Found on a real Django project. Django imports its URLconf lazily, on the
# first request to arrive, so every module body and class body in the project
# was traced and charged to that request: 100 frames (37 of them `<module>`)
# and 267ms, against 3 frames and 27ms for the second request. The view's own
# class body was among them, as a node named bare `WalletListAllAsyncView` —
# which reads exactly like the view "showing only its class name".


def test_module_and_class_bodies_are_not_callable_frames():
    """The filter itself, on real code objects rather than a live request."""
    from fastapi_visualizer.monitor import Monitor

    src = """
top = 1

class Thing:
    attr = 2
    def method(self): pass
    async def amethod(self): pass

def func(): pass
lam = lambda: None
def gen():
    yield 1
"""
    module_code = compile(src, "<probe>", "exec")
    ns: dict = {}
    exec(module_code, ns)

    # namespace-building frames: NOT calls
    assert not Monitor._is_callable_frame(module_code), "module body"
    class_code = next(
        c
        for c in module_code.co_consts
        if hasattr(c, "co_name") and c.co_name == "Thing"
    )
    assert not Monitor._is_callable_frame(class_code), "class body"

    # everything callable: traced
    for name in ("func", "lam", "gen"):
        assert Monitor._is_callable_frame(ns[name].__code__), name
    for c in class_code.co_consts:
        if hasattr(c, "co_name") and c.co_name in ("method", "amethod"):
            assert Monitor._is_callable_frame(c), c.co_name


async def test_an_import_during_a_request_is_not_traced_as_calls(client_for, tmp_path):
    """The real shape of the bug: a lazy import inside a request.

    Django does this with its URLconf. The import runs a module body and a
    class body, and both used to arrive as nodes on whichever request happened
    to trigger the import.
    """
    import importlib
    import sys

    from fastapi import FastAPI

    from fastapi_visualizer import visualize
    from fastapi_visualizer.collector import collector

    mod_dir = tmp_path / "lazypkg"
    mod_dir.mkdir()
    (mod_dir / "__init__.py").write_text("")
    (mod_dir / "lazymod.py").write_text(
        "SETTING = 1\n"
        "\n"
        "class LazyView:\n"
        "    attr = 2\n"
        "\n"
        "    def handle(self):\n"
        "        return 'ok'\n"
    )
    sys.path.insert(0, str(tmp_path))

    app = FastAPI()

    @app.get("/lazy")
    async def lazy():
        # the import happens HERE, inside the request, exactly as Django's
        # URLconf import does
        mod = importlib.import_module("lazypkg.lazymod")
        return {"ok": mod.LazyView().handle()}

    # trace the temp package as if it were application code
    visualize(app, enabled=True, roots=[str(tmp_path)])
    try:
        collector.clear()
        async with client_for(app) as client:
            assert (await client.get("/lazy")).status_code == 200

        quals = [
            (e.extra or {}).get("qualname")
            for e in collector.snapshot()
            if e.kind == "call_enter"
        ]
        assert "<module>" not in quals, f"an import was traced as calls: {quals}"
        assert "LazyView" not in quals, (
            "a class BODY was traced as a call — that node's qualname is the "
            f"bare class name, which reads as the class itself: {quals}"
        )
        # the method, however, is a real call and must survive
        assert any(str(q).endswith("handle") for q in quals), (
            f"the real method call was lost: {quals}"
        )
    finally:
        sys.path.remove(str(tmp_path))
        sys.modules.pop("lazypkg.lazymod", None)
        sys.modules.pop("lazypkg", None)
