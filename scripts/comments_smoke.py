"""Smoke test end-to-end luồng hộp thư bình luận Facebook (/api/comments) trên backend VPOST đang chạy.

Mặc định an toàn: KHÔNG ghi gì lên Facebook (không gửi trả lời, không ẩn/hiện bình luận) trừ khi truyền
rõ ràng --send và/hoặc --hide. Không bao giờ in token hoặc tên đầy đủ của người bình luận (chỉ in chữ cái đầu).

Ví dụ sử dụng:
    .venv/bin/python scripts/comments_smoke.py --dry-run
    .venv/bin/python scripts/comments_smoke.py
    .venv/bin/python scripts/comments_smoke.py --base-url http://127.0.0.1:8020 --channel fb-123 --lookback-days 7
    .venv/bin/python scripts/comments_smoke.py --comment-id 123_456 --send --hide
"""
from __future__ import annotations

import argparse
import os
import re
import sys
import uuid
from dataclasses import dataclass
from typing import Any, Callable, Optional, Sequence, TextIO

import httpx

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ENV = os.path.join(ROOT, ".env")

DEFAULT_PORT = 8020
COMMENT_STATUSES = ("unreplied", "replied", "ignored")
TENANT_COOKIE = "vpost_active_tenant"
MAX_LIST_PAGES = 20

# Khớp cùng quy tắc nhận diện PII với codebase/rules.py (chỉ dùng thư viện chuẩn).
_EMAIL_RE = re.compile(r"\b[A-Za-z0-9._%+-]+@(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}\b")
_PHONE_RE = re.compile(r"(?<!\d)(?:(?:\(\+84\)|\+84)(?:[ .\-]?\d){8,10}|0(?:[ .\-]?\d){8,10})(?!\d)")

_FB_TOKEN_RE = re.compile(r"\bEAA[A-Za-z0-9_-]{10,}\b")
_ACCESS_TOKEN_QS_RE = re.compile(r"(access_token=)[^&\s\"']+", re.I)
_BEARER_RE = re.compile(r"(Bearer\s+)[A-Za-z0-9._\-]{8,}", re.I)
_SECRET_KEY_RE = re.compile(r"(TOKEN|SECRET|API_KEY|PASSWORD|PASSWD|AUTH)", re.I)

RECONNECT_HINT = (
    'Gợi ý: mở màn "Kênh" (/channels) kết nối lại Fanpage để cấp đủ quyền '
    "pages_read_user_content và pages_manage_engagement."
)
CONNECT_CHANNEL_HINT = (
    'mở giao diện VPOST → mục "Kênh" (/channels) → bấm "Kết nối Facebook" '
    "(hoặc dán User Access Token ở cửa nhập token) để nối ít nhất một Fanpage thật."
)
SAFE_EDIT_SUFFIX = " Cảm ơn bạn đã quan tâm ạ."
SAFE_EDIT_ALT_SUFFIX = " Shop hỗ trợ thêm qua tin nhắn ạ."
SAFE_FALLBACK_REPLY = "Dạ cảm ơn bạn đã quan tâm, bạn nhắn tin cho shop để được tư vấn chi tiết hơn ạ."


@dataclass
class StepResult:
    step: str
    label: str
    status: str  # "PASS" | "FAIL" | "SKIP"
    reason: str


def read_env(path: str = ENV) -> dict[str, str]:
    """Đọc tệp .env (UTF-8-sig), trả về dict KEY -> VALUE. Không in giá trị."""
    out: dict[str, str] = {}
    if os.path.exists(path):
        with open(path, encoding="utf-8-sig") as f:
            for raw in f:
                line = raw.strip()
                if line and not line.startswith("#") and "=" in line:
                    k, v = line.split("=", 1)
                    out[k.strip()] = v.strip().strip('"').strip("'")
    return out


def collect_secrets(env: Optional[dict[str, str]] = None) -> tuple[str, ...]:
    """Gom các chuỗi bí mật từ .env và biến môi trường để tự động che trước khi in."""
    vals = set()
    for source in (env or {}, os.environ):
        for k, v in source.items():
            if _SECRET_KEY_RE.search(k) and v and len(v.strip()) >= 6:
                vals.add(v.strip())
    return tuple(sorted(vals, key=len, reverse=True))


def resolve_base_url(base_url: Optional[str] = None, env: Optional[dict[str, str]] = None) -> str:
    """Tính URL backend: ưu tiên --base-url, sau đó PORT trong môi trường/.env, mặc định 8020."""
    if base_url and base_url.strip():
        return base_url.strip().rstrip("/")
    raw_port = os.environ.get("PORT") or (env or {}).get("PORT") or str(DEFAULT_PORT)
    try:
        port = int(str(raw_port).strip())
        if not (1 <= port <= 65535):
            port = DEFAULT_PORT
    except ValueError:
        port = DEFAULT_PORT
    return f"http://127.0.0.1:{port}"


def redact(text: Any, secrets: Sequence[str] = ()) -> str:
    """Che token/bí mật và gom về một dòng gọn để in an toàn."""
    s = " ".join(str(text or "").splitlines()).strip()
    for secret in secrets:
        if secret:
            s = s.replace(secret, "[REDACTED]")
    s = _FB_TOKEN_RE.sub("[REDACTED]", s)
    s = _ACCESS_TOKEN_QS_RE.sub(r"\1[REDACTED]", s)
    s = _BEARER_RE.sub(r"\1[REDACTED]", s)
    return s


