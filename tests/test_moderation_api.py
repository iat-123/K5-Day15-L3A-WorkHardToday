"""Tests cho moderation_store.py và moderation_api.py (không gọi mạng, gắn cả hai router)."""
from __future__ import annotations

import json
import os
import re
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from typing import Optional

import httpx
import pytest
from fastapi import FastAPI
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.testclient import TestClient
from starlette.exceptions import HTTPException as StarletteHTTPException

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "codebase"))

import store  # noqa: E402

_pg_skip = os.environ.get("_VPOST_PG_UNAVAILABLE")
if _pg_skip is None:
    _ok, _pg_err = store.check_connection()
    _pg_skip = "" if _ok else _pg_err
if _pg_skip:
    pytest.skip("PostgreSQL unreachable (%s)" % _pg_skip, allow_module_level=True)

import facebook  # noqa: E402
import moderation_api  # noqa: E402
import moderation_store  # noqa: E402
import rules  # noqa: E402
import schedule  # noqa: E402
import tools  # noqa: E402
import vpost_api  # noqa: E402

if "server" not in sys.modules:
    tools.UPLOADS = tempfile.mkdtemp()
import server  # noqa: E402

PAGE_A = "123"
CHANNEL_A = "fb-123"
PAGE_B = "456"
CHANNEL_B = "fb-456"
OTHER_TENANT = "11111111-1111-4111-8111-111111111111"
Z_RE = re.compile(r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$")

_ERROR_CODES = {
    400: "INVALID_INPUT",
    404: "NOT_FOUND",
    405: "INVALID_INPUT",
    409: "CONFLICT",
    413: "INVALID_INPUT",
    422: "INVALID_INPUT",
    502: "UPSTREAM_ERROR",
}


def _build_test_app() -> FastAPI:
    app = FastAPI(title="VPOST Moderation Test")
    # Thứ tự bắt buộc: moderation_api.router ĐỨNG TRƯỚC vpost_api.router để tránh che khuất đường dẫn tĩnh.
    app.include_router(moderation_api.router)
    app.include_router(vpost_api.router)

    @app.exception_handler(StarletteHTTPException)
    async def http_error(request, exc):
        d = exc.detail
        body = (
            dict(d)
            if isinstance(d, dict) and "code" in d
            else {"code": _ERROR_CODES.get(exc.status_code, "ERROR"), "message": str(d or "Lỗi")}
        )
        body["detail"] = body["message"]
        return JSONResponse(body, status_code=exc.status_code)

    @app.exception_handler(RequestValidationError)
    async def validation_error(request, exc):
        issues = [
            {"path": ".".join(str(p) for p in e["loc"] if p not in ("body", "query", "path")), "message": e["msg"]}
            for e in exc.errors()
        ]
        msg = "Dữ liệu gửi lên không hợp lệ: " + "; ".join("%s %s" % (i["path"], i["message"]) for i in issues)
        return JSONResponse({"code": "INVALID_INPUT", "message": msg, "issues": issues, "detail": msg}, status_code=400)

    return app


app = _build_test_app()
client = TestClient(app)

_ORIG_HIDE_TOOL = tools.hide_fb_comment
_ORIG_HAS_DELETE_TOOL = hasattr(tools, "delete_fb_comment")
_ORIG_DELETE_TOOL = getattr(tools, "delete_fb_comment", None)
_ORIG_MOD_MODEL = moderation_api.MODEL
_ORIG_VPOST_MODEL = vpost_api.MODEL
_ORIG_PAUSE = moderation_api.FB_WRITE_PAUSE_SEC
_ORIG_SLEEP = moderation_api._sleep


class FakeModel:
    def __init__(self, reply=None, *, raw_text=None, exc=None):
        self.reply = reply
        self.raw_text = raw_text
        self.exc = exc
        self.calls = []

    def __call__(self, system, user, schema=None):
        self.calls.append({"system": system, "user": user, "schema": schema})
        if self.exc is not None:
            raise self.exc
        if self.raw_text is not None:
            return {"text": self.raw_text, "model": "fake-mod", "tokens_in": 20, "tokens_out": 10}
        return {
            "text": json.dumps(self.reply, ensure_ascii=False),
            "model": "fake-mod",
            "tokens_in": 20,
            "tokens_out": 10,
        }


def iso_ago(*, hours=0, days=0, minutes=0) -> str:
    dt = datetime.now(timezone.utc) - timedelta(days=days, hours=hours, minutes=minutes)
    return dt.strftime("%Y-%m-%dT%H:%M:%S.000Z")


def seed_pages():
    store.save_fb_pages(
        [
            {"id": PAGE_A, "name": "Dịu Mây Boutique", "access_token": "EAAG_TOKEN_A"},
            {"id": PAGE_B, "name": "Phố Nhỏ Studio", "access_token": "EAAG_TOKEN_B"},
        ],
        "UTOKEN",
        iso_ago(),
    )


def seed_comment(
    cid: str,
    *,
    tenant_id: Optional[str] = None,
    page_id: str = PAGE_A,
    channel_id: Optional[str] = None,
    post_job_id: str = "job-1",
    fb_post_id: str = "123_1001",
    parent_id: str = "",
    from_id: str = "u1",
    from_name: str = "Lan Anh",
    is_from_page: int = 0,
    message: str = "Mẫu này còn size M không shop?",
    created_time: Optional[str] = None,
    status: str = "unreplied",
    is_hidden: int = 0,
    can_comment: int = 1,
):
    ts = created_time or iso_ago(hours=1)
    store.upsert_fb_comment(
        tenant_id or vpost_api.TENANT_ID,
        {
            "id": cid,
            "channel_id": channel_id if channel_id is not None else ("fb-" + page_id),
            "page_id": page_id,
            "post_job_id": post_job_id,
            "fb_post_id": fb_post_id,
            "product_code": "G1",
            "parent_id": parent_id,
            "from_id": from_id,
            "from_name": from_name,
            "is_from_page": is_from_page,
            "message": message,
            "permalink_url": "https://www.facebook.com/%s?comment_id=%s" % (fb_post_id, cid),
            "is_hidden": is_hidden,
            "can_comment": can_comment,
            "created_time": ts,
            "status": status,
            "synced_at": ts,
            "updated_at": ts,
        },
    )


def _block_network(*args, **kwargs):
    raise AssertionError("Tests must never call the network!")


def setup_function(_):
    store.init()
    moderation_store.init_moderation()
    for k in ("FB_APP_ID", "FB_APP_SECRET", "FB_PAGE_ID", "FB_PAGE_TOKEN"):
        os.environ.pop(k, None)
    with store.connect() as c:
        for t in (
            "fb_comment",
            "comment_draft",
            "comment_sync",
            "fb_page",
            "fb_user",
            "channel_status",
            "post_job",
            "post_batch",
            "moderation_setting",
            "moderation_log",
        ):
            c.execute("delete from %s" % t)
    tools.hide_fb_comment = _ORIG_HIDE_TOOL
    if _ORIG_HAS_DELETE_TOOL:
        tools.delete_fb_comment = _ORIG_DELETE_TOOL
    elif hasattr(tools, "delete_fb_comment"):
        delattr(tools, "delete_fb_comment")
    moderation_api.MODEL = None
    vpost_api.MODEL = FakeModel({"category": "neutral", "confidence": 0.5, "reasons": ["bình thường"]})
    moderation_api.FB_WRITE_PAUSE_SEC = 0.0
    moderation_api._sleep = lambda _s: None
    seed_pages()
    client.cookies.clear()


def teardown_function(_):
    tools.hide_fb_comment = _ORIG_HIDE_TOOL
    if _ORIG_HAS_DELETE_TOOL:
        tools.delete_fb_comment = _ORIG_DELETE_TOOL
    elif hasattr(tools, "delete_fb_comment"):
        delattr(tools, "delete_fb_comment")
    moderation_api.MODEL = _ORIG_MOD_MODEL
    vpost_api.MODEL = _ORIG_VPOST_MODEL
    moderation_api.FB_WRITE_PAUSE_SEC = _ORIG_PAUSE
    moderation_api._sleep = _ORIG_SLEEP
    client.cookies.clear()


@pytest.fixture(autouse=True)
def _no_network(monkeypatch):
    monkeypatch.setattr(httpx, "get", _block_network)
    monkeypatch.setattr(httpx, "post", _block_network)
    monkeypatch.setattr(httpx, "delete", _block_network)


# ---------------- 1. Khởi tạo DB idempotent & gắn chung cả 2 router ----------------

def test_init_moderation_idempotent_and_schema_columns():
    moderation_store.init_moderation()
    moderation_store.init_moderation()
    with store.connect() as c:
        tables = {
            r["table_name"]
            for r in c.execute(
                "select table_name from information_schema.tables where table_schema = current_schema()"
            )
        }
        cols = {
            r["column_name"]
            for r in c.execute(
                "select column_name from information_schema.columns "
                "where table_schema = current_schema() and table_name = 'fb_comment'"
            ).fetchall()
        }
        log_cols = {
            r["column_name"]
            for r in c.execute(
                "select column_name from information_schema.columns "
                "where table_schema = current_schema() and table_name = 'moderation_log'"
            ).fetchall()
        }
    assert {"moderation_setting", "moderation_log"} <= tables
    assert {
        "moderation_category",
        "moderation_confidence",
        "moderation_reasons",
        "moderation_source",
        "moderation_action",
        "moderated_at",
    } <= cols
    assert "seq" in log_cols


def test_both_routers_coexist_without_shadowing():
    seed_comment("c1", message="Mẫu này giá bao nhiêu ạ?")
    # Route của moderation_api
    assert client.get("/api/comments/moderation-settings").status_code == 200
    assert client.get("/api/comments/moderation-log").status_code == 200
    assert client.post("/api/comments/bulk", json={"ids": ["c1"], "action": "ignore"}).status_code == 200
    assert client.post("/api/comments/c1/classify").status_code == 200
    # Route của vpost_api vẫn hoạt động bình thường
    lst = client.get("/api/comments")
    assert lst.status_code == 200
    assert [i["id"] for i in lst.json()["items"]] == ["c1"]
    assert client.post("/api/comments/c1/unignore").status_code == 200


# ---------------- 2. Cài đặt tự kiểm duyệt (GET / PUT) & chính sách complaint v1 ----------------

def test_moderation_settings_defaults_put_and_strict_validation():
    r = client.get("/api/comments/moderation-settings")
    assert r.status_code == 200
    body = r.json()
    assert body["tenantId"] == vpost_api.TENANT_ID
    assert [i["pageId"] for i in body["items"]] == [PAGE_A, PAGE_B]
    for item in body["items"]:
        assert item["enabled"] is False
        assert item["mode"] == "dry_run"
        assert item["categories"] == []
        assert item["threshold"] == 0.85
        assert item["updatedAt"] is None

    # Cập nhật hợp lệ (nhận cả threshold = 1 nguyên lẫn float trong 0.5..1.0)
    put_r = client.put(
        f"/api/comments/moderation-settings/{PAGE_A}",
        json={
            "enabled": True,
            "mode": "live",
            "categories": ["spam", "scam", "abusive", "pii", "spam"],
            "threshold": 0.9,
        },
    )
    assert put_r.status_code == 200, put_r.text
    setting = put_r.json()["setting"]
    assert setting["pageId"] == PAGE_A
    assert setting["enabled"] is True
    assert setting["mode"] == "live"
    assert setting["categories"] == ["spam", "scam", "abusive", "pii"]
    assert setting["threshold"] == 0.9
    assert Z_RE.match(setting["updatedAt"])

    # Page không tồn tại -> 404
    assert (
        client.put(
            "/api/comments/moderation-settings/unknown-page",
            json={"enabled": True, "mode": "dry_run", "categories": ["spam"], "threshold": 0.85},
        ).status_code
        == 404
    )

    # Validation nghiêm ngặt (extra="forbid", strict=True, threshold 0.5..1, mode, category hợp lệ)
    bad_payloads = [
        {"enabled": "true", "mode": "dry_run", "categories": [], "threshold": 0.85},
        {"enabled": True, "mode": "auto", "categories": [], "threshold": 0.85},
        {"enabled": True, "mode": "dry_run", "categories": ["spam"], "threshold": 0.49},
        {"enabled": True, "mode": "dry_run", "categories": ["spam"], "threshold": 1.01},
        {"enabled": True, "mode": "dry_run", "categories": ["spam"], "threshold": True},
        {"enabled": True, "mode": "dry_run", "categories": ["neutral"], "threshold": 0.85},
        {"enabled": True, "mode": "dry_run", "categories": ["positive"], "threshold": 0.85},
        {"enabled": True, "mode": "dry_run", "categories": ["unknown"], "threshold": 0.85},
        {"enabled": True, "mode": "dry_run", "categories": [], "threshold": 0.85, "extra": 1},
    ]
    for payload in bad_payloads:
        resp = client.put(f"/api/comments/moderation-settings/{PAGE_A}", json=payload)
        assert resp.status_code == 400, (payload, resp.text)


def test_complaint_rejected_in_settings_per_v1_decided_policy():
    # PHASE2(complaint-autohide): v1 không bao giờ cho bật tự ẩn complaint kể cả khi có acknowledgeComplaintRisk
    for ack in (None, False, True):
        payload = {
            "enabled": True,
            "mode": "live",
            "categories": ["spam", "complaint"],
            "threshold": 0.85,
        }
        if ack is not None:
            payload["acknowledgeComplaintRisk"] = ack
        r = client.put(f"/api/comments/moderation-settings/{PAGE_A}", json=payload)
        assert r.status_code == 400, (ack, r.text)
        assert r.json()["code"] == "COMPLAINT_AUTOHIDE_DISABLED"


# ---------------- 3. POST /api/comments/{id}/classify ----------------

def test_classify_rules_categories_no_action_and_never_calls_facebook(monkeypatch):
    fb_calls = []
    monkeypatch.setattr(tools, "hide_fb_comment", lambda *a, **kw: fb_calls.append(("hide", a)) or True)
    monkeypatch.setattr(tools, "delete_fb_comment", lambda *a, **kw: fb_calls.append(("del", a)) or True, raising=False)

    ai_model = FakeModel({"category": "positive", "confidence": 0.95, "reasons": ["khen đẹp"]})
    moderation_api.MODEL = ai_model

    seed_comment("c_pii", message="Giữ size M gọi 0912 345 678 giúp mình")
    seed_comment("c_scam", message="Nhận thưởng tại https://free-gift-2026.xyz/win")
    seed_comment("c_allow", message="Xem mẫu ở https://www.shopee.vn/vay-xoe-123 đẹp quá")
    seed_comment("c_abusive", message="dit me shop lam an chan vcl")
    seed_comment("c_complaint", message="Hàng lỗi bung chỉ rồi, shop giao chậm quá")
    # 3 bình luận trùng lặp trong 24h -> spam lặp
    seed_comment("c_rep1", message="Bán giày thể thao siêu rẻ!", created_time=iso_ago(hours=3))
    seed_comment("c_rep2", message="BAN GIAY THE THAO SIEU RE", created_time=iso_ago(hours=2))
    seed_comment("c_rep3", message="ban giay the thao sieu re...", created_time=iso_ago(hours=1))

    expected_rules = [
        ("c_pii", "pii"),
        ("c_scam", "scam"),
        ("c_abusive", "abusive"),
        ("c_complaint", "complaint"),
        ("c_rep3", "spam"),
    ]
    for cid, cat in expected_rules:
        r = client.post(f"/api/comments/{cid}/classify")
        assert r.status_code == 200, (cid, r.text)
        mod = r.json()["moderation"]
        assert mod["category"] == cat
        assert mod["source"] == "rule"
        assert mod["confidence"] == 1.0
        assert mod["action"] is None
        assert Z_RE.match(mod["at"])
        # Không đổi is_hidden hay status
        saved = moderation_store.get_comment(vpost_api.TENANT_ID, cid)
        assert saved["is_hidden"] == 0 and saved["status"] == "unreplied"
        assert saved["moderation_category"] == cat

    # Luật đã quyết định 5 câu trên -> AI chưa bị gọi lần nào
    assert len(ai_model.calls) == 0

    # Link nằm trong allowlist -> luật không gắn scam, chuyển sang AI
    r_allow = client.post("/api/comments/c_allow/classify")
    assert r_allow.status_code == 200
    assert r_allow.json()["moderation"]["category"] == "positive"
    assert r_allow.json()["moderation"]["source"] == "ai"
    assert len(ai_model.calls) == 1

    # Classify không bao giờ gọi Facebook
    assert fb_calls == []


def test_classify_ai_failure_returns_neutral_and_auth_checks():
    seed_comment("c_norm", message="Váy này mặc đi tiệc cưới hợp không shop?")
    seed_comment("c_page", is_from_page=1, from_id=PAGE_A, message="Dạ hợp lắm ạ!")
    seed_comment("c_del", status="deleted", message="Đã xoá")

    # AI ném ngoại lệ -> neutral với lý do "không phân loại được"
    moderation_api.MODEL = FakeModel(exc=RuntimeError("model down"))
    r1 = client.post("/api/comments/c_norm/classify")
    assert r1.status_code == 200
    assert r1.json()["moderation"]["category"] == "neutral"
    assert r1.json()["moderation"]["reasons"] == ["không phân loại được"]
    assert r1.json()["moderation"]["source"] == "ai"

    # AI trả JSON hỏng -> neutral
    moderation_api.MODEL = FakeModel(raw_text="{bad json")
    r2 = client.post("/api/comments/c_norm/classify")
    assert r2.status_code == 200
    assert r2.json()["moderation"]["category"] == "neutral"
    assert r2.json()["moderation"]["reasons"] == ["không phân loại được"]

    # Page-own -> 403 FORBIDDEN; đã xoá hoặc không tồn tại -> 404 NOT_FOUND; extra field -> 400
    assert client.post("/api/comments/c_page/classify").status_code == 403
    assert client.post("/api/comments/c_del/classify").status_code == 404
    assert client.post("/api/comments/no_such_id/classify").status_code == 404
    assert client.post("/api/comments/c_norm/classify", json={"extra": 1}).status_code == 400


# ---------------- 4. run_auto_moderation ----------------

def test_auto_moderation_off_by_default_and_dry_run_never_calls_facebook(monkeypatch):
    fb_calls = []
    monkeypatch.setattr(tools, "hide_fb_comment", lambda *a, **kw: fb_calls.append(a) or True)

    seed_comment("c1", message="Đ.m shop lừa đảo vcl")
    # Mặc định tắt -> bỏ qua, không gọi Facebook
    s0 = moderation_api.run_auto_moderation(vpost_api.TENANT_ID, ["c1"])
    assert s0["evaluated"] == 0 and s0["autoHidden"] == 0 and s0["wouldHide"] == 0 and s0["skipped"] == 1
    assert fb_calls == []

    # Bật dry_run
    r = client.put(
        f"/api/comments/moderation-settings/{PAGE_A}",
        json={"enabled": True, "mode": "dry_run", "categories": ["abusive", "spam"], "threshold": 0.85},
    )
    assert r.status_code == 200

    s1 = moderation_api.run_auto_moderation(vpost_api.TENANT_ID, ["c1"])
    assert s1["evaluated"] == 1 and s1["wouldHide"] == 1 and s1["autoHidden"] == 0
    assert fb_calls == []  # dry_run tuyệt đối không gọi Facebook

    c1 = moderation_store.get_comment(vpost_api.TENANT_ID, "c1")
    assert c1["is_hidden"] == 0
    assert c1["moderation_category"] == "abusive"
    assert c1["moderation_action"] == "would_hide"

    logs = client.get("/api/comments/moderation-log?action=would_hide&actor=auto").json()["items"]
    assert len(logs) == 1
    assert logs[0]["commentId"] == "c1" and logs[0]["result"] == "ok" and logs[0]["category"] == "abusive"


def test_auto_moderation_live_threshold_categories_and_ai_failure(monkeypatch):
    fb_calls = []
    monkeypatch.setattr(tools, "hide_fb_comment", lambda cid, hidden, ch: fb_calls.append((cid, hidden, ch)) or True)

    assert client.put(
        f"/api/comments/moderation-settings/{PAGE_A}",
        json={"enabled": True, "mode": "live", "categories": ["spam", "pii"], "threshold": 0.85},
    ).status_code == 200

    seed_comment("c_pii", message="Gọi 0912345678 cho mình")
    seed_comment("c_abusive_off", message="dit me shop nay")  # abusive chưa bật -> chỉ flag
    seed_comment("c_ai_high", message="Mua hàng bên mình giá tốt hơn nhiều")
    seed_comment("c_ai_low", message="Nhắn nhẹ hỏi thử")
    seed_comment("c_ai_err", message="Áo này có co giãn không?")

    # Dùng model trả kết quả tuỳ bình luận
    def stub_model(system, user, schema=None):
        if "giá tốt hơn nhiều" in user:
            return {"text": json.dumps({"category": "spam", "confidence": 0.90, "reasons": ["quảng cáo ké"]}), "model": "m", "tokens_in": 10, "tokens_out": 5}
        if "Nhắn nhẹ" in user:
            return {"text": json.dumps({"category": "spam", "confidence": 0.84, "reasons": ["nghi spam"]}), "model": "m", "tokens_in": 10, "tokens_out": 5}
        raise RuntimeError("upstream AI timeout")

    summary = moderation_api.run_auto_moderation(
        vpost_api.TENANT_ID,
        ["c_pii", "c_abusive_off", "c_ai_high", "c_ai_low", "c_ai_err"],
        model=stub_model,
    )
    assert summary["autoHidden"] == 2  # c_pii (rule) + c_ai_high (AI 0.90 >= 0.85)
    assert summary["flagged"] == 2     # c_abusive_off (chưa bật) + c_ai_low (0.84 < 0.85)
    assert summary["failed"] == 0
    assert fb_calls == [("c_pii", True, CHANNEL_A), ("c_ai_high", True, CHANNEL_A)]

    assert moderation_store.get_comment(vpost_api.TENANT_ID, "c_pii")["is_hidden"] == 1
    assert moderation_store.get_comment(vpost_api.TENANT_ID, "c_pii")["moderation_action"] == "auto_hidden"
    assert moderation_store.get_comment(vpost_api.TENANT_ID, "c_ai_high")["is_hidden"] == 1
    assert moderation_store.get_comment(vpost_api.TENANT_ID, "c_abusive_off")["is_hidden"] == 0
    assert moderation_store.get_comment(vpost_api.TENANT_ID, "c_abusive_off")["moderation_action"] == "flagged"
    assert moderation_store.get_comment(vpost_api.TENANT_ID, "c_ai_low")["is_hidden"] == 0
    assert moderation_store.get_comment(vpost_api.TENANT_ID, "c_ai_low")["moderation_action"] == "flagged"
    # AI lỗi -> neutral, tuyệt đối không ẩn
    c_err = moderation_store.get_comment(vpost_api.TENANT_ID, "c_ai_err")
    assert c_err["is_hidden"] == 0
    assert c_err["moderation_category"] == "neutral"
    assert c_err["moderation_reasons"] == ["không phân loại được"]


def test_auto_moderation_complaint_never_auto_hidden_even_if_stored_in_db(monkeypatch):
    fb_calls = []
    monkeypatch.setattr(tools, "hide_fb_comment", lambda *a, **kw: fb_calls.append(a) or True)

    # Giả lập DB có sẵn 'complaint' trong categories — chính sách v1 (# PHASE2(complaint-autohide)) vẫn chặn!
    moderation_store.upsert_setting(
        vpost_api.TENANT_ID,
        PAGE_A,
        enabled=True,
        mode="live",
        categories=["spam", "complaint"],
        threshold=0.5,
    )
    seed_comment("c_cmp", message="Hàng lỗi rách đường may, shop lừa đảo giao chậm quá")

    summary = moderation_api.run_auto_moderation(vpost_api.TENANT_ID, ["c_cmp"])
    assert summary["autoHidden"] == 0 and summary["flagged"] == 1
    assert fb_calls == []

    saved = moderation_store.get_comment(vpost_api.TENANT_ID, "c_cmp")
    assert saved["is_hidden"] == 0
    assert saved["moderation_category"] == "complaint"
    assert saved["moderation_action"] == "flagged"


def test_auto_moderation_skips_page_own_and_already_replied(monkeypatch):
    fb_calls = []
    monkeypatch.setattr(tools, "hide_fb_comment", lambda *a, **kw: fb_calls.append(a) or True)

    assert client.put(
        f"/api/comments/moderation-settings/{PAGE_A}",
        json={"enabled": True, "mode": "live", "categories": ["spam", "abusive", "pii"], "threshold": 0.5},
    ).status_code == 200

    # 1. Bình luận của chính Page (chứa SĐT hotline)
    seed_comment("c_own", is_from_page=1, from_id=PAGE_A, message="Hotline shop 0912345678 ạ!")
    # 2. Bình luận đã ở trạng thái replied
    seed_comment("c_replied_status", status="replied", message="Inbox mình giá rẻ hơn nhé")
    # 3. Bình luận status='unreplied' nhưng đã có Page reply đồng bộ về
    seed_comment("c_has_page_reply", status="unreplied", message="Inbox mình giá rẻ hơn nhé")
    seed_comment(
        "p_reply",
        parent_id="c_has_page_reply",
        is_from_page=1,
        from_id=PAGE_A,
        message="Shop đã inbox ạ",
        created_time=iso_ago(minutes=5),
    )
    # 4. Bình luận có draft status='sent'
    seed_comment("c_sent_draft", status="unreplied", message="Gọi 0912345678")
    store.create_comment_draft(
        vpost_api.TENANT_ID,
        {
            "id": "d-sent-1",
            "comment_id": "c_sent_draft",
            "status": "sent",
            "ai_text": "Dạ shop đã hỗ trợ ạ",
            "edited_text": "Dạ shop đã hỗ trợ ạ",
            "created_at": iso_ago(minutes=10),
            "updated_at": iso_ago(minutes=10),
            "sent_at": iso_ago(minutes=10),
        },
    )
    # 5. Bình luận khách bình thường chưa trả lời -> bị ẩn
    seed_comment("c_target", message="Gọi 0987654321 cho mình")

    summary = moderation_api.run_auto_moderation(
        vpost_api.TENANT_ID,
        ["c_own", "c_replied_status", "c_has_page_reply", "c_sent_draft", "c_target"],
    )
    assert summary["autoHidden"] == 1
    assert summary["skipped"] == 4
    assert fb_calls == [("c_target", True, CHANNEL_A)]


def test_auto_moderation_caps_20_per_run_and_100_per_day_per_page(monkeypatch):
    fb_calls = []
    monkeypatch.setattr(tools, "hide_fb_comment", lambda cid, hidden, ch: fb_calls.append((cid, ch)) or True)

    for pid in (PAGE_A, PAGE_B):
        assert client.put(
            f"/api/comments/moderation-settings/{pid}",
            json={"enabled": True, "mode": "live", "categories": ["spam"], "threshold": 0.85},
        ).status_code == 200

    # Phần 1: 25 spam trên Page A + 2 spam trên Page B trong 1 lượt chạy -> Page A ẩn 20 + flag 5; Page B ẩn 2
    ids_run1 = []
    for i in range(25):
        cid = f"a_run_{i}"
        seed_comment(cid, page_id=PAGE_A, message="Follow chéo tương tác chéo nha mọi người")
        ids_run1.append(cid)
    for i in range(2):
        cid = f"b_run_{i}"
        seed_comment(cid, page_id=PAGE_B, message="Follow chéo tương tác chéo nha mọi người")
        ids_run1.append(cid)

    s1 = moderation_api.run_auto_moderation(vpost_api.TENANT_ID, ids_run1)
    assert s1["autoHidden"] == 22
    assert s1["flagged"] == 5
    assert sum(1 for _, ch in fb_calls if ch == CHANNEL_A) == 20
    assert sum(1 for _, ch in fb_calls if ch == CHANNEL_B) == 2
    for i in range(20, 25):
        c_over = moderation_store.get_comment(vpost_api.TENANT_ID, f"a_run_{i}")
        assert c_over["is_hidden"] == 0 and c_over["moderation_action"] == "flagged"

    # Phần 2: thêm 78 log tự ẩn hôm nay cho Page A (tổng 20 + 78 = 98) + 10 log hôm qua (không tính vào hôm nay)
    today_ts = iso_ago(minutes=1)
    yesterday_ts = iso_ago(days=2)
    for i in range(78):
        moderation_store.append_moderation_log(
            vpost_api.TENANT_ID,
            page_id=PAGE_A,
            comment_id=f"hist_today_{i}",
            action="hide",
            actor="auto",
            category="spam",
            result="ok",
            created_at=today_ts,
        )
    for i in range(10):
        moderation_store.append_moderation_log(
            vpost_api.TENANT_ID,
            page_id=PAGE_A,
            comment_id=f"hist_old_{i}",
            action="hide",
            actor="auto",
            category="spam",
            result="ok",
            created_at=yesterday_ts,
        )

    fb_calls.clear()
    ids_run2 = []
    for i in range(5):
        cid = f"a_day_{i}"
        seed_comment(cid, page_id=PAGE_A, message="Follow chéo tương tác chéo nha")
        ids_run2.append(cid)
    seed_comment("b_day_0", page_id=PAGE_B, message="Follow chéo tương tác chéo nha")
    ids_run2.append("b_day_0")

    s2 = moderation_api.run_auto_moderation(vpost_api.TENANT_ID, ids_run2)
    # Page A còn đúng 2 suất trong ngày (98 -> 100), 3 câu còn lại bị flag; Page B vẫn chạy được 1 câu
    assert s2["autoHidden"] == 3
    assert s2["flagged"] == 3
    assert sum(1 for _, ch in fb_calls if ch == CHANNEL_A) == 2
    assert sum(1 for _, ch in fb_calls if ch == CHANNEL_B) == 1


def test_auto_moderation_never_raises_on_failures_and_rate_limit(monkeypatch):
    assert client.put(
        f"/api/comments/moderation-settings/{PAGE_A}",
        json={"enabled": True, "mode": "live", "categories": ["spam"], "threshold": 0.85},
    ).status_code == 200
    assert client.put(
        f"/api/comments/moderation-settings/{PAGE_B}",
        json={"enabled": True, "mode": "live", "categories": ["spam"], "threshold": 0.85},
    ).status_code == 200

    seed_comment("c_boom", page_id=PAGE_A, message="Follow chéo nhé")
    seed_comment("c_false", page_id=PAGE_A, message="Follow chéo nhé")
    seed_comment("c_rl", page_id=PAGE_A, message="Follow chéo nhé")
    seed_comment("c_after_rl", page_id=PAGE_A, message="Follow chéo nhé")
    seed_comment("c_page_b", page_id=PAGE_B, message="Follow chéo nhé")

    called = []

    def flaky_hide(cid, hidden, ch):
        called.append(cid)
        if cid == "c_boom":
            raise RuntimeError("unexpected crash")
        if cid == "c_false":
            return False
        if cid == "c_rl":
            raise facebook.FacebookError("RATE_LIMITED", "Quá giới hạn")
        return True

    monkeypatch.setattr(tools, "hide_fb_comment", flaky_hide)
    summary = moderation_api.run_auto_moderation(
        vpost_api.TENANT_ID, ["c_boom", "c_false", "c_rl", "c_after_rl", "c_page_b"]
    )
    assert summary["failed"] == 3
    assert summary["autoHidden"] == 1
    assert summary["skipped"] == 1  # c_after_rl bị dừng do RATE_LIMITED trên Page A
    assert summary["stoppedByRateLimit"] is True
    assert called == ["c_boom", "c_false", "c_rl", "c_page_b"]
    assert moderation_store.get_comment(vpost_api.TENANT_ID, "c_false")["is_hidden"] == 0
    assert moderation_store.get_comment(vpost_api.TENANT_ID, "c_page_b")["is_hidden"] == 1


def test_detect_pii_uses_rules_scrub_pii_and_fallback(monkeypatch):
    # Dùng rules.scrub_pii thật
    assert moderation_api.detect_pii("Gọi 0912 345 678 hoặc a@b.com") != []
    assert moderation_api.detect_pii("Váy giá 890.000đ ngày 01.02.2026") == []

    # Nếu rules.scrub_pii phát hiện mẫu mới (vd địa chỉ), detect_pii tự bắt được
    monkeypatch.setattr(rules, "scrub_pii", lambda s: s.replace("123 Lê Lợi", "[đã ẩn]"))
    spans = moderation_api.detect_pii("Giao tới 123 Lê Lợi nhé")
    assert spans == [(9, 19)]

    # Khi rules.scrub_pii không tồn tại -> dùng fallback cục bộ
    monkeypatch.delattr(rules, "scrub_pii")
    assert moderation_api.detect_pii("SĐT 0912-345-678 và test@shop.vn") != []
    assert moderation_api.detect_pii("Ngày 01.02.2026 14h giá 890.000đ") == []


# ---------------- 5. POST /api/comments/bulk ----------------

def test_bulk_validation_strict_limits_and_unique():
    bad = [
        {"ids": [], "action": "hide"},
        {"ids": [f"c{i}" for i in range(51)], "action": "hide"},
        {"ids": ["c1", "c1"], "action": "hide"},
        {"ids": ["   "], "action": "hide"},
        {"ids": [123], "action": "hide"},
        {"ids": ["c1"], "action": "reply"},
        {"ids": ["c1"], "action": "delete", "confirm": "true"},
        {"ids": ["c1"], "action": "hide", "extra": True},
    ]
    for payload in bad:
        r = client.post("/api/comments/bulk", json=payload)
        assert r.status_code == 400 and r.json()["code"] == "INVALID_INPUT", (payload, r.text)


def test_bulk_hide_unhide_ignore_unignore_and_audit_log(monkeypatch):
    fb_calls = []
    monkeypatch.setattr(tools, "hide_fb_comment", lambda cid, hidden, ch: fb_calls.append((cid, hidden, ch)) or True)

    seed_comment("c1", message="Spam 1")
    seed_comment("c2", message="Spam 2")
    # Giả lập c1 từng bị auto_hidden
    moderation_store.update_comment_moderation(
        vpost_api.TENANT_ID,
        "c1",
        category="spam",
        confidence=1.0,
        reasons=["spam"],
        source="rule",
        action="auto_hidden",
    )
    # c2 có sẵn trả lời từ Page để kiểm tra unignore khôi phục về 'replied'
    seed_comment("p2", parent_id="c2", is_from_page=1, from_id=PAGE_A, message="Dạ ạ", created_time=iso_ago(minutes=5))

    r_hide = client.post("/api/comments/bulk", json={"ids": ["c1", "c2"], "action": "hide"})
    assert r_hide.status_code == 200
    assert r_hide.json() == {
        "tenantId": vpost_api.TENANT_ID,
        "results": [{"id": "c1", "ok": True}, {"id": "c2", "ok": True}],
        "processed": 2,
        "failed": 0,
        "notProcessed": [],
    }
    assert fb_calls == [("c1", True, CHANNEL_A), ("c2", True, CHANNEL_A)]
    assert moderation_store.get_comment(vpost_api.TENANT_ID, "c1")["is_hidden"] == 1

    # Unhide (hoàn tác) -> is_hidden=0 và xoá nhãn auto_hidden
    r_unhide = client.post("/api/comments/bulk", json={"ids": ["c1"], "action": "unhide"})
    assert r_unhide.status_code == 200 and r_unhide.json()["processed"] == 1
    c1 = moderation_store.get_comment(vpost_api.TENANT_ID, "c1")
    assert c1["is_hidden"] == 0 and c1["moderation_action"] == ""

    # Ignore & unignore (không gọi Facebook)
    fb_calls.clear()
    assert client.post("/api/comments/bulk", json={"ids": ["c1", "c2"], "action": "ignore"}).json()["processed"] == 2
    assert moderation_store.get_comment(vpost_api.TENANT_ID, "c1")["status"] == "ignored"
    assert moderation_store.get_comment(vpost_api.TENANT_ID, "c2")["status"] == "ignored"

    assert client.post("/api/comments/bulk", json={"ids": ["c1", "c2"], "action": "unignore"}).json()["processed"] == 2
    assert moderation_store.get_comment(vpost_api.TENANT_ID, "c1")["status"] == "unreplied"
    assert moderation_store.get_comment(vpost_api.TENANT_ID, "c2")["status"] == "replied"
    assert fb_calls == []

    # Nhật ký có đủ bản ghi cho cả 4 hành động (2 hide + 1 unhide + 2 ignore + 2 unignore = 7)
    all_logs = client.get("/api/comments/moderation-log?limit=50").json()["items"]
    assert len(all_logs) == 7
    assert {l["action"] for l in all_logs} == {"hide", "unhide", "ignore", "unignore"}
    assert all(l["actor"] == "operator" and l["result"] == "ok" for l in all_logs)


def test_bulk_mixed_results_not_found_and_forbidden(monkeypatch):
    fb_calls = []
    monkeypatch.setattr(tools, "hide_fb_comment", lambda cid, hidden, ch: fb_calls.append(cid) or True)

    seed_comment("c_ok", message="Khách spam")
    seed_comment("c_page", is_from_page=1, from_id=PAGE_A, message="Page trả lời")
    seed_comment("c_other", tenant_id=OTHER_TENANT, message="Bình luận tenant khác")

    r = client.post(
        "/api/comments/bulk",
        json={"ids": ["c_ok", "does_not_exist", "c_other", "c_page"], "action": "hide"},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["processed"] == 1
    assert body["failed"] == 3
    assert body["notProcessed"] == []
    by_id = {item["id"]: item for item in body["results"]}
    assert by_id["c_ok"] == {"id": "c_ok", "ok": True}
    assert by_id["does_not_exist"]["ok"] is False and by_id["does_not_exist"]["code"] == "NOT_FOUND"
    assert by_id["c_other"]["ok"] is False and by_id["c_other"]["code"] == "NOT_FOUND"
    assert by_id["c_page"]["ok"] is False and by_id["c_page"]["code"] == "FORBIDDEN"
    assert fb_calls == ["c_ok"]

    logs = client.get("/api/comments/moderation-log?limit=20").json()["items"]
    assert len(logs) == 4


def test_bulk_delete_requires_confirm_and_handles_missing_tool_and_already_deleted(monkeypatch):
    seed_comment("c1", message="Xoá 1")
    seed_comment("c2", message="Xoá 2 đã mất trên FB")
    seed_comment("c3", message="Xoá 3 not found trên FB")
    seed_comment("c_page", is_from_page=1, from_id=PAGE_A, message="Page")

    # 1. Thiếu confirm hoặc confirm=false -> 400 CONFIRM_REQUIRED
    for payload in (
        {"ids": ["c1"], "action": "delete"},
        {"ids": ["c1"], "action": "delete", "confirm": False},
    ):
        r = client.post("/api/comments/bulk", json=payload)
        assert r.status_code == 400 and r.json()["code"] == "CONFIRM_REQUIRED"

    # 2. Khi tools.delete_fb_comment chưa tồn tại -> trả UPSTREAM_ERROR "chưa hỗ trợ xoá" cho từng mục hợp lệ
    if hasattr(tools, "delete_fb_comment"):
        monkeypatch.delattr(tools, "delete_fb_comment")
    r_missing = client.post(
        "/api/comments/bulk",
        json={"ids": ["c1", "c_page", "missing_id"], "action": "delete", "confirm": True},
    )
    assert r_missing.status_code == 200
    res_map = {x["id"]: x for x in r_missing.json()["results"]}
    assert res_map["c1"] == {"id": "c1", "ok": False, "code": "UPSTREAM_ERROR", "message": "chưa hỗ trợ xoá"}
    assert res_map["c_page"]["code"] == "FORBIDDEN"
    assert res_map["missing_id"]["code"] == "NOT_FOUND"
    assert moderation_store.get_comment(vpost_api.TENANT_ID, "c1")["status"] == "unreplied"

    # 3. Khi tools.delete_fb_comment tồn tại: thành công + Graph code 100 / NOT_FOUND tính là đã xoá
    del_calls = []

    def fake_delete(channel_id, cid):
        del_calls.append((channel_id, cid))
        if cid == "c2":
            raise facebook.FacebookError("GRAPH_ERROR", "Facebook từ chối: (#100) Object with ID 'c2' does not exist")
        if cid == "c3":
            raise facebook.FacebookError("NOT_FOUND", "Comment not found")
        return True

    monkeypatch.setattr(tools, "delete_fb_comment", fake_delete, raising=False)
    r_del = client.post(
        "/api/comments/bulk",
        json={"ids": ["c1", "c2", "c3"], "action": "delete", "confirm": True},
    )
    assert r_del.status_code == 200
    body = r_del.json()
    assert body["processed"] == 3 and body["failed"] == 0 and body["notProcessed"] == []
    assert del_calls == [(CHANNEL_A, "c1"), (CHANNEL_A, "c2"), (CHANNEL_A, "c3")]

    # Soft delete: dòng vẫn giữ trong PostgreSQL với status='deleted' để đối soát
    for cid in ("c1", "c2", "c3"):
        row = moderation_store.get_comment(vpost_api.TENANT_ID, cid)
        assert row is not None and row["status"] == "deleted"

    del_logs = client.get("/api/comments/moderation-log?action=delete&limit=20").json()["items"]
    ok_logs = [l for l in del_logs if l["result"] == "ok"]
    assert {l["commentId"] for l in ok_logs} == {"c1", "c2", "c3"}


def test_bulk_rate_limit_stops_batch_returns_not_processed_and_pauses(monkeypatch):
    for cid in ("c1", "c2", "c3", "c4"):
        seed_comment(cid, message="Spam " + cid)

    calls = []
    sleeps = []
    moderation_api.FB_WRITE_PAUSE_SEC = 0.01
    moderation_api._sleep = lambda sec: sleeps.append(sec)

    def rate_limited_hide(cid, hidden, ch):
        calls.append(cid)
        if cid == "c2":
            raise facebook.FacebookError("RATE_LIMITED", "Facebook đang giới hạn tần suất gọi API")
        return True

    monkeypatch.setattr(tools, "hide_fb_comment", rate_limited_hide)
    r = client.post("/api/comments/bulk", json={"ids": ["c1", "c2", "c3", "c4"], "action": "hide"})
    assert r.status_code == 200
    body = r.json()
    assert calls == ["c1", "c2"]  # c3, c4 không bao giờ bị gọi
    assert len(sleeps) == 1       # nghỉ ngắn giữa lần ghi 1 và lần ghi 2
    assert body["processed"] == 1
    assert body["failed"] == 1
    assert body["notProcessed"] == ["c3", "c4"]
    assert body["results"][0] == {"id": "c1", "ok": True}
    assert body["results"][1]["id"] == "c2" and body["results"][1]["ok"] is False
    assert body["results"][1]["code"] == "RATE_LIMITED"


# ---------------- 6. Nhật ký phân trang/lọc & cô lập tenant (403 / 404) ----------------

def test_moderation_log_filters_and_cursor_pagination():
    # Ghi 5 bản ghi khác nhau về pageId, action, actor
    entries = [
        ("l1", PAGE_A, "c1", "hide", "operator", "ok", iso_ago(hours=5)),
        ("l2", PAGE_A, "c2", "would_hide", "auto", "ok", iso_ago(hours=4)),
        ("l3", PAGE_B, "c3", "hide", "auto", "ok", iso_ago(hours=3)),
        ("l4", PAGE_A, "c4", "delete", "operator", "ok", iso_ago(hours=2)),
        ("l5", PAGE_B, "c5", "ignore", "operator", "ok", iso_ago(hours=1)),
    ]
    for lid, pid, cid, act, actor, res, ts in entries:
        moderation_store.append_moderation_log(
            vpost_api.TENANT_ID,
            log_id=lid,
            page_id=pid,
            comment_id=cid,
            action=act,
            actor=actor,
            result=res,
            created_at=ts,
        )
    # Bản ghi của tenant khác tuyệt đối không xuất hiện
    moderation_store.append_moderation_log(
        OTHER_TENANT,
        log_id="l_other",
        page_id=PAGE_A,
        comment_id="c_other",
        action="hide",
        actor="auto",
        result="ok",
        created_at=iso_ago(minutes=1),
    )

    p1 = client.get("/api/comments/moderation-log?limit=2").json()
    assert [i["id"] for i in p1["items"]] == ["l5", "l4"]
    assert p1["nextCursor"] == "2" and p1["limit"] == 2
    assert all(Z_RE.match(i["createdAt"]) for i in p1["items"])

    p2 = client.get("/api/comments/moderation-log?limit=2&cursor=" + p1["nextCursor"]).json()
    assert [i["id"] for i in p2["items"]] == ["l3", "l2"]
    assert p2["nextCursor"] == "4"

    p3 = client.get("/api/comments/moderation-log?limit=2&cursor=" + p2["nextCursor"]).json()
    assert [i["id"] for i in p3["items"]] == ["l1"]
    assert p3["nextCursor"] is None

    # Lọc kết hợp
    by_page_actor = client.get(f"/api/comments/moderation-log?pageId={PAGE_A}&actor=operator").json()
    assert [i["id"] for i in by_page_actor["items"]] == ["l4", "l1"]

    by_action = client.get("/api/comments/moderation-log?action=hide").json()
    assert [i["id"] for i in by_action["items"]] == ["l3", "l1"]

    # Tham số rỗng hợp lệ; tham số sai -> 400
    assert client.get("/api/comments/moderation-log?pageId=&action=&actor=&cursor=").status_code == 200
    assert client.get("/api/comments/moderation-log?action=bogus").status_code == 400
    assert client.get("/api/comments/moderation-log?actor=bot").status_code == 400
    assert client.get("/api/comments/moderation-log?cursor=-1").status_code == 400
    assert client.get("/api/comments/moderation-log?cursor=abc").status_code == 400


def test_other_tenant_cookie_403_and_cross_tenant_404():
    seed_comment("c_mine", tenant_id=vpost_api.TENANT_ID, message="Mine")
    seed_comment("c_other", tenant_id=OTHER_TENANT, message="Other")

    # ID của tenant khác -> 404 NOT_FOUND trên /classify và per-item NOT_FOUND trên /bulk
    r_cls = client.post("/api/comments/c_other/classify")
    assert r_cls.status_code == 404 and r_cls.json()["code"] == "NOT_FOUND"

    r_bulk = client.post("/api/comments/bulk", json={"ids": ["c_other"], "action": "ignore"})
    assert r_bulk.status_code == 200
    assert r_bulk.json()["results"][0]["code"] == "NOT_FOUND"

    # Cookie tenant khác -> 403 FORBIDDEN trên toàn bộ endpoint kiểm duyệt
    other_client = TestClient(app)
    other_client.cookies.set(vpost_api.TENANT_COOKIE, OTHER_TENANT)
    for method, path, payload in (
        ("POST", "/api/comments/bulk", {"ids": ["c_mine"], "action": "ignore"}),
        ("GET", "/api/comments/moderation-settings", None),
        (
            "PUT",
            f"/api/comments/moderation-settings/{PAGE_A}",
            {"enabled": True, "mode": "dry_run", "categories": ["spam"], "threshold": 0.85},
        ),
        ("GET", "/api/comments/moderation-log", None),
        ("POST", "/api/comments/c_mine/classify", None),
    ):
        resp = other_client.request(method, path, json=payload)
        assert resp.status_code == 403 and resp.json()["code"] == "FORBIDDEN", (method, path, resp.text)


# ---------------- 7. Real server.app wiring & Asia/Ho_Chi_Minh daily cap boundary ----------------

def test_real_server_app_exposes_all_moderation_routes_without_shadowing(monkeypatch):
    # Verify route registration order on the real server.app: static moderation routes come BEFORE /api/comments/{id}
    route_paths = [getattr(r, "path", "") for r in server.app.routes]
    idx_bulk = route_paths.index("/api/comments/bulk")
    idx_settings = route_paths.index("/api/comments/moderation-settings")
    idx_settings_put = route_paths.index("/api/comments/moderation-settings/{page_id}")
    idx_log = route_paths.index("/api/comments/moderation-log")
    idx_classify = route_paths.index("/api/comments/{comment_id}/classify")
    vpost_comment_id_indices = [
        i for i, p in enumerate(route_paths)
        if p.startswith("/api/comments/{comment_id}/") and p != "/api/comments/{comment_id}/classify"
    ]
    assert vpost_comment_id_indices
    first_vpost_id_route = min(vpost_comment_id_indices)
    assert idx_bulk < first_vpost_id_route
    assert idx_settings < first_vpost_id_route
    assert idx_settings_put < first_vpost_id_route
    assert idx_log < first_vpost_id_route
    assert idx_classify < first_vpost_id_route

    real_client = TestClient(server.app)
    seed_comment("c_real_1", message="Follow chéo tương tác chéo nhé")
    seed_comment("c_real_del", message="Xoá bình luận spam này")

    # Every moderation route works on the real server.app
    r_settings = real_client.get("/api/comments/moderation-settings")
    assert r_settings.status_code == 200 and [i["pageId"] for i in r_settings.json()["items"]] == [PAGE_A, PAGE_B]

    r_put = real_client.put(
        f"/api/comments/moderation-settings/{PAGE_A}",
        json={"enabled": True, "mode": "dry_run", "categories": ["spam"], "threshold": 0.85},
    )
    assert r_put.status_code == 200 and r_put.json()["setting"]["enabled"] is True

    r_bulk = real_client.post("/api/comments/bulk", json={"ids": ["c_real_1"], "action": "ignore"})
    assert r_bulk.status_code == 200 and r_bulk.json()["processed"] == 1

    # Bulk delete through the real tools.delete_fb_comment (verify channel_id, comment_id arg order)
    fb_del_calls = []
    monkeypatch.setattr(facebook, "delete_comment", lambda cid, tok: (fb_del_calls.append((cid, tok)), True)[1])
    r_bulk_del = real_client.post(
        "/api/comments/bulk",
        json={"ids": ["c_real_del"], "action": "delete", "confirm": True},
    )
    assert r_bulk_del.status_code == 200 and r_bulk_del.json()["processed"] == 1
    assert fb_del_calls == [("c_real_del", "EAAG_TOKEN_A")]

    r_cls = real_client.post("/api/comments/c_real_1/classify")
    assert r_cls.status_code == 200 and r_cls.json()["moderation"]["category"] == "spam"

    r_log = real_client.get("/api/comments/moderation-log")
    assert r_log.status_code == 200 and len(r_log.json()["items"]) == 2

    # vpost_api comment routes still work and exclude soft-deleted c_real_del
    r_list = real_client.get("/api/comments")
    assert r_list.status_code == 200
    assert [i["id"] for i in r_list.json()["items"]] == ["c_real_1"]
    assert r_list.json()["items"][0]["moderation"]["category"] == "spam"
    assert real_client.post("/api/comments/c_real_1/unignore").status_code == 200


def test_daily_auto_hide_cap_resets_at_ho_chi_minh_midnight_not_utc(monkeypatch):
    # Direct unit check of _local_day_start around 00:00 Asia/Ho_Chi_Minh (= 17:00 UTC)
    before_vn_midnight = datetime(2026, 11, 27, 16, 59, 59, tzinfo=timezone.utc)  # 2026-11-27 23:59:59+07:00
    at_vn_midnight = datetime(2026, 11, 27, 17, 0, 0, tzinfo=timezone.utc)        # 2026-11-28 00:00:00+07:00
    assert moderation_api._local_day_start(before_vn_midnight) == datetime(2026, 11, 26, 17, 0, 0, tzinfo=timezone.utc)
    assert moderation_api._local_day_start(at_vn_midnight) == datetime(2026, 11, 27, 17, 0, 0, tzinfo=timezone.utc)
    assert moderation_api._local_day_start(datetime(2026, 11, 27, 23, 59, 0, tzinfo=schedule.TZ)) == datetime(
        2026, 11, 26, 17, 0, 0, tzinfo=timezone.utc
    )

    fb_calls = []
    monkeypatch.setattr(tools, "hide_fb_comment", lambda cid, hidden, ch: fb_calls.append((cid, hidden, ch)) or True)
    assert client.put(
        f"/api/comments/moderation-settings/{PAGE_A}",
        json={"enabled": True, "mode": "live", "categories": ["spam"], "threshold": 0.85},
    ).status_code == 200

    # Seed 100 auto-hides at 2026-11-27 00:05:00+07:00 (= 2026-11-26T17:05:00.000Z — previous UTC day, VN day Nov 27!)
    vn_morning_ts = "2026-11-26T17:05:00.000Z"
    for i in range(moderation_api.AUTO_HIDE_DAILY_CAP):
        moderation_store.append_moderation_log(
            vpost_api.TENANT_ID,
            page_id=PAGE_A,
            comment_id=f"hist_vn_{i}",
            action="hide",
            actor="auto",
            category="spam",
            result="ok",
            created_at=vn_morning_ts,
        )

    # 1. Across 00:00 UTC (2026-11-27T01:00:00Z = 08:00+07:00, SAME VN day Nov 27): cap must NOT reset!
    monkeypatch.setattr(moderation_api, "_now", lambda: datetime(2026, 11, 27, 1, 0, 0, tzinfo=timezone.utc))
    seed_comment("c_after_utc_mid", page_id=PAGE_A, message="Follow chéo tương tác chéo nha")
    s_utc = moderation_api.run_auto_moderation(vpost_api.TENANT_ID, ["c_after_utc_mid"])
    assert s_utc["autoHidden"] == 0 and s_utc["flagged"] == 1
    assert fb_calls == []

    # 2. 30s before 00:00 Asia/Ho_Chi_Minh (2026-11-27T16:59:30Z = 23:59:30+07:00): cap still reached!
    monkeypatch.setattr(moderation_api, "_now", lambda: datetime(2026, 11, 27, 16, 59, 30, tzinfo=timezone.utc))
    seed_comment("c_before_vn_mid", page_id=PAGE_A, message="Follow chéo tương tác chéo nha")
    s_before = moderation_api.run_auto_moderation(vpost_api.TENANT_ID, ["c_before_vn_mid"])
    assert s_before["autoHidden"] == 0 and s_before["flagged"] == 1
    assert fb_calls == []

    # 3. 1s after 00:00 Asia/Ho_Chi_Minh (2026-11-27T17:00:01Z = 2026-11-28 00:00:01+07:00, still UTC Nov 27): cap RESETS!
    monkeypatch.setattr(moderation_api, "_now", lambda: datetime(2026, 11, 27, 17, 0, 1, tzinfo=timezone.utc))
    seed_comment("c_after_vn_mid", page_id=PAGE_A, message="Follow chéo tương tác chéo nha")
    s_after = moderation_api.run_auto_moderation(vpost_api.TENANT_ID, ["c_after_vn_mid"])
    assert s_after["autoHidden"] == 1 and s_after["flagged"] == 0
    assert fb_calls == [("c_after_vn_mid", True, CHANNEL_A)]


def test_moderation_log_same_timestamp_deterministic_seq_order_and_seq_not_exposed():
    same_ts = "2026-11-27T10:00:00.000Z"
    for lid in ("l_first", "l_second", "l_third", "l_fourth"):
        moderation_store.append_moderation_log(
            vpost_api.TENANT_ID,
            log_id=lid,
            page_id=PAGE_A,
            comment_id="c_" + lid,
            action="hide",
            actor="operator",
            result="ok",
            created_at=same_ts,
        )

    store_items, _ = moderation_store.list_moderation_logs(vpost_api.TENANT_ID, limit=10)
    assert [r["id"] for r in store_items] == ["l_fourth", "l_third", "l_second", "l_first"]
    assert all("seq" not in r for r in store_items)

    api_resp = client.get("/api/comments/moderation-log?limit=10")
    assert api_resp.status_code == 200
    api_items = api_resp.json()["items"]
    assert [i["id"] for i in api_items] == ["l_fourth", "l_third", "l_second", "l_first"]
    assert all("seq" not in i for i in api_items)


def test_auto_moderation_daily_cap_race_safe_under_concurrency(monkeypatch):
    from concurrent.futures import ThreadPoolExecutor
    import threading

    assert client.put(
        f"/api/comments/moderation-settings/{PAGE_A}",
        json={"enabled": True, "mode": "live", "categories": ["spam"], "threshold": 0.85},
    ).status_code == 200

    # Pre-seed 96 auto-hides today -> only 4 daily slots remain out of 100.
    today_ts = iso_ago(minutes=2)
    for i in range(moderation_api.AUTO_HIDE_DAILY_CAP - 4):
        moderation_store.append_moderation_log(
            vpost_api.TENANT_ID,
            page_id=PAGE_A,
            comment_id=f"pre_{i}",
            action="hide",
            actor="auto",
            category="spam",
            result="ok",
            created_at=today_ts,
        )

    batches = []
    for worker_idx in range(4):
        ids = []
        for j in range(4):
            cid = f"conc_{worker_idx}_{j}"
            seed_comment(cid, page_id=PAGE_A, message="Follow chéo tương tác chéo nha")
            ids.append(cid)
        batches.append(ids)

    fb_lock = threading.Lock()
    fb_calls = []

    def slow_hide(cid, hidden, ch):
        with fb_lock:
            fb_calls.append((cid, hidden, ch))
        return True

    monkeypatch.setattr(tools, "hide_fb_comment", slow_hide)

    barrier = threading.Barrier(len(batches))

    def run_worker(comment_ids):
        barrier.wait()
        return moderation_api.run_auto_moderation(vpost_api.TENANT_ID, comment_ids)

    with ThreadPoolExecutor(max_workers=len(batches)) as pool:
        results = list(pool.map(run_worker, batches))

    total_hidden = sum(r["autoHidden"] for r in results)
    total_flagged = sum(r["flagged"] for r in results)
    assert total_hidden == 4
    assert total_flagged == 12
    assert len(fb_calls) == 4
    day_start = moderation_api._local_day_start(moderation_api._now())
    assert moderation_store.count_auto_actions_since(vpost_api.TENANT_ID, PAGE_A, day_start) == moderation_api.AUTO_HIDE_DAILY_CAP
