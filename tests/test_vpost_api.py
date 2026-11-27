import json
import os
import re
import sys
import tempfile
from datetime import datetime, timedelta, timezone

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

if "server" not in sys.modules:   # server mount thư mục ảnh lúc nạp — chỉ đổi khi chưa nạp
    tools.UPLOADS = tempfile.mkdtemp()
from fastapi.testclient import TestClient  # noqa: E402

import server  # noqa: E402
import vpost_api  # noqa: E402

IMG = "https://lh3.googleusercontent.com/d/abc123"
ROWS = [
    {"ma_sp": "G1", "loai": "Váy", "gia_ban": "890.000đ", "size": "S-L", "mau": "Đen", "chat_lieu": "Voan", "anh": IMG,
     "page": "diu-may", "prompt": "Viết nhẹ nhàng"},
    {"ma_sp": "G2", "loai": "Váy", "gia_ban": "", "size": "S-L", "mau": "Đen", "anh": IMG},
    {"ma_sp": "G3", "loai": "Váy", "gia_ban": "890.000đ", "size": "S-L", "mau": "Đen", "anh": IMG},
    {"ma_sp": "G4", "loai": "Váy", "gia_ban": "890.000đ", "size": "S-L", "mau": "Đen", "anh": ""},
]
INV = {"G1": [{"mau": "Đen", "size": s, "ton": 3, "trang_thai": "Còn hàng"} for s in "SML"],
       "G3": [{"mau": "Đen", "size": s, "ton": 0, "trang_thai": "HẾT HÀNG"} for s in "SML"],
       "G4": [{"mau": "Đen", "size": s, "ton": 3, "trang_thai": "Còn hàng"} for s in "SML"]}
GOOD = {"decision": "write", "flag_reasons": [], "hook": "Một chiếc đầm voan cho buổi hẹn cuối tuần.",
        "body": "Váy G1 màu đen, size S, M, L. Giá 890.000đ.", "cta": "Bình luận size để shop tư vấn nhé.",
        "hashtags": [], "facts_used": ["F1"]}
FLAG = {"decision": "flag", "flag_reasons": [{"field": "prompt", "issue": "đòi thời gian giao hàng"}],
        "hook": "", "body": "", "cta": "", "hashtags": [], "facts_used": []}