def author_initials(name: Optional[str]) -> str:
    """Chỉ lấy chữ cái đầu của tên người bình luận (vd 'Nguyễn Lan Anh' -> 'N.L.A.'), không in tên đầy đủ."""
    parts = [p for p in str(name or "").strip().split() if p]
    letters: list[str] = []
    for part in parts:
        ch = next((c for c in part if c.isalnum()), "")
        if ch:
            letters.append(ch.upper())
    return ".".join(letters) + "." if letters else "?"


def has_phone_or_email(text: Optional[str]) -> tuple[bool, bool]:
    """Trả về (có_sđt, có_email) cho nội dung văn bản."""
    s = str(text or "")
    return bool(_PHONE_RE.search(s)), bool(_EMAIL_RE.search(s))


def _is_fb_page_channel(ch: Any) -> bool:
    if not isinstance(ch, dict):
        return False
    cid = str(ch.get("channelId") or "").strip()
    return cid.startswith("fb-") and len(cid) > 3 and cid != "fb-test"


def _json_or_none(resp: httpx.Response) -> Any:
    try:
        return resp.json()
    except ValueError:
        return None


def _error_summary(resp: httpx.Response, secrets: Sequence[str] = ()) -> tuple[str, str]:
    body = _json_or_none(resp)
    if isinstance(body, dict):
        code = str(body.get("code") or "")
        msg = redact(body.get("message") or body.get("detail") or "", secrets)
        return code, msg[:180]
    return "", redact(resp.text[:180], secrets)


def _format_check_list(items: Any, secrets: Sequence[str]) -> str:
    if not isinstance(items, list):
        return "không hợp lệ"
    if not items:
        return "[] (0)"
    preview = "; ".join(redact(x, secrets)[:60] for x in items[:2])
    suffix = ", ..." if len(items) > 2 else ""
    return f"[{preview}{suffix}] ({len(items)})"


def build_edited_text(draft_text: str, custom_text: Optional[str] = None) -> str:
    """Tạo nội dung đã chỉnh sửa an toàn (không thêm giá/size/màu/từ cấm) để PATCH và gửi khi có --send."""
    if custom_text and custom_text.strip():
        return custom_text.strip()[:2000]
    base = (draft_text or "").strip()
    if not base:
        return SAFE_FALLBACK_REPLY
    suffix = SAFE_EDIT_ALT_SUFFIX if base.endswith(SAFE_EDIT_SUFFIX.strip()) else SAFE_EDIT_SUFFIX
    if len(base) + len(suffix) > 2000:
        base = base[: 2000 - len(suffix)].rstrip()
    return base + suffix


def format_step_line(res: StepResult, secrets: Sequence[str] = ()) -> str:
    return f"[{res.status}] {res.step}. {res.label} — {redact(res.reason, secrets)}"


# ---------------- Từng bước kiểm thử ----------------

def step_channels(
    client: httpx.Client,
    *,
    channel: Optional[str] = None,
    secrets: Sequence[str] = (),
) -> tuple[StepResult, Optional[str]]:
    """a. GET /api/channels: kiểm tra có ít nhất một kênh fb-<page id>."""
    label = "GET /api/channels"
    try:
        resp = client.get("/api/channels")
    except httpx.HTTPError as e:
        return (
            StepResult("a", label, "FAIL", f"không gọi được backend: {type(e).__name__} ({redact(e, secrets)[:120]})"),
            None,
        )
    if resp.status_code != 200:
        code, msg = _error_summary(resp, secrets)
        return StepResult("a", label, "FAIL", f"HTTP {resp.status_code} ({code or 'ERROR'}): {msg}"), None

    body = _json_or_none(resp)
    if not isinstance(body, dict) or not isinstance(body.get("channels"), list):
        return StepResult("a", label, "FAIL", "phản hồi không đúng định dạng {channels: [...]}"), None

    tenant_id = str(body.get("tenantId") or "").strip() or None
    all_channels = [c for c in body["channels"] if isinstance(c, dict)]
    fb_channels = [c for c in all_channels if _is_fb_page_channel(c)]

    if not fb_channels:
        return (
            StepResult("a", label, "FAIL", f"chưa có kênh fb-<page id> nào — {CONNECT_CHANNEL_HINT}"),
            tenant_id,
        )

    active_fb = [c for c in fb_channels if str(c.get("status") or "active") != "disabled"]
    if not active_fb:
        ids = ", ".join(str(c["channelId"]) for c in fb_channels)
        return (
            StepResult("a", label, "FAIL", f"các kênh Facebook ({ids}) đều đang tắt — bật lại ở màn \"Kênh\" (/channels)."),
            tenant_id,
        )

    if channel:
        matched = next((c for c in all_channels if c.get("channelId") == channel), None)
        if not matched:
            ids = ", ".join(str(c["channelId"]) for c in active_fb)
            return (
                StepResult("a", label, "FAIL", f"không thấy kênh --channel={channel} (đang có: {ids})"),
                tenant_id,
            )
        if str(matched.get("status") or "active") == "disabled":
            return (
                StepResult("a", label, "FAIL", f"kênh {channel} đang bị tắt — bật lại ở màn \"Kênh\" (/channels)."),
                tenant_id,
            )

    ids = ", ".join(str(c["channelId"]) for c in active_fb)
    return StepResult("a", label, "PASS", f"tìm thấy {len(active_fb)} kênh Facebook: {ids}"), tenant_id


