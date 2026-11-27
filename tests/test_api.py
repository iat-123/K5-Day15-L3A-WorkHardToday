import json
import os
import sys
import tempfile
from datetime import datetime

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

from fastapi.testclient import TestClient  # noqa: E402

import schedule  # noqa: E402
import tools  # noqa: E402

tools.UPLOADS = tempfile.mkdtemp()   # ảnh test không ghi vào data/uploads của repo
import server  # noqa: E402

INV = {"T1": [{"mau": "Đen", "size": s, "ton": 3, "trang_thai": "Còn hàng"} for s in "SML"]}
GOOD = {"decision": "write", "flag_reasons": [], "hook": "Một chiếc đầm voan cho buổi hẹn cuối tuần.",
        "body": "Đầm Test dáng xoè 2 lớp, màu đen, size S, M, L. Giá 890.000đ.", "cta": "Bình luận size để shop tư vấn nhé.",
        "hashtags": [], "facts_used": ["F1"]}
CSV = ("ma_sp,ten_sp,gia_ban,gia_te,size,mau,chat_lieu,mo_ta,anh,page,prompt\n"
       "T1,Đầm Test,890.000đ,50,S-L,Đen,Voan,Váy xoè 2 lớp,"
       "https://drive.google.com/file/d/1CetsBFBmZJ9DMrMgGCibpayBgMUCPC39/view,diu-may,Viết nhẹ nhàng\n"
       "T1,Đầm Thiếu Giá,,50,S-L,Đen,Voan,Váy xoè,,diu-may,Viết\n"
       "T1,Đầm Chưa Ảnh,890.000đ,50,S-L,Đen,Voan,Váy xoè 2 lớp,,diu-may,Viết\n").encode("utf-8")
PNG = bytes.fromhex("89504e470d0a1a0a0000000d4948445200000001000000010806000000"
                    "1f15c4890000000d49444154789c63000100000500010d0a2db40000000049454e44ae426082")


def fake_model(system, user, schema=None):
    return {"text": json.dumps(GOOD, ensure_ascii=False), "model": "fake", "tokens_in": 10, "tokens_out": 5}


server.MODEL, server.SYNC = fake_model, True
client = TestClient(server.app)


BROKEN = "https://example.invalid/hong.jpg"


def setup_function(_):
    tools.inventory = lambda: INV
    tools.check_images = lambda urls: {"ok": [u for u in urls if u != BROKEN], "broken": [u for u in urls if u == BROKEN]}


def upload():
    r = client.post("/api/batches", files={"file": ("p.csv", CSV, "text/csv")}, data={"default_page": "diu-may"})
    assert r.status_code == 200, r.text
    return client.get("/api/batches/%d" % r.json()["id"]).json()


def test_upload_processes_rows():
    b = upload()
    assert [r["status"] for r in b["rows"]] == ["written", "flagged", "written"]
    assert b["rows"][0]["images"] == ["https://lh3.googleusercontent.com/d/1CetsBFBmZJ9DMrMgGCibpayBgMUCPC39"]
    assert any(w.startswith("anh:") for w in b["rows"][2]["warnings"])
    assert b["rows"][1]["reasons"][0][0] == "gia_ban"


def test_upload_rejects_bad_file():
    r = client.post("/api/batches", files={"file": ("p.txt", b"abc", "text/plain")}, data={"default_page": "diu-may"})
    assert r.status_code == 400


def test_edit_approve_schedules():
    b = upload()
    rid = b["rows"][0]["id"]
    r = client.patch("/api/rows/%d" % rid, json={"text": b["rows"][0]["post"].replace("890.000đ", "790k")})
    assert r.status_code == 200 and r.json()["check"]["block"]        # sửa sai giá → bị cảnh báo
    r = client.post("/api/rows/%d/approve" % rid, json={})
    assert r.status_code == 200 and r.json()["mode"] == "app"
    slot = schedule.parse_when(r.json()["slot"])
    assert slot > schedule.now() and slot.strftime("%H:%M") in tools.PAGES["diu-may"]["slots"]
    assert client.get("/api/rows/%d" % rid).status_code in (404, 405)  # không có GET lẻ — xem qua lô
    assert any(p["id"] == rid for p in client.get("/api/schedule?days=31").json()["posts"])


