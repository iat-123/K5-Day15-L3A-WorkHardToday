import io
import json
import os
import sys
import uuid
from typing import Any, Optional

import httpx

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "scripts"))

import comments_smoke as smoke  # noqa: E402

TENANT_ID = "00000000-0000-4000-8000-000000000001"
SECRET_TOKEN = "EAAG_SUPER_SECRET_PAGE_TOKEN_999999"
FULL_AUTHOR = "Nguyễn Lan Anh"


class StubVpostServer:
    """Máy chủ VPOST giả lập cho httpx.MockTransport — không gọi mạng thật."""

    def __init__(
        self,
        *,
        channels: Optional[list[dict[str, Any]]] = None,
        sync_response: Optional[tuple[int, dict[str, Any]]] = None,
        comments: Optional[list[dict[str, Any]]] = None,
        draft_status: str = "draft",
        draft_text: str = "Dạ Đầm Voan Hoa G1 giá 890.000đ còn màu đen size M bạn nhé!",
        counts_override: Optional[dict[str, int]] = None,
        duplicate_reply_status: int = 409,
        enforce_tenant_cookie: bool = True,
        empty_reply_status: int = 400,
        unknown_id_status: int = 404,
    ):
        self.requests: list[httpx.Request] = []
        self.channels = (
            channels
            if channels is not None
            else [
                {
                    "channelId": "fb-123456",
                    "platform": "facebook",
                    "name": "WorkHardToday",
                    "externalId": "123456",
                    "status": "active",
                    "tokenExpiresAt": None,
                },
                {
                    "channelId": "diu-may",
                    "platform": "facebook",
                    "name": "Dịu Mây (chỉ lịch trong app)",
                    "externalId": "diu-may",
                    "status": "active",
                    "tokenExpiresAt": None,
                },
            ]
        )
        self.sync_response = sync_response or (
            200,
            {
                "tenantId": TENANT_ID,
                "syncedPosts": 2,
                "newComments": 3,
                "updatedComments": 1,
                "errors": [],
            },
        )
        self.comments: dict[str, dict[str, Any]] = {}
        default_comments = (
            comments
            if comments is not None
            else [
                {
                    "id": "c_unrep_1",
                    "channelId": "fb-123456",
                    "channelName": "WorkHardToday",
                    "pageId": "123456",
                    "postJobId": "job-1",
                    "productCode": "G1",
                    "postCaption": "Đầm Voan Hoa G1",
                    "postUrl": "https://www.facebook.com/123456_1001",
                    "fromName": FULL_AUTHOR,
                    "message": "Mẫu này giá bao nhiêu và còn size M không shop?",
                    "createdAt": "2026-11-27T10:00:00.000Z",
                    "permalinkUrl": "https://www.facebook.com/123456_1001?comment_id=c_unrep_1",
                    "isHidden": False,
                    "canComment": True,
                    "status": "unreplied",
                    "pageReplies": [],
                    "draft": None,
                },
                {
                    "id": "c_rep_1",
                    "channelId": "fb-123456",
                    "channelName": "WorkHardToday",
                    "pageId": "123456",
                    "postJobId": "job-1",
                    "productCode": "G1",
                    "postCaption": "Đầm Voan Hoa G1",
                    "postUrl": "https://www.facebook.com/123456_1001",
                    "fromName": "Trần Minh Thư",
                    "message": "Còn màu đen không ạ?",
                    "createdAt": "2026-11-27T09:00:00.000Z",
                    "permalinkUrl": "https://www.facebook.com/123456_1001?comment_id=c_rep_1",
                    "isHidden": False,
                    "canComment": True,
                    "status": "replied",
                    "pageReplies": [{"id": "p1", "message": "Dạ còn ạ", "createdAt": "2026-11-27T09:05:00.000Z"}],
                    "draft": None,
                },
            ]
        )
        for c in default_comments:
            self.comments[c["id"]] = dict(c)

        self.draft_status = draft_status
        self.draft_text = draft_text
        self.counts_override = counts_override
        self.duplicate_reply_status = duplicate_reply_status
        self.enforce_tenant_cookie = enforce_tenant_cookie
        self.empty_reply_status = empty_reply_status
        self.unknown_id_status = unknown_id_status
        self.reply_calls: list[tuple[str, str]] = []
        self.hide_calls: list[tuple[str, bool]] = []

    def transport(self) -> httpx.MockTransport:
        return httpx.MockTransport(self.handle)

    def _json_body(self, request: httpx.Request) -> dict[str, Any]:
        if not request.content:
            return {}
        return json.loads(request.content.decode("utf-8"))

    def _counts(self) -> dict[str, int]:
        if self.counts_override is not None:
            return dict(self.counts_override)
        return {
            st: sum(1 for c in self.comments.values() if c["status"] == st)
            for st in ("unreplied", "replied", "ignored")
        }

    def handle(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)

        # Kiểm tra cookie cô lập tenant giống codebase/vpost_api.py
        cookie_hdr = request.headers.get("cookie", "")
        if self.enforce_tenant_cookie and f"{smoke.TENANT_COOKIE}=" in cookie_hdr:
            for part in cookie_hdr.split(";"):
                part = part.strip()
                if part.startswith(f"{smoke.TENANT_COOKIE}="):
                    val = part.split("=", 1)[1].strip()
                    if val and val != TENANT_ID:
                        return httpx.Response(
                            403,
                            json={"code": "FORBIDDEN", "message": "Công ty đang chọn không có quyền với dữ liệu shop này."},
                        )

        path = request.url.path
        method = request.method.upper()

        if method == "GET" and path == "/api/channels":
            return httpx.Response(200, json={"tenantId": TENANT_ID, "channels": self.channels, "secretsConfigured": True})

        if method == "POST" and path == "/api/comments/sync":
            status, payload = self.sync_response
            return httpx.Response(status, json=payload)

        if method == "GET" and path == "/api/comments":
            st = request.url.params.get("status")
            items = list(self.comments.values())
            if st:
                items = [c for c in items if c["status"] == st]
            return httpx.Response(
                200,
                json={
                    "tenantId": TENANT_ID,
                    "items": items,
                    "nextCursor": None,
                    "limit": int(request.url.params.get("limit") or 20),
                    "counts": self._counts(),
                },
            )

        if path.startswith("/api/comments/"):
            parts = path[len("/api/comments/") :].split("/")
            if len(parts) == 2:
                cid, action = parts
                body = self._json_body(request)

                if action == "reply" and method == "POST":
                    text = str(body.get("text") or "")
                    if not text.strip():
                        return httpx.Response(
                            self.empty_reply_status,
                            json={"code": "INVALID_INPUT", "message": "nội dung không được để trống"},
                        )
                    c = self.comments.get(cid)
                    if not c:
                        return httpx.Response(self.unknown_id_status, json={"code": "NOT_FOUND", "message": "Không tìm thấy"})
                    self.reply_calls.append((cid, text.strip()))
                    if c["status"] == "replied":
                        if self.duplicate_reply_status == 200:
                            return httpx.Response(200, json={"tenantId": TENANT_ID, "comment": c})
                        return httpx.Response(
                            self.duplicate_reply_status,
                            json={"code": "CONFLICT", "message": "Bình luận này đã được trả lời hoặc đang gửi"},
                        )
                    c["status"] = "replied"
                    c["draft"] = {
                        "id": "d1",
                        "status": "sent",
                        "text": text.strip(),
                        "aiText": self.draft_text,
                        "reasons": [],
                        "warnings": [],
                        "errorCode": None,
                        "userMessage": "Đã gửi trả lời lên Facebook",
                        "updatedAt": "2026-11-27T10:05:00.000Z",
                    }
                    return httpx.Response(200, json={"tenantId": TENANT_ID, "comment": c})

                c = self.comments.get(cid)
                if not c:
                    if self.unknown_id_status == 200:
                        return httpx.Response(200, json={"tenantId": TENANT_ID, "comment": {"id": cid}})
                    return httpx.Response(self.unknown_id_status, json={"code": "NOT_FOUND", "message": "Không tìm thấy bình luận này"})

                if action == "draft" and method == "POST":
                    c["draft"] = {
                        "id": "d1",
                        "status": self.draft_status,
                        "text": "" if self.draft_status == "flagged" else self.draft_text,
                        "aiText": "" if self.draft_status == "flagged" else self.draft_text,
                        "reasons": [{"field": "order", "issue": "cần nhân viên kiểm tra"}] if self.draft_status == "flagged" else [],
                        "warnings": [],
                        "errorCode": None,
                        "userMessage": None,
                        "updatedAt": "2026-11-27T10:02:00.000Z",
                    }
                    return httpx.Response(200, json={"tenantId": TENANT_ID, "comment": c})

                if action == "draft" and method == "PATCH":
                    text = str(body.get("text") or "").strip()
                    if not text:
                        return httpx.Response(400, json={"code": "INVALID_INPUT", "message": "nội dung không được để trống"})
                    draft = dict(c.get("draft") or {"id": "d1", "status": "draft", "aiText": "", "reasons": [], "warnings": []})
                    draft["text"] = text
                    c["draft"] = draft
                    return httpx.Response(
                        200,
                        json={
                            "tenantId": TENANT_ID,
                            "comment": c,
                            "check": {"block": [], "warn": ["độ dài 80 ký tự (nên 150–1.500)"]},
                        },
                    )

                if action == "hide" and method == "POST":
                    hidden = body.get("hidden")
                    if not isinstance(hidden, bool):
                        return httpx.Response(400, json={"code": "INVALID_INPUT", "message": "hidden phải là bool"})
                    self.hide_calls.append((cid, hidden))
                    c["isHidden"] = hidden
                    return httpx.Response(200, json={"tenantId": TENANT_ID, "comment": c})

        return httpx.Response(404, json={"code": "NOT_FOUND", "message": "route not mocked"})