def step_sync(
    client: httpx.Client,
    *,
    channel: Optional[str] = None,
    post_job: Optional[str] = None,
    lookback_days: Optional[int] = None,
    secrets: Sequence[str] = (),
) -> StepResult:
    """b. POST /api/comments/sync: in syncedPosts, newComments, errors; gợi ý kết nối lại khi PERMISSION_MISSING."""
    label = "POST /api/comments/sync"
    payload: dict[str, Any] = {}
    if channel:
        payload["channelId"] = channel
    if post_job:
        payload["postJobId"] = post_job
    if lookback_days is not None:
        payload["lookbackDays"] = lookback_days

    try:
        resp = client.post("/api/comments/sync", json=payload)
    except httpx.HTTPError as e:
        return StepResult("b", label, "FAIL", f"lỗi kết nối: {type(e).__name__} ({redact(e, secrets)[:120]})")

    if resp.status_code != 200:
        code, msg = _error_summary(resp, secrets)
        hint = f" {RECONNECT_HINT}" if code == "PERMISSION_MISSING" else ""
        return StepResult("b", label, "FAIL", f"HTTP {resp.status_code} ({code or 'ERROR'}): {msg}.{hint}")

    body = _json_or_none(resp)
    if not isinstance(body, dict):
        return StepResult("b", label, "FAIL", "phản hồi không phải JSON object")

    synced_posts = body.get("syncedPosts")
    new_comments = body.get("newComments")
    errors = body.get("errors")
    if (
        not isinstance(synced_posts, int)
        or not isinstance(new_comments, int)
        or not isinstance(errors, list)
    ):
        return StepResult("b", label, "FAIL", "thiếu trường syncedPosts/newComments/errors hợp lệ")

    updated_comments = body.get("updatedComments")
    updated_part = f", updatedComments={updated_comments}" if isinstance(updated_comments, int) else ""

    if errors:
        codes = [str(e.get("code") or "UNKNOWN") for e in errors if isinstance(e, dict)]
        unique_codes = ", ".join(dict.fromkeys(codes)) or "UNKNOWN"
        if "PERMISSION_MISSING" in codes:
            reason = (
                f"syncedPosts={synced_posts}, newComments={new_comments}{updated_part}, "
                f"errors={len(errors)} ({unique_codes}) — {RECONNECT_HINT}"
            )
        else:
            first_msg = ""
            if isinstance(errors[0], dict) and errors[0].get("message"):
                first_msg = f": {redact(errors[0]['message'], secrets)[:120]}"
            reason = (
                f"syncedPosts={synced_posts}, newComments={new_comments}{updated_part}, "
                f"errors={len(errors)} ({unique_codes}){first_msg}"
            )
        return StepResult("b", label, "FAIL", reason)

    return StepResult(
        "b",
        label,
        "PASS",
        f"syncedPosts={synced_posts}, newComments={new_comments}{updated_part}, errors=0",
    )


def step_list_comments(
    client: httpx.Client,
    *,
    channel: Optional[str] = None,
    post_job: Optional[str] = None,
    secrets: Sequence[str] = (),
) -> tuple[StepResult, list[dict[str, Any]], Optional[str]]:
    """c. GET /api/comments với từng bộ lọc status: kiểm tra counts nhất quán với items."""
    label = "GET /api/comments"
    base_params: dict[str, Any] = {"limit": 50}
    if channel:
        base_params["channelId"] = channel
    if post_job:
        base_params["postJobId"] = post_job

    observed_counts: Optional[dict[str, int]] = None
    observed_tenant: Optional[str] = None
    unreplied_items: list[dict[str, Any]] = []
    problems: list[str] = []

    for st in COMMENT_STATUSES:
        cursor: Optional[str] = None
        seen_cursors: set[str] = set()
        collected: list[dict[str, Any]] = []
        exhausted = False
        st_counts: Optional[dict[str, int]] = None

        for _ in range(MAX_LIST_PAGES):
            params = dict(base_params, status=st)
            if cursor is not None:
                params["cursor"] = cursor
            try:
                resp = client.get("/api/comments", params=params)
            except httpx.HTTPError as e:
                problems.append(f"status={st} lỗi mạng: {type(e).__name__}")
                break

            if resp.status_code != 200:
                code, msg = _error_summary(resp, secrets)
                problems.append(f"status={st} HTTP {resp.status_code} ({code or 'ERROR'}): {msg[:80]}")
                break

            body = _json_or_none(resp)
            if not isinstance(body, dict) or not isinstance(body.get("items"), list) or not isinstance(body.get("counts"), dict):
                problems.append(f"status={st} sai cấu trúc phản hồi")
                break

            if not observed_tenant and body.get("tenantId"):
                observed_tenant = str(body["tenantId"]).strip() or None

            counts = body["counts"]
            if not all(isinstance(counts.get(k), int) and counts[k] >= 0 for k in COMMENT_STATUSES):
                problems.append(f"status={st} counts thiếu khóa hợp lệ")
                break
            st_counts = {k: int(counts[k]) for k in COMMENT_STATUSES}

            items = [it for it in body["items"] if isinstance(it, dict)]
            wrong = [it.get("id", "?") for it in items if it.get("status") != st]
            if wrong:
                problems.append(f"status={st} có mục sai trạng thái ({len(wrong)})")
                break
            collected.extend(items)

            nxt = body.get("nextCursor")
            if not nxt:
                exhausted = True
                break
            nxt_s = str(nxt)
            if nxt_s in seen_cursors:
                problems.append(f"status={st} bị lặp nextCursor={nxt_s}")
                break
            seen_cursors.add(nxt_s)
            cursor = nxt_s

        if st == "unreplied":
            unreplied_items = collected

        if st_counts is not None:
            if observed_counts is None:
                observed_counts = st_counts
            elif st_counts != observed_counts:
                problems.append(f"counts lệch giữa các tab ở status={st}")

            expected_n = st_counts[st]
            if exhausted and len(collected) != expected_n:
                problems.append(f"status={st}: items={len(collected)} != counts.{st}={expected_n}")
            elif not exhausted and len(collected) > expected_n:
                problems.append(f"status={st}: items={len(collected)} > counts.{st}={expected_n}")

    if problems:
        return StepResult("c", label, "FAIL", "; ".join(problems)), unreplied_items, observed_tenant

    assert observed_counts is not None
    summary = ", ".join(f"{k}={observed_counts[k]}" for k in COMMENT_STATUSES)
    return StepResult("c", label, "PASS", f"counts khớp items ({summary})"), unreplied_items, observed_tenant