def test_approve_flagged_rejected():
    b = upload()
    flagged, written = b["rows"][1]["id"], b["rows"][0]["id"]
    assert client.post("/api/rows/%d/approve" % flagged, json={}).status_code == 409
    s1 = client.post("/api/rows/%d/approve" % written, json={}).json()["slot"]
    assert client.post("/api/rows/%d/approve" % written, json={}).status_code == 409   # duyệt lần 2
    b2 = upload()
    s2 = client.post("/api/rows/%d/approve" % b2["rows"][0]["id"], json={}).json()["slot"]
    assert s1 != s2                                                                    # không trùng khung giờ


def test_regenerate_with_fixed_field():
    b = upload()
    rid = b["rows"][1]["id"]
    assert client.post("/api/rows/%d/regenerate" % rid, json={"fields": {"gia_ban": "890000"}}).status_code == 200
    row = [r for r in client.get("/api/batches/%d" % b["id"]).json()["rows"] if r["id"] == rid][0]
    assert row["status"] == "written"


def test_slot_skips_taken_and_10min():
    page = {"slots": ["09:00", "14:00"]}
    at = datetime(2026, 11, 28, 8, 55, tzinfo=schedule.TZ)
    first = schedule.next_free_slot(page, set(), at)
    assert first.strftime("%d %H:%M") == "28 14:00"                                  # 09:00 chỉ còn 5 phút → bỏ
    assert schedule.next_free_slot(page, {first.isoformat()}, at).strftime("%d %H:%M") == "29 09:00"


def test_slot_none_after_30_days():
    page = {"slots": ["09:00"]}
    at = datetime(2026, 11, 28, 10, 0, tzinfo=schedule.TZ)
    full = set()
    for _ in range(40):
        s = schedule.next_free_slot(page, full, at)
        if not s:
            break
        full.add(s.isoformat())
    assert schedule.next_free_slot(page, full, at) is None and len(full) == 30


def test_approve_needs_image_then_upload():
    b = upload()
    rid = b["rows"][2]["id"]
    assert client.post("/api/rows/%d/approve" % rid, json={}).status_code == 409
    assert client.post("/api/rows/%d/images" % rid, files=[("files", ("a.txt", b"not image", "text/plain"))]).status_code == 400
    r = client.post("/api/rows/%d/images" % rid, files=[("files", ("a.png", PNG, "image/png"))])
    assert r.status_code == 200 and r.json()["images"][0].startswith("/uploads/")
    row = [x for x in client.get("/api/batches/%d" % b["id"]).json()["rows"] if x["id"] == rid][0]
    assert not any(w.startswith("anh:") for w in row["warnings"])
    assert client.get(r.json()["images"][0]).status_code == 200
    assert client.post("/api/rows/%d/approve" % rid, json={}).status_code == 200


def test_broken_images_are_dropped():
    csv_bytes = ("ma_sp,ten_sp,gia_ban,size,mau,chat_lieu,anh,page,prompt\n"
                 "T1,Đầm Test,890.000đ,S-L,Đen,Voan,\"https://x.vn/ok.jpg " + BROKEN + "\",diu-may,Viết\n").encode("utf-8")
    r = client.post("/api/batches", files={"file": ("p.csv", csv_bytes, "text/csv")}, data={"default_page": "diu-may"})
    row = client.get("/api/batches/%d" % r.json()["id"]).json()["rows"][0]
    assert row["images"] == ["https://x.vn/ok.jpg"]
    assert any("bỏ 1 ảnh" in w for w in row["warnings"])