def _fb_write_requests(requests: list[httpx.Request]) -> list[httpx.Request]:
    """Lọc mọi request có khả năng ghi lên Facebook (POST /hide, hoặc POST /reply có nội dung không rỗng)."""
    writes: list[httpx.Request] = []
    for req in requests:
        if req.method.upper() != "POST":
            continue
        if req.url.path.endswith("/hide"):
            writes.append(req)
        elif req.url.path.endswith("/reply"):
            body = json.loads(req.content.decode("utf-8")) if req.content else {}
            if str(body.get("text") or "").strip():
                writes.append(req)
    return writes


# ---------------- 1. Helper unit tests ----------------

def test_helpers_initials_pii_and_redaction(monkeypatch):
    monkeypatch.delenv("PORT", raising=False)
    assert smoke.author_initials("Nguyễn Lan Anh") == "N.L.A."
    assert smoke.author_initials("Lan Anh") == "L.A."
    assert smoke.author_initials("An") == "A."
    assert smoke.author_initials("   ") == "?"
    assert smoke.author_initials(None) == "?"

    assert smoke.has_phone_or_email("Gọi 0912 345 678 nhé") == (True, False)
    assert smoke.has_phone_or_email("Liên hệ (+84) 912.345.678") == (True, False)
    assert smoke.has_phone_or_email("Mail shop.demo@gmail.com") == (False, True)
    assert smoke.has_phone_or_email("Váy G1 giá 890.000đ ngày 27/11/2026 size M") == (False, False)

    leaked = f"err {SECRET_TOKEN} access_token=tok_abc123 Bearer my_secret_token_99 custom_secret_val"
    cleaned = smoke.redact(leaked, secrets=("custom_secret_val",))
    assert SECRET_TOKEN not in cleaned
    assert "tok_abc123" not in cleaned
    assert "my_secret_token_99" not in cleaned
    assert "custom_secret_val" not in cleaned
    assert "[REDACTED]" in cleaned

    assert smoke.resolve_base_url("http://127.0.0.1:9000/", {}) == "http://127.0.0.1:9000"
    assert smoke.resolve_base_url(None, {"PORT": "8099"}) == "http://127.0.0.1:8099"
    assert smoke.resolve_base_url(None, {"PORT": "bad"}) == "http://127.0.0.1:8020"
    monkeypatch.setenv("PORT", "8055")
    assert smoke.resolve_base_url(None, {"PORT": "8099"}) == "http://127.0.0.1:8055"