def pick_comment(
    unreplied_items: Sequence[dict[str, Any]],
    explicit_id: Optional[str] = None,
) -> tuple[Optional[str], dict[str, Any]]:
    """Chọn bình luận đích: ưu tiên --comment-id, nếu không thì chọn 1 bình luận unreplied (ưu tiên canComment=True)."""
    if explicit_id and explicit_id.strip():
        cid = explicit_id.strip()
        meta = next((it for it in unreplied_items if str(it.get("id") or "") == cid), {})
        return cid, dict(meta)
    for item in unreplied_items:
        if item.get("id") and item.get("canComment", True):
            return str(item["id"]), dict(item)
    for item in unreplied_items:
        if item.get("id"):
            return str(item["id"]), dict(item)
    return None, {}


def step_draft(
    client: httpx.Client,
    comment_id: Optional[str],
    comment_meta: Optional[dict[str, Any]] = None,
    *,
    secrets: Sequence[str] = (),
) -> tuple[StepResult, dict[str, Any], str]:
    """d. POST /api/comments/{id}/draft: in decision/status và xác nhận bản nháp không chứa SĐT/email."""
    label = f"POST /api/comments/{comment_id or '{id}'}/draft"
    if not comment_id:
        return (
            StepResult(
                "d",
                label,
                "FAIL",
                "không có bình luận chưa trả lời nào để soạn nháp — để lại 1 bình luận thử trên bài đã đăng hoặc truyền --comment-id",
            ),
            {},
            "",
        )

    try:
        resp = client.post(f"/api/comments/{comment_id}/draft", json={})
    except httpx.HTTPError as e:
        return StepResult("d", label, "FAIL", f"lỗi kết nối: {type(e).__name__}"), dict(comment_meta or {}), ""

    if resp.status_code != 200:
        code, msg = _error_summary(resp, secrets)
        return (
            StepResult("d", label, "FAIL", f"HTTP {resp.status_code} ({code or 'ERROR'}): {msg}"),
            dict(comment_meta or {}),
            "",
        )

    body = _json_or_none(resp)
    comment = body.get("comment") if isinstance(body, dict) else None
    draft = comment.get("draft") if isinstance(comment, dict) else None
    if not isinstance(comment, dict) or not isinstance(draft, dict):
        return StepResult("d", label, "FAIL", "phản hồi thiếu comment.draft"), dict(comment_meta or {}), ""

    draft_status = str(draft.get("status") or "")
    draft_text = str(draft.get("text") or "")
    ai_text = str(draft.get("aiText") or "")
    initials = author_initials(comment.get("fromName") or (comment_meta or {}).get("fromName"))

    if draft_status == "draft":
        decision = "reply"
    elif draft_status == "flagged":
        decision = "flag"
    else:
        return (
            StepResult("d", label, "FAIL", f"comment={comment_id} ({initials}), trạng thái nháp không hợp lệ: {draft_status}"),
            comment,
            draft_text,
        )

    if draft_status == "draft" and not draft_text.strip():
        return (
            StepResult("d", label, "FAIL", f"comment={comment_id} ({initials}), decision=reply, status=draft nhưng text rỗng"),
            comment,
            draft_text,
        )

    phone_1, email_1 = has_phone_or_email(draft_text)
    phone_2, email_2 = has_phone_or_email(ai_text)
    has_phone = phone_1 or phone_2
    has_email = email_1 or email_2

    if has_phone or has_email:
        leaked = "/".join(x for x, hit in (("SĐT", has_phone), ("email", has_email)) if hit)
        return (
            StepResult(
                "d",
                label,
                "FAIL",
                f"comment={comment_id} ({initials}), decision={decision}, status={draft_status}, bản nháp chứa {leaked}",
            ),
            comment,
            draft_text,
        )

    return (
        StepResult(
            "d",
            label,
            "PASS",
            f"comment={comment_id} ({initials}), decision={decision}, status={draft_status}, không có SĐT/email",
        ),
        comment,
        draft_text,
    )


