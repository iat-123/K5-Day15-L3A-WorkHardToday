import os
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from urllib.parse import parse_qs, urlparse

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

import facebook  # noqa: E402
import server  # noqa: E402
import vpost_api  # noqa: E402

client = TestClient(server.app)
IMG = "https://lh3.googleusercontent.com/d/abc123"
PAGES = [{"id": "123", "name": "WorkHardToday", "access_token": "PTOKEN"},
         {"id": "456", "name": "Page không token", "access_token": None}]


def setup_function(_):
    for k in ("FB_APP_ID", "FB_APP_SECRET", "FB_PAGE_ID", "FB_PAGE_TOKEN", "FB_LOGIN_CONFIG_ID"):
        os.environ.pop(k, None)
    with server.store._conn() as c:
        for t in ("fb_page", "fb_user", "channel_status", "post_job", "post_batch"):
            c.execute("delete from %s" % t)
    facebook.exchange_code = lambda code: "SHORT" if code == "good" else (_ for _ in ()).throw(
        facebook.FacebookError("GRAPH_ERROR", "code hỏng"))
    facebook.long_lived = lambda t: "LONG"
    facebook.pages = lambda t: [dict(p) for p in PAGES]
    tools.inventory = lambda: {"G1": [{"mau": "Đen", "size": s, "ton": 3, "trang_thai": "Còn hàng"} for s in "SML"]}
    tools.check_images = lambda urls: {"ok": list(urls), "broken": []}
    vpost_api.load_catalog([{"ma_sp": "G1", "loai": "Váy", "gia_ban": "890.000đ", "size": "S-L", "mau": "Đen",
                             "chat_lieu": "Voan", "anh": IMG}])


def app_env():
    os.environ.update(FB_APP_ID="111", FB_APP_SECRET="secret")


def qs(resp):
    return parse_qs(urlparse(resp.headers["location"]).query)


def test_connect_without_app_config_goes_back_with_reason():
    r = client.get("/api/channels/connect", follow_redirects=False)
    assert r.status_code == 302 and qs(r) == {"connect": ["error"], "reason": ["APP_NOT_CONFIGURED"]}


def test_connect_redirects_to_facebook_with_state_cookie():
    app_env()
    r = client.get("/api/channels/connect", follow_redirects=False)
    loc = urlparse(r.headers["location"])
    q = parse_qs(loc.query)
    assert loc.netloc == "www.facebook.com" and loc.path.endswith("/dialog/oauth")
    assert "pages_manage_posts" in q["scope"][0] and q["redirect_uri"] == [facebook.DEFAULT_REDIRECT]
    assert r.cookies.get(vpost_api.STATE_COOKIE) == q["state"][0]


def test_callback_rejects_forged_state_and_handles_cancel():
    app_env()
    client.cookies.set(vpost_api.STATE_COOKIE, "real", path="/api/channels")
    r = client.get("/api/channels/callback?code=good&state=fake", follow_redirects=False)
    assert qs(r)["reason"] == ["STATE_MISMATCH"]
    r = client.get("/api/channels/callback?error=access_denied&state=real", follow_redirects=False)
    assert qs(r) == {"connect": ["cancelled"]}
    client.cookies.clear()


def test_callback_saves_pages_and_skips_tokenless():
    app_env()
    client.cookies.set(vpost_api.STATE_COOKIE, "s1", path="/api/channels")
    r = client.get("/api/channels/callback?code=good&state=s1", follow_redirects=False)
    client.cookies.clear()
    assert qs(r) == {"connected": ["1"], "new": ["1"], "skipped": ["1"]}
    chans = {c["channelId"]: c for c in client.get("/api/channels").json()["channels"]}
    assert chans["fb-123"]["name"] == "WorkHardToday" and "fb-456" not in chans
    assert server.store.fb_page("123")["page_token"] == "PTOKEN" and server.store.fb_user_token() == "LONG"


def test_import_token_then_post_uses_page_token():
    r = client.post("/api/channels/import", json={"userAccessToken": "EAAx"})
    assert r.status_code == 200 and r.json()["imported"] == 1 and r.json()["channels"][0]["channelId"] == "fb-123"
    seen = {}

    def fake_schedule(text, when_ts, images, page=None):
        seen["page"] = page
        return {"mode": "facebook", "fb_post_id": "123_999"}

    tools.schedule_post = fake_schedule
    when = (datetime.now(timezone.utc) + timedelta(days=1)).strftime("%Y-%m-%dT%H:%M:%S.000Z")
    b = client.post("/api/posts/batches", json={"productCode": "G1", "scheduledAt": when, "channelIds": ["fb-123"],
                                                "captionByChannel": {"fb-123": "Váy G1 màu đen, size S, M, L. Giá 890.000đ."},
                                                "media": [{"driveFileId": IMG}]}).json()
    assert b["channels"][0]["status"] == "scheduled_on_facebook" and seen["page"] == ("123", "PTOKEN")


def test_import_rejects_token_with_spaces():
    assert client.post("/api/channels/import", json={"userAccessToken": "EA Ax"}).json()["code"] == "INVALID_INPUT"


def test_disable_blocks_posting_and_remove_rules():
    client.post("/api/channels/import", json={"userAccessToken": "EAAx"})
    assert client.put("/api/channels/fb-123", json={"status": "disabled"}).json() == {"channelId": "fb-123",
                                                                                      "status": "disabled"}
    when = (datetime.now(timezone.utc) + timedelta(days=1)).strftime("%Y-%m-%dT%H:%M:%S.000Z")
    r = client.post("/api/posts/batches", json={"productCode": "G1", "scheduledAt": when, "channelIds": ["fb-123"],
                                                "captionByChannel": {"fb-123": "Váy"}, "media": [{"driveFileId": IMG}]})
    assert r.status_code == 409 and "đang tắt" in r.json()["message"]
    assert client.delete("/api/channels/diu-may").status_code == 409
    assert client.delete("/api/channels/fb-123").json() == {"channelId": "fb-123", "removed": True}


def test_refresh_needs_a_prior_connect():
    assert client.post("/api/channels/refresh", json={}).json()["code"] == "CHANNEL_NOT_CONFIGURED"