client = TestClient(server.app)
UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
Z = re.compile(r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$")


def fake(reply):
    return lambda system, user, schema=None: {"text": json.dumps(reply, ensure_ascii=False), "model": "fake",
                                              "tokens_in": 1, "tokens_out": 1}


def setup_function(_):
    tools.inventory = lambda: INV
    tools.check_images = lambda urls: {"ok": list(urls), "broken": []}
    os.environ.pop("FB_PAGE_ID", None)
    vpost_api.load_catalog([dict(r) for r in ROWS])
    vpost_api.MODEL = fake(GOOD)
    with server.store._conn() as c:
        c.execute("delete from post_job")
        c.execute("delete from post_batch")


def soon(days=1):
    return (datetime.now(timezone.utc) + timedelta(days=days)).strftime("%Y-%m-%dT%H:%M:%S.000Z")


def batch(code="G1", when=None, channels=("diu-may",)):
    return client.post("/api/posts/batches", json={
        "productCode": code, "scheduledAt": when, "channelIds": list(channels),
        "captionByChannel": {c: "Váy G1 màu đen, size S, M, L. Giá 890.000đ." for c in channels},
        "media": [{"driveFileId": IMG}]})


def test_me_has_active_tenant():
    m = client.get("/api/me").json()
    assert m["activeTenantId"] == m["tenants"][0]["id"] and UUID.match(m["activeTenantId"])
    assert m["tenants"][0]["role"] == "editor" and m["account"]["platformRole"] is None


def test_channels_are_pages():
    ch = client.get("/api/channels").json()["channels"]
    assert {c["channelId"] for c in ch} >= {"diu-may", "nang-tho"} and all(c["platform"] == "facebook" for c in ch)


def test_compose_ok_and_row_flags():
    r = client.post("/api/posts/compose", json={"productCode": "G1", "mediaKind": "image"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["media"][0]["driveFileId"] == IMG and "G1" in body["content"]["name"]
    assert body["inventory"]["status"] == "in_stock" and body["availableColors"] == ["Đen"]
    for code, status, err in (("G2", 422, "ROW_DATA_INVALID"), ("G3", 409, "OUT_OF_STOCK"),
                              ("G4", 404, "MEDIA_NOT_FOUND"), ("NOPE", 404, "PRODUCT_NOT_FOUND")):
        r = client.post("/api/posts/compose", json={"productCode": code})
        assert r.status_code == status and r.json()["code"] == err and r.json()["message"], (code, r.text)


def test_validation_error_envelope():
    r = client.post("/api/posts/compose", json={})
    assert r.status_code == 400
    b = r.json()
    assert b["code"] == "INVALID_INPUT" and b["message"] and b["issues"][0]["path"] == "productCode"


def test_captions_write_and_flag():
    req = {"product": {"name": "Váy G1", "description": "", "category": "Váy", "season": ""}, "channels": ["facebook"]}
    g = client.post("/api/posts/captions", json=req).json()
    assert g["failed"] == [] and "890.000đ" in g["generated"][0]["text"] and "🔰 Mã: G1" in g["generated"][0]["text"]
    vpost_api.MODEL = fake(FLAG)
    f = client.post("/api/posts/captions", json=req).json()
    assert f["generated"] == [] and "giao hàng" in f["failed"][0]["reason"] and f["failed"][0]["code"] == "ROW_FLAGGED"
    assert client.post("/api/posts/captions", json=dict(req, tone="la-lam")).status_code == 400


def test_schedule_reschedule_cancel_and_duplicate_lock():
    r = batch(when=soon())
    assert r.status_code == 200, r.text
    b = r.json()
    ch = b["channels"][0]
    assert ch["status"] == "queued" and Z.match(ch["scheduledAt"]) and UUID.match(b["batchId"])
    assert batch(when=soon(2)).json()["channels"][0]["errorCode"] == "DUPLICATE_POST_BLOCKED"
    got = client.get("/api/posts/batches/" + b["batchId"]).json()
    assert got["totals"]["queued"] == 1 and Z.match(got["startedAt"]) and got["status"] == "pending"
    items = client.get("/api/posts/scheduled").json()["items"]
    assert any(i["postJobId"] == ch["postJobId"] and i["canReschedule"] for i in items)
    rs = client.post("/api/posts/scheduled/%s/reschedule" % ch["postJobId"], json={"scheduledAt": soon(3)})
    assert rs.status_code == 200 and Z.match(rs.json()["scheduledAt"])
    cx = client.post("/api/posts/scheduled/%s/cancel" % ch["postJobId"], json={})
    assert cx.status_code == 200 and cx.json()["status"] == "blocked"
    assert batch(when=soon(4)).json()["channels"][0]["status"] == "queued"   # đã huỷ thì đăng lại được


def test_post_now_without_facebook_is_blocked_not_faked():
    ch = batch(when=None).json()["channels"][0]
    assert ch["status"] == "blocked" and ch["errorCode"] == "CHANNEL_NOT_CONFIGURED"


def test_batch_rejects_past_time_and_out_of_stock():
    past = (datetime.now(timezone.utc) + timedelta(minutes=2)).strftime("%Y-%m-%dT%H:%M:%S.000Z")
    assert batch(when=past).json()["code"] == "INVALID_INPUT"
    assert batch(code="G3", when=soon()).json()["code"] == "OUT_OF_STOCK"


def test_jobs_log_and_products():
    batch(when=soon())
    items = client.get("/api/posts/jobs").json()["items"]
    assert items and Z.match(items[0]["createdAt"]) and items[0]["canRetry"] is False
    p = client.get("/api/catalog/products").json()
    assert p["totals"] == {"total": 4, "ok": 1, "blocked": 3}
    codes = {i["code"]: (i["blockedReason"] or {}).get("code") for i in p["items"]}
    assert codes == {"G1": None, "G2": "ROW_DATA_INVALID", "G3": "OUT_OF_STOCK", "G4": "MEDIA_NOT_FOUND"}


def test_upload_catalog_skips_duplicates():
    csv_bytes = "ma_sp,gia_ban,size,mau,anh\nA1,890.000đ,S-L,Đen,%s\nA1,1đ,S,Đen,\n,1đ,S,Đen,\n" % IMG
    r = client.post("/api/vpost/catalog", files={"file": ("p.csv", csv_bytes.encode("utf-8"), "text/csv")})
    assert r.status_code == 200 and r.json()["rows"] == 1 and len(r.json()["skipped"]) == 2