def step_patch_draft(
    client: httpx.Client,
    comment_id: Optional[str],
    edited_text: str,
    *,
    secrets: Sequence[str] = (),
) -> StepResult:
    """e. PATCH /api/comments/{id}/draft với nội dung đã sửa: in check.block và check.warn."""
    label = f"PATCH /api/comments/{comment_id or '{id}'}/draft"
    if not comment_id:
        return StepResult("e", label, "SKIP", "bỏ qua vì chưa chọn được bình luận ở bước d")

    try:
        resp = client.patch(f"/api/comments/{comment_id}/draft", json={"text": edited_text})
    except httpx.HTTPError as e:
        return StepResult("e", label, "FAIL", f"lỗi kết nối: {type(e).__name__}")

    if resp.status_code != 200:
        code, msg = _error_summary(resp, secrets)
        return StepResult("e", label, "FAIL", f"HTTP {resp.status_code} ({code or 'ERROR'}): {msg}")

    body = _json_or_none(resp)
    check = body.get("check") if isinstance(body, dict) else None
    if not isinstance(check, dict) or not isinstance(check.get("block"), list) or not isinstance(check.get("warn"), list):
        return StepResult("e", label, "FAIL", "phản hồi thiếu check.block/check.warn hợp lệ")

    saved_text = (((body.get("comment") or {}).get("draft") or {}).get("text")) if isinstance(body.get("comment"), dict) else None
    if saved_text is not None and str(saved_text).strip() != edited_text.strip():
        return StepResult("e", label, "FAIL", "nội dung draft trả về không khớp nội dung vừa PATCH")

    block_s = _format_check_list(check["block"], secrets)
    warn_s = _format_check_list(check["warn"], secrets)
    return StepResult("e", label, "PASS", f"đã sửa nháp; check.block={block_s}, check.warn={warn_s}")


def step_send_reply(
    client: httpx.Client,
    comment_id: Optional[str],
    edited_text: str,
    *,
    enabled: bool,
    known_permalink: Optional[str] = None,
    secrets: Sequence[str] = (),
) -> StepResult:
    """f. Chỉ chạy khi có --send: POST /reply với nội dung đã sửa, lặp lại kỳ vọng 409, in permalink Facebook."""
    label = f"POST /api/comments/{comment_id or '{id}'}/reply"
    if not enabled:
        return StepResult("f", label, "SKIP", "bỏ qua (mặc định an toàn — truyền --send để gửi trả lời thật lên Facebook)")
    if not comment_id:
        return StepResult("f", label, "FAIL", "không thể gửi vì chưa chọn được bình luận ở bước d")

    try:
        resp1 = client.post(f"/api/comments/{comment_id}/reply", json={"text": edited_text})
    except httpx.HTTPError as e:
        return StepResult("f", label, "FAIL", f"lỗi kết nối ở lần gửi 1: {type(e).__name__}")

    if resp1.status_code != 200:
        code, msg = _error_summary(resp1, secrets)
        hint = f" {RECONNECT_HINT}" if code == "PERMISSION_MISSING" else ""
        return StepResult("f", label, "FAIL", f"lần 1 trả HTTP {resp1.status_code} ({code or 'ERROR'}): {msg}.{hint}")

    body1 = _json_or_none(resp1)
    comment1 = body1.get("comment") if isinstance(body1, dict) else None
    permalink = (
        (comment1.get("permalinkUrl") if isinstance(comment1, dict) else None)
        or (comment1.get("postUrl") if isinstance(comment1, dict) else None)
        or known_permalink
        or "(không có permalink)"
    )
    permalink = redact(permalink, secrets)

    if isinstance(comment1, dict):
        if comment1.get("status") != "replied":
            return StepResult(
                "f",
                label,
                "FAIL",
                f"lần 1 HTTP 200 nhưng status={comment1.get('status')} (kỳ vọng replied); permalink: {permalink}",
            )
        draft1 = comment1.get("draft")
        if isinstance(draft1, dict) and draft1.get("status") != "sent":
            return StepResult(
                "f",
                label,
                "FAIL",
                f"lần 1 HTTP 200 nhưng draft.status={draft1.get('status')} (kỳ vọng sent); permalink: {permalink}",
            )

    try:
        resp2 = client.post(f"/api/comments/{comment_id}/reply", json={"text": edited_text})
    except httpx.HTTPError as e:
        return StepResult(
            "f",
            label,
            "FAIL",
            f"lần 1 thành công (200) nhưng lỗi kết nối khi kiểm tra gửi trùng: {type(e).__name__}; permalink: {permalink}",
        )

    code2, msg2 = _error_summary(resp2, secrets)
    if resp2.status_code != 409:
        return StepResult(
            "f",
            label,
            "FAIL",
            f"lần 1 thành công (200) nhưng gửi lặp trả HTTP {resp2.status_code} ({code2 or 'ERROR'}, kỳ vọng 409); permalink: {permalink}",
        )

    return StepResult(
        "f",
        label,
        "PASS",
        f"đã gửi (200) và chặn gửi trùng (409 {code2 or 'CONFLICT'}); kiểm tra thủ công: {permalink}",
    )