# ---------------- 2. Default safe mode: PASS + zero writes to Facebook + privacy ----------------

def test_safe_mode_passes_without_facebook_writes_and_hides_author_name():
    stub = StubVpostServer()
    buf = io.StringIO()
    code = smoke.main(["--base-url", "http://127.0.0.1:8020"], transport=stub.transport(), stream=buf)
    output = buf.getvalue()

    assert code == 0, output
    assert "[PASS] a. GET /api/channels" in output
    assert "[PASS] b. POST /api/comments/sync" in output
    assert "syncedPosts=2, newComments=3" in output
    assert "[PASS] c. GET /api/comments" in output
    assert "[PASS] d. POST /api/comments/c_unrep_1/draft" in output
    assert "decision=reply, status=draft, không có SĐT/email" in output
    assert "[PASS] e. PATCH /api/comments/c_unrep_1/draft" in output
    assert "check.block=[] (0)" in output and "check.warn=" in output
    assert "[SKIP] f. POST /api/comments/c_unrep_1/reply" in output
    assert "[SKIP] g. POST /api/comments/c_unrep_1/hide" in output
    assert "[PASS] h1." in output and "404" in output
    assert "[PASS] h2." in output and "400" in output
    assert "[PASS] h3." in output and "403" in output
    assert "Tổng kết (ĐẠT):" in output

    # Tuyệt đối không gửi request nào ghi lên Facebook khi không có --send/--hide
    assert _fb_write_requests(stub.requests) == []
    assert stub.reply_calls == []
    assert stub.hide_calls == []

    # Không bao giờ in tên đầy đủ người bình luận, chỉ in chữ cái đầu
    assert FULL_AUTHOR not in output
    assert "Lan Anh" not in output
    assert "(N.L.A.)" in output

    # Đảm bảo bước h3 thực sự gửi cookie vpost_active_tenant là UUID khác TENANT_ID
    cookie_reqs = [r for r in stub.requests if r.headers.get("cookie")]
    assert len(cookie_reqs) == 1
    cookie_val = cookie_reqs[0].headers["cookie"].split("=", 1)[1]
    assert uuid.UUID(cookie_val) and cookie_val != TENANT_ID


