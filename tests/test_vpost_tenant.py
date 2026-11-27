import os
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "codebase"))

import pytest  # noqa: E402
import store  # noqa: E402

_pg_skip = os.environ.get("_VPOST_PG_UNAVAILABLE")
if _pg_skip is None:
    _ok, _pg_err = store.check_connection()
    _pg_skip = "" if _ok else _pg_err
if _pg_skip:
    pytest.skip("PostgreSQL unreachable (%s)" % _pg_skip, allow_module_level=True)

import tools  # noqa: E402

if "server" not in sys.modules:
    tools.UPLOADS = tempfile.mkdtemp()
from fastapi.testclient import TestClient  # noqa: E402

import server  # noqa: E402
import vpost_api  # noqa: E402

OTHER = "11111111-1111-4111-8111-111111111111"


def call(cookie=None):
    client = TestClient(server.app)
    if cookie is not None:
        client.cookies.set(vpost_api.TENANT_COOKIE, cookie)
    return client.get("/api/channels")


def test_other_tenant_cookie_is_forbidden():
    r = call(OTHER)
    assert r.status_code == 403
    assert r.json()["code"] == "FORBIDDEN"


def test_matching_tenant_cookie_passes():
    r = call(vpost_api.TENANT_ID)
    assert r.status_code == 200
    assert r.json()["tenantId"] == vpost_api.TENANT_ID


def test_no_cookie_passes():
    r = call()
    assert r.status_code == 200