def step_hide_toggle(
    client: httpx.Client,
    comment_id: Optional[str],
    *,
    enabled: bool,
    secrets: Sequence[str] = (),
) -> StepResult:
    """g. Chỉ chạy khi có --hide: POST /hide true rồi false, in kết quả."""
    label = f"POST /api/comments/{comment_id or '{id}'}/hide"
    if not enabled:
        return StepResult("g", label, "SKIP", "bỏ qua (mặc định an toàn — truyền --hide để thử ẩn/hiện thật trên Facebook)")
    if not comment_id:
        return StepResult("g", label, "FAIL", "không thể ẩn/hiện vì chưa chọn được bình luận ở bước d")

    try:
        r_hide = client.post(f"/api/comments/{comment_id}/hide", json={"hidden": True})
    except httpx.HTTPError as e:
        return StepResult("g", label, "FAIL", f"lỗi kết nối khi hide(true): {type(e).__name__}")

    if r_hide.status_code != 200:
        code, msg = _error_summary(r_hide, secrets)
        hint = f" {RECONNECT_HINT}" if code == "PERMISSION_MISSING" else ""
        return StepResult("g", label, "FAIL", f"hide(true) trả HTTP {r_hide.status_code} ({code or 'ERROR'}): {msg}.{hint}")

    b_hide = _json_or_none(r_hide)
    hidden_1 = ((b_hide.get("comment") or {}).get("isHidden")) if isinstance(b_hide, dict) else None

    try:
        r_unhide = client.post(f"/api/comments/{comment_id}/hide", json={"hidden": False})
    except httpx.HTTPError as e:
        return StepResult("g", label, "FAIL", f"hide(true)->200 (isHidden={hidden_1}), nhưng hide(false) lỗi kết nối: {type(e).__name__}")

    if r_unhide.status_code != 200:
        code, msg = _error_summary(r_unhide, secrets)
        hint = f" {RECONNECT_HINT}" if code == "PERMISSION_MISSING" else ""
        return StepResult(
            "g",
            label,
            "FAIL",
            f"hide(true)->200 (isHidden={hidden_1}), nhưng hide(false) trả HTTP {r_unhide.status_code} ({code or 'ERROR'}): {msg}.{hint}",
        )

    b_unhide = _json_or_none(r_unhide)
    hidden_2 = ((b_unhide.get("comment") or {}).get("isHidden")) if isinstance(b_unhide, dict) else None

    if hidden_1 is True and hidden_2 is False:
        return StepResult("g", label, "PASS", "hide(true)->200 isHidden=True, hide(false)->200 isHidden=False")
    return StepResult(
        "g",
        label,
        "FAIL",
        f"trạng thái isHidden không khớp: hide(true)->{hidden_1}, hide(false)->{hidden_2}",
    )


def step_negative_checks(
    client: httpx.Client,
    *,
    comment_id: Optional[str] = None,
    observed_tenant_id: Optional[str] = None,
    secrets: Sequence[str] = (),
) -> list[StepResult]:
    """h. Các kiểm tra âm tính không bao giờ ghi lên Facebook: unknown id -> 404; empty reply -> 400/422; sai tenant cookie -> 403."""
    results: list[StepResult] = []
    unknown_id = f"smoke-nonexistent-{uuid.uuid4().hex[:8]}"

    # h1: unknown id -> 404 (dùng /draft để tuyệt đối không ghi lên Facebook)
    lbl_404 = f"POST /api/comments/{unknown_id}/draft (ID không tồn tại)"
    try:
        r404 = client.post(f"/api/comments/{unknown_id}/draft", json={})
        code, _ = _error_summary(r404, secrets)
        if r404.status_code == 404:
            results.append(StepResult("h1", lbl_404, "PASS", f"trả HTTP 404 ({code or 'NOT_FOUND'}) đúng kỳ vọng"))
        else:
            results.append(StepResult("h1", lbl_404, "FAIL", f"trả HTTP {r404.status_code} (kỳ vọng 404)"))
    except httpx.HTTPError as e:
        results.append(StepResult("h1", lbl_404, "FAIL", f"lỗi kết nối: {type(e).__name__}"))

    # h2: empty text reply -> 400/422 (bị chặn ở tầng xác thực đầu vào, không gọi Facebook)
    empty_target = comment_id or unknown_id
    lbl_empty = f"POST /api/comments/{empty_target}/reply (nội dung rỗng)"
    try:
        r_empty = client.post(f"/api/comments/{empty_target}/reply", json={"text": "   "})
        code, _ = _error_summary(r_empty, secrets)
        if r_empty.status_code in (400, 422):
            results.append(
                StepResult("h2", lbl_empty, "PASS", f"trả HTTP {r_empty.status_code} ({code or 'INVALID_INPUT'}) đúng kỳ vọng")
            )
        else:
            results.append(StepResult("h2", lbl_empty, "FAIL", f"trả HTTP {r_empty.status_code} (kỳ vọng 400 hoặc 422)"))
    except httpx.HTTPError as e:
        results.append(StepResult("h2", lbl_empty, "FAIL", f"lỗi kết nối: {type(e).__name__}"))

    # h3: cookie vpost_active_tenant là UUID ngẫu nhiên -> 403
    foreign_tenant = str(uuid.uuid4())
    while observed_tenant_id and foreign_tenant == observed_tenant_id:
        foreign_tenant = str(uuid.uuid4())
    lbl_403 = f"GET /api/comments (cookie {TENANT_COOKIE} khác tenant)"
    try:
        r403 = client.get("/api/comments", headers={"Cookie": f"{TENANT_COOKIE}={foreign_tenant}"})
        code, _ = _error_summary(r403, secrets)
        if r403.status_code == 403:
            results.append(StepResult("h3", lbl_403, "PASS", f"trả HTTP 403 ({code or 'FORBIDDEN'}) đúng kỳ vọng"))
        else:
            results.append(StepResult("h3", lbl_403, "FAIL", f"trả HTTP {r403.status_code} (kỳ vọng 403)"))
    except httpx.HTTPError as e:
        results.append(StepResult("h3", lbl_403, "FAIL", f"lỗi kết nối: {type(e).__name__}"))

    return results