# ---------------- 3. Write mode (--send + --hide): reply + 409 duplicate + hide toggle ----------------

def test_send_and_hide_mode_checks_409_duplicate_and_hide_toggle():
    stub = StubVpostServer()
    buf = io.StringIO()
    code = smoke.main(
        ["--base-url", "http://127.0.0.1:8020", "--send", "--hide"],
        transport=stub.transport(),
        stream=buf,
    )
    output = buf.getvalue()

    assert code == 0, output
    assert "[PASS] f. POST /api/comments/c_unrep_1/reply" in output
    assert "409 CONFLICT" in output
    assert "https://www.facebook.com/123456_1001?comment_id=c_unrep_1" in output
    assert "[PASS] g. POST /api/comments/c_unrep_1/hide" in output
    assert "hide(true)->200 isHidden=True, hide(false)->200 isHidden=False" in output
    assert len(stub.reply_calls) == 2
    assert stub.reply_calls[0] == stub.reply_calls[1]
    assert stub.hide_calls == [("c_unrep_1", True), ("c_unrep_1", False)]


def test_send_mode_fails_if_duplicate_reply_does_not_return_409():
    stub = StubVpostServer(duplicate_reply_status=200)
    buf = io.StringIO()
    code = smoke.main(
        ["--base-url", "http://127.0.0.1:8020", "--send"],
        transport=stub.transport(),
        stream=buf,
    )
    output = buf.getvalue()

    assert code == 1, output
    assert "[FAIL] f. POST /api/comments/c_unrep_1/reply" in output
    assert "kỳ vọng 409" in output
    assert "Tổng kết (KHÔNG ĐẠT):" in output
    # Không gọi hide vì không truyền --hide
    assert stub.hide_calls == []


# ---------------- 4. PERMISSION_MISSING path + token redaction ----------------

def test_permission_missing_prints_reconnect_hint_and_redacts_token():
    stub = StubVpostServer(
        sync_response=(
            200,
            {
                "tenantId": TENANT_ID,
                "syncedPosts": 0,
                "newComments": 0,
                "updatedComments": 0,
                "errors": [
                    {
                        "postJobId": "job-1",
                        "code": "PERMISSION_MISSING",
                        "message": f"Page thiếu quyền ({SECRET_TOKEN}) — kết nối lại ở mục Kênh.",
                    }
                ],
            },
        )
    )
    buf = io.StringIO()
    code = smoke.main(["--base-url", "http://127.0.0.1:8020"], transport=stub.transport(), stream=buf)
    output = buf.getvalue()

    assert code == 1, output
    assert "[FAIL] b. POST /api/comments/sync" in output
    assert "syncedPosts=0, newComments=0" in output
    assert "PERMISSION_MISSING" in output
    assert "Kênh" in output
    assert "pages_read_user_content" in output
    assert SECRET_TOKEN not in output
    # Tiếp tục chạy các bước sau dù bước b thất bại
    assert "[PASS] c. GET /api/comments" in output
    assert "[PASS] h3." in output
    assert _fb_write_requests(stub.requests) == []


# ---------------- 5. 403 tenant isolation failure path & 422 empty-reply acceptance ----------------

def test_foreign_tenant_cookie_missing_403_fails_and_422_empty_reply_passes():
    stub = StubVpostServer(enforce_tenant_cookie=False, empty_reply_status=422)
    buf = io.StringIO()
    code = smoke.main(["--base-url", "http://127.0.0.1:8020"], transport=stub.transport(), stream=buf)
    output = buf.getvalue()

    assert code == 1, output
    assert "[PASS] h1." in output
    assert "[PASS] h2." in output and "422" in output
    assert "[FAIL] h3." in output and "kỳ vọng 403" in output
    assert _fb_write_requests(stub.requests) == []


# ---------------- 6. Missing channel, inconsistent counts, PII leak, flagged draft, CLI options ----------------

def test_missing_fb_channel_explains_how_to_connect():
    stub = StubVpostServer(
        channels=[
            {"channelId": "fb-test", "platform": "facebook", "name": "Fanpage thử", "externalId": "999", "status": "active"},
            {"channelId": "diu-may", "platform": "facebook", "name": "Dịu Mây", "externalId": "diu-may", "status": "active"},
        ]
    )
    buf = io.StringIO()
    code = smoke.main(["--base-url", "http://127.0.0.1:8020"], transport=stub.transport(), stream=buf)
    output = buf.getvalue()

    assert code == 1, output
    assert "[FAIL] a. GET /api/channels" in output
    assert "Kênh" in output
    assert _fb_write_requests(stub.requests) == []


def test_inconsistent_counts_and_pii_in_draft_fail():
    stub = StubVpostServer(
        counts_override={"unreplied": 9, "replied": 1, "ignored": 0},
        draft_text="Bạn gọi số 0912 345 678 hoặc mail shop@example.com nhé",
    )
    buf = io.StringIO()
    code = smoke.main(["--base-url", "http://127.0.0.1:8020"], transport=stub.transport(), stream=buf)
    output = buf.getvalue()

    assert code == 1, output
    assert "[FAIL] c. GET /api/comments" in output
    assert "items=1 != counts.unreplied=9" in output
    assert "[FAIL] d. POST /api/comments/c_unrep_1/draft" in output
    assert "SĐT/email" in output
    assert _fb_write_requests(stub.requests) == []