# ---------------- Điều phối & CLI ----------------

def format_dry_run(
    *,
    base_url: str,
    channel: Optional[str] = None,
    post_job: Optional[str] = None,
    lookback_days: Optional[int] = None,
    comment_id: Optional[str] = None,
    send: bool = False,
    hide: bool = False,
) -> list[str]:
    """Liệt kê kế hoạch các bước sẽ chạy ở chế độ --dry-run mà không gọi mạng."""
    sync_opts = []
    if channel:
        sync_opts.append(f"channelId={channel}")
    if post_job:
        sync_opts.append(f"postJobId={post_job}")
    if lookback_days is not None:
        sync_opts.append(f"lookbackDays={lookback_days}")
    sync_desc = f" ({', '.join(sync_opts)})" if sync_opts else ""
    cid_desc = comment_id if comment_id else "1 bình luận chưa trả lời đầu tiên"
    mode_desc = (
        "GHI THẬT LÊN FACEBOOK (" + ", ".join(x for x, on in (("--send", send), ("--hide", hide)) if on) + ")"
        if (send or hide)
        else "AN TOÀN (chỉ đọc + nháp nội bộ, không ghi lên Facebook)"
    )

    return [
        f"Dry-run smoke test /api/comments — đích: {base_url} | chế độ: {mode_desc}",
        "  a. GET /api/channels — kiểm tra có ít nhất một kênh fb-<page id> đang bật.",
        f"  b. POST /api/comments/sync{sync_desc} — đồng bộ bình luận, in syncedPosts/newComments/errors và gợi ý nếu PERMISSION_MISSING.",
        "  c. GET /api/comments?status=unreplied|replied|ignored — kiểm tra counts nhất quán với items.",
        f"  d. POST /api/comments/<id>/draft ({cid_desc}) — in decision/status và kiểm tra bản nháp không chứa SĐT/email.",
        "  e. PATCH /api/comments/<id>/draft — sửa nội dung nháp, in check.block và check.warn.",
        f"  f. POST /api/comments/<id>/reply — {'SẼ CHẠY (--send): gửi thật rồi lặp lại kỳ vọng 409 + in permalink.' if send else 'BỎ QUA (truyền --send để gửi thật lên Facebook).'}",
        f"  g. POST /api/comments/<id>/hide — {'SẼ CHẠY (--hide): ẩn (true) rồi hiện lại (false).' if hide else 'BỎ QUA (truyền --hide để thử ẩn/hiện thật trên Facebook).'}",
        "  h1. POST /api/comments/<unknown>/draft — kiểm tra âm tính ID không tồn tại -> 404.",
        "  h2. POST /api/comments/<id>/reply (text rỗng) — kiểm tra âm tính nội dung rỗng -> 400/422 (không ghi lên Facebook).",
        f"  h3. GET /api/comments (cookie {TENANT_COOKIE}=<uuid ngẫu nhiên>) — kiểm tra âm tính cô lập tenant -> 403.",
        "Kết thúc dry-run: không có yêu cầu mạng nào được gửi.",
    ]


def run_smoke(
    client: httpx.Client,
    *,
    channel: Optional[str] = None,
    post_job: Optional[str] = None,
    lookback_days: Optional[int] = None,
    comment_id: Optional[str] = None,
    edit_text: Optional[str] = None,
    send: bool = False,
    hide: bool = False,
    secrets: Sequence[str] = (),
    emit: Optional[Callable[[str], None]] = None,
) -> tuple[int, list[StepResult]]:
    """Chạy tuần tự các bước smoke test bằng `client` (thật hoặc MockTransport). Trả về (exit_code, results)."""
    results: list[StepResult] = []

    def record(res: StepResult) -> None:
        results.append(res)
        if emit is not None:
            emit(format_step_line(res, secrets))

    # a. GET /api/channels
    res_a, tenant_a = step_channels(client, channel=channel, secrets=secrets)
    record(res_a)

    # b. POST /api/comments/sync
    res_b = step_sync(client, channel=channel, post_job=post_job, lookback_days=lookback_days, secrets=secrets)
    record(res_b)

    # c. GET /api/comments với từng status
    res_c, unreplied_items, tenant_c = step_list_comments(client, channel=channel, post_job=post_job, secrets=secrets)
    record(res_c)
    observed_tenant = tenant_a or tenant_c

    # d. Chọn bình luận và POST /draft
    picked_id, picked_meta = pick_comment(unreplied_items, explicit_id=comment_id)
    res_d, comment_obj, draft_text = step_draft(client, picked_id, picked_meta, secrets=secrets)
    record(res_d)

    # e. PATCH /draft
    edited = build_edited_text(draft_text, custom_text=edit_text)
    res_e = step_patch_draft(client, picked_id, edited, secrets=secrets)
    record(res_e)

    # f. POST /reply (+ lặp 409) — chỉ khi có --send
    known_permalink = (
        comment_obj.get("permalinkUrl")
        or comment_obj.get("postUrl")
        or picked_meta.get("permalinkUrl")
        or picked_meta.get("postUrl")
    )
    res_f = step_send_reply(
        client,
        picked_id,
        edited,
        enabled=send,
        known_permalink=known_permalink,
        secrets=secrets,
    )
    record(res_f)

    # g. POST /hide true -> false — chỉ khi có --hide
    res_g = step_hide_toggle(client, picked_id, enabled=hide, secrets=secrets)
    record(res_g)

    # h. Các kiểm tra âm tính không ghi lên Facebook
    for res_h in step_negative_checks(
        client,
        comment_id=picked_id,
        observed_tenant_id=observed_tenant,
        secrets=secrets,
    ):
        record(res_h)

    passed = sum(1 for r in results if r.status == "PASS")
    failed = sum(1 for r in results if r.status == "FAIL")
    skipped = sum(1 for r in results if r.status == "SKIP")
    executed = passed + failed
    exit_code = 0 if (failed == 0 and executed > 0) else 1

    if emit is not None:
        verdict = "ĐẠT" if exit_code == 0 else "KHÔNG ĐẠT"
        emit(f"Tổng kết ({verdict}): {passed}/{executed} bước thực thi đạt, {failed} lỗi, {skipped} bỏ qua.")

    return exit_code, results


def build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(
        description="Smoke test luồng hộp thư bình luận Facebook (/api/comments) trên backend VPOST. Mặc định không ghi lên Facebook."
    )
    ap.add_argument("--base-url", default=None, help="URL backend VPOST (mặc định http://127.0.0.1:<PORT>, PORT mặc định 8020)")
    ap.add_argument("--channel", default=None, help="Lọc theo channelId (vd fb-123456) khi sync và liệt kê")
    ap.add_argument("--post-job", default=None, help="Lọc theo postJobId khi sync và liệt kê")
    ap.add_argument("--lookback-days", type=int, default=None, help="Số ngày nhìn lại khi sync (1–30)")
    ap.add_argument("--comment-id", default=None, help="ID bình luận cụ thể để chạy bước draft/patch/reply/hide")
    ap.add_argument("--edit-text", default=None, help="Nội dung sửa thử cho PATCH /draft (và POST /reply nếu bật --send)")
    ap.add_argument("--send", action="store_true", help="Cho phép gửi trả lời thật lên Facebook và kiểm tra chặn gửi trùng 409")
    ap.add_argument("--hide", action="store_true", help="Cho phép ẩn (true) rồi hiện lại (false) bình luận thật trên Facebook")
    ap.add_argument("--dry-run", action="store_true", help="Liệt kê các bước sẽ chạy rồi thoát mà không gọi mạng")
    ap.add_argument("--timeout", type=float, default=30.0, help="Thời gian chờ mỗi yêu cầu HTTP tính bằng giây (mặc định 30)")
    return ap


def main(
    argv: Optional[Sequence[str]] = None,
    *,
    transport: Optional[httpx.BaseTransport] = None,
    stream: Optional[TextIO] = None,
    env_path: str = ENV,
) -> int:
    if stream is None:
        for s in (sys.stdout, sys.stderr):
            if hasattr(s, "reconfigure"):
                s.reconfigure(encoding="utf-8", errors="replace")
    out = stream if stream is not None else sys.stdout

    def emit(line: str) -> None:
        print(line, file=out)

    args = build_parser().parse_args(list(argv) if argv is not None else None)
    env = read_env(env_path)
    base_url = resolve_base_url(args.base_url, env)

    if args.dry_run:
        for line in format_dry_run(
            base_url=base_url,
            channel=args.channel,
            post_job=args.post_job,
            lookback_days=args.lookback_days,
            comment_id=args.comment_id,
            send=args.send,
            hide=args.hide,
        ):
            emit(line)
        return 0

    secrets = collect_secrets(env)
    with httpx.Client(base_url=base_url, timeout=args.timeout, transport=transport) as client:
        code, _ = run_smoke(
            client,
            channel=args.channel,
            post_job=args.post_job,
            lookback_days=args.lookback_days,
            comment_id=args.comment_id,
            edit_text=args.edit_text,
            send=args.send,
            hide=args.hide,
            secrets=secrets,
            emit=emit,
        )
    return code


if __name__ == "__main__":
    raise SystemExit(main())