def test_flagged_draft_and_sync_filter_options_forwarded():
    stub = StubVpostServer(draft_status="flagged", draft_text="")
    buf = io.StringIO()
    code = smoke.main(
        [
            "--base-url",
            "http://127.0.0.1:8020",
            "--channel",
            "fb-123456",
            "--post-job",
            "job-1",
            "--lookback-days",
            "7",
            "--comment-id",
            "c_unrep_1",
        ],
        transport=stub.transport(),
        stream=buf,
    )
    output = buf.getvalue()

    assert code == 0, output
    assert "decision=flag, status=flagged, không có SĐT/email" in output
    assert "[PASS] e. PATCH /api/comments/c_unrep_1/draft" in output
    assert _fb_write_requests(stub.requests) == []

    sync_req = next(r for r in stub.requests if r.url.path == "/api/comments/sync")
    assert json.loads(sync_req.content.decode("utf-8")) == {
        "channelId": "fb-123456",
        "postJobId": "job-1",
        "lookbackDays": 7,
    }
    list_reqs = [r for r in stub.requests if r.url.path == "/api/comments" and not r.headers.get("cookie")]
    assert len(list_reqs) == 3
    for r in list_reqs:
        assert r.url.params.get("channelId") == "fb-123456"
        assert r.url.params.get("postJobId") == "job-1"


# ---------------- 7. --dry-run makes zero network calls ----------------

def test_dry_run_lists_steps_without_any_network_call():
    called = []

    def forbid_network(request: httpx.Request) -> httpx.Response:
        called.append(request)
        raise AssertionError("dry-run không được gửi bất kỳ yêu cầu mạng nào")

    buf = io.StringIO()
    code = smoke.main(
        ["--dry-run", "--channel", "fb-123456", "--lookback-days", "5"],
        transport=httpx.MockTransport(forbid_network),
        stream=buf,
    )
    output = buf.getvalue()

    assert code == 0, output
    assert called == []
    for marker in ("a. GET /api/channels", "b. POST /api/comments/sync", "c. GET /api/comments", "h1.", "h2.", "h3."):
        assert marker in output
    assert "BỎ QUA" in output


def test_no_unreplied_comments_fails_draft_skips_patch_and_runs_negative_checks():
    stub = StubVpostServer(comments=[])
    buf = io.StringIO()
    code = smoke.main(["--base-url", "http://127.0.0.1:8020"], transport=stub.transport(), stream=buf)
    output = buf.getvalue()

    assert code == 1, output
    assert "[PASS] c. GET /api/comments" in output
    assert "[FAIL] d. POST /api/comments/{id}/draft" in output
    assert "[SKIP] e. PATCH /api/comments/{id}/draft" in output
    assert "[PASS] h1." in output
    assert "[PASS] h2." in output
    assert "[PASS] h3." in output
    assert _fb_write_requests(stub.requests) == []


def test_list_comments_follows_cursor_pagination():
    pages_seen = []

    def handler(request: httpx.Request) -> httpx.Response:
        st = request.url.params.get("status")
        cur = request.url.params.get("cursor")
        pages_seen.append((st, cur))
        counts = {"unreplied": 2, "replied": 0, "ignored": 0}
        if st == "unreplied" and cur is None:
            return httpx.Response(
                200,
                json={
                    "tenantId": TENANT_ID,
                    "items": [{"id": "c1", "status": "unreplied", "fromName": "An", "canComment": True}],
                    "nextCursor": "1",
                    "limit": 50,
                    "counts": counts,
                },
            )
        if st == "unreplied" and cur == "1":
            return httpx.Response(
                200,
                json={
                    "tenantId": TENANT_ID,
                    "items": [{"id": "c2", "status": "unreplied", "fromName": "Bình", "canComment": True}],
                    "nextCursor": None,
                    "limit": 50,
                    "counts": counts,
                },
            )
        return httpx.Response(
            200,
            json={"tenantId": TENANT_ID, "items": [], "nextCursor": None, "limit": 50, "counts": counts},
        )

    with httpx.Client(base_url="http://127.0.0.1:8020", transport=httpx.MockTransport(handler)) as client:
        res, unreplied, tenant = smoke.step_list_comments(client)

    assert res.status == "PASS", res.reason
    assert [c["id"] for c in unreplied] == ["c1", "c2"]
    assert tenant == TENANT_ID
    assert ("unreplied", None) in pages_seen and ("unreplied", "1") in pages_seen

