"""API kiểm duyệt bình luận Facebook và luồng tự kiểm duyệt cho VPOST.

Thứ tự gắn router bắt buộc trong `codebase/server.py`:
    moderation_store.init_moderation()
    app.include_router(moderation_api.router)  # PHẢI đứng TRƯỚC vpost_api.router
    app.include_router(vpost_api.router)

Lý do: đặt `moderation_api.router` trước `vpost_api.router` đảm bảo các đường dẫn tĩnh
(`/api/comments/bulk`, `/api/comments/moderation-settings`, `/api/comments/moderation-log`)
không bao giờ bị che khuất bởi các đường dẫn động `/api/comments/{id}` sau này.
"""
from __future__ import annotations

import difflib
import logging
import math
import os
import re
import time
from datetime import datetime, timezone
from typing import Iterable, Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, ConfigDict, Field, field_validator

import facebook
import moderation
import moderation_store
import rules
import schedule
import store
import tools

log = logging.getLogger("vpost.moderation")

# Model tuỳ chọn ghi đè cho kiểm duyệt (nếu None: run_auto_moderation chạy chỉ luật trừ khi truyền `model=...`,
# còn endpoint `/classify` sẽ dùng `vpost_api.MODEL`).
MODEL = None

AUTO_HIDE_CATEGORIES = ("spam", "scam", "abusive", "pii")
_AUTO_HIDE_CATEGORY_SET = frozenset(AUTO_HIDE_CATEGORIES)
LOG_ACTIONS = ("hide", "unhide", "delete", "ignore", "unignore", "would_hide")
LOG_ACTORS = ("operator", "auto")

AUTO_HIDE_RUN_CAP = 20
AUTO_HIDE_DAILY_CAP = 100

FB_WRITE_PAUSE_SEC = 0.05
_sleep = time.sleep

# Fallback cục bộ cho `detect_pii` nếu `rules.scrub_pii` chưa sẵn sàng hoặc bị thiếu.
_FALLBACK_EMAIL_RE = re.compile(
    r"(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,10}(?![A-Za-z0-9-])"
)
_FALLBACK_PHONE_RE = re.compile(
    r"(?<!\d)(?:(?:\(\+84\)|\+84|84)(?:\s*\(0\)\s*|\s*0)?|0)[\s.\-–—/]?[235789](?:[\s.\-–—/]?\d){7,9}(?!\d)"
)


class ApiError(HTTPException):
    def __init__(self, status: int, code: str, message: str):
        super().__init__(status, {"code": code, "message": message})


def _tenant_guard(request: Request):
    """Dùng chung guard tenant của `vpost_api`, import lười để tránh import vòng."""
    import vpost_api
    return vpost_api._same_tenant(request)


def _tenant_id() -> str:
    import vpost_api
    return vpost_api.TENANT_ID


def _classify_model():
    if MODEL is not None:
        return MODEL
    import vpost_api
    return getattr(vpost_api, "MODEL", None)


router = APIRouter(prefix="/api", dependencies=[Depends(_tenant_guard)])


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _z(dt_or_str) -> Optional[str]:
    if not dt_or_str:
        return None
    if isinstance(dt_or_str, str):
        dt = facebook.parse_time(dt_or_str)
        if dt is None:
            try:
                dt = datetime.fromisoformat(dt_or_str.replace("Z", "+00:00"))
            except ValueError:
                return dt_or_str
    else:
        dt = dt_or_str
    return schedule.iso_z(dt)


def _now_z() -> str:
    return schedule.iso_z(_now())


def _local_day_start(dt: datetime) -> datetime:
    """00:00:00 giờ Việt Nam (Asia/Ho_Chi_Minh, schedule.TZ) của ngày chứa `dt`, quy về UTC."""
    aware = dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
    local_start = aware.astimezone(schedule.TZ).replace(hour=0, minute=0, second=0, microsecond=0)
    return local_start.astimezone(timezone.utc)


# ---------------- PII detector dùng rules.scrub_pii + fallback cục bộ ----------------

def _spans_from_scrubbed(raw: str, scrubbed: str, marker: str = "[đã ẩn]") -> list[tuple[int, int]]:
    """Suy ra các khoảng (start, end) trong `raw` đã bị `rules.scrub_pii` thay bằng `marker`."""
    if not raw or scrubbed == raw:
        return []

    # Ưu tiên căn khớp bằng các regex chuẩn của `rules` nếu chúng tái tạo đúng chuỗi đã ẩn.
    email_re = getattr(rules, "_EMAIL_RE", None)
    phone_re = getattr(rules, "_PHONE_RE", None)
    if email_re is not None or phone_re is not None:
        raw_spans: list[tuple[int, int]] = []
        for rx in (email_re, phone_re):
            if rx is not None:
                for m in rx.finditer(raw):
                    if m.start() < m.end():
                        raw_spans.append((m.start(), m.end()))
        if raw_spans:
            raw_spans.sort(key=lambda r: (r[0], -r[1]))
            merged = [raw_spans[0]]
            for a, b in raw_spans[1:]:
                pa, pb = merged[-1]
                if a <= pb:
                    merged[-1] = (pa, max(pb, b))
                else:
                    merged.append((a, b))
            rebuilt = []
            cur = 0
            for a, b in merged:
                rebuilt.append(raw[cur:a])
                rebuilt.append(marker)
                cur = b
            rebuilt.append(raw[cur:])
            if "".join(rebuilt) == scrubbed:
                return merged

    # Tách theo `[đã ẩn]` và xác minh khớp để tương thích khi `rules.scrub_pii` mở rộng thêm mẫu PII mới.
    if marker in scrubbed:
        parts = scrubbed.split(marker)
        if raw.startswith(parts[0]):
            spans: list[tuple[int, int]] = []
            cursor = len(parts[0])
            ok = True
            for i in range(1, len(parts)):
                part = parts[i]
                if part == "":
                    if i == len(parts) - 1:
                        if cursor < len(raw):
                            spans.append((cursor, len(raw)))
                            cursor = len(raw)
                        else:
                            ok = False
                            break
                    else:
                        ok = False
                        break
                else:
                    idx = raw.find(part, cursor)
                    if idx < 0 or idx <= cursor:
                        ok = False
                        break
                    spans.append((cursor, idx))
                    cursor = idx + len(part)
            if ok and cursor == len(raw) and spans:
                return spans

    # Fallback cuối cùng bằng SequenceMatcher — luôn trả span hợp lệ nếu chuỗi đã bị thay đổi.
    spans = []
    sm = difflib.SequenceMatcher(None, raw, scrubbed, autojunk=False)
    for tag, i1, i2, _j1, _j2 in sm.get_opcodes():
        if tag in ("replace", "delete") and i1 < i2:
            spans.append((i1, i2))
    return spans or [(0, len(raw))]


def detect_pii(text: str) -> list[tuple[int, int]]:
    """Phát hiện vùng PII (SĐT Việt Nam, email...) trả về list `(start, end)`.

    Ưu tiên dùng `rules.scrub_pii(text)` để đồng bộ tuyệt đối với quy tắc ẩn PII của hệ thống;
    nếu `rules.scrub_pii` không tồn tại thì tự chuyển sang bộ regex cục bộ `_FALLBACK_EMAIL_RE`
    và `_FALLBACK_PHONE_RE`.
    """
    raw = str(text or "")
    if not raw:
        return []
    scrub_fn = getattr(rules, "scrub_pii", None)
    if callable(scrub_fn):
        scrubbed = scrub_fn(raw)
        if scrubbed == raw:
            return []
        return _spans_from_scrubbed(raw, scrubbed)

    spans: list[tuple[int, int]] = []
    for rx in (_FALLBACK_EMAIL_RE, _FALLBACK_PHONE_RE):
        for m in rx.finditer(raw):
            if m.start() < m.end():
                spans.append((m.start(), m.end()))
    spans.sort(key=lambda r: (r[0], -r[1]))
    return spans


# ---------------- Page kết nối & trợ giúp Facebook ----------------

def _connected_pages() -> list[dict]:
    """Danh sách các Fanpage Facebook thật đang nối (qua OAuth trong PostgreSQL + Fanpage thử trong .env)."""
    out = [
        {
            "pageId": str(p["page_id"]),
            "pageName": p.get("name") or str(p["page_id"]),
            "channelId": "fb-" + str(p["page_id"]),
        }
        for p in store.fb_pages()
    ]
    fb = tools.fb_page()
    if fb and not any(item["pageId"] == str(fb[0]) for item in out):
        out.append(
            {
                "pageId": str(fb[0]),
                "pageName": os.environ.get("FB_PAGE_NAME", "Fanpage thử (Facebook thật)"),
                "channelId": "fb-test",
            }
        )
    return out


def _setting_view(page_info: dict, s: dict) -> dict:
    return {
        "pageId": page_info["pageId"],
        "pageName": page_info["pageName"],
        "channelId": page_info["channelId"],
        "enabled": bool(s["enabled"]),
        "mode": s["mode"],
        "categories": list(s["categories"]),
        "threshold": float(s["threshold"]),
        "updatedBy": s["updated_by"] or None,
        "updatedAt": _z(s["updated_at"]),
    }


def _log_view(row: dict) -> dict:
    return {
        "id": row["id"],
        "pageId": row["page_id"],
        "commentId": row["comment_id"],
        "action": row["action"],
        "actor": row["actor"],
        "category": row["category"] or None,
        "reason": row["reason"] or None,
        "result": row["result"],
        "errorCode": row["error_code"] or None,
        "createdAt": _z(row["created_at"]),
    }


def _comment_page_id(c: dict) -> str:
    pid = str(c.get("page_id") or "").strip()
    if pid:
        return pid
    ch = str(c.get("channel_id") or "").strip()
    if ch.startswith("fb-") and ch != "fb-test":
        return ch[3:]
    return ""


def _comment_channel_id(c: dict) -> str:
    ch = str(c.get("channel_id") or "").strip()
    if ch:
        return ch
    pid = _comment_page_id(c)
    return ("fb-" + pid) if pid else ""


def _is_fb_already_deleted(exc: Exception) -> bool:
    """Graph code 100 / not found khi xoá bình luận trên Facebook được tính là đã xoá (không lỗi)."""
    code = str(getattr(exc, "code", "") or "").upper()
    if code in ("NOT_FOUND", "ALREADY_DELETED", "COMMENT_NOT_FOUND"):
        return True
    if code in ("TOKEN_INVALID", "PERMISSION_MISSING", "RATE_LIMITED", "POSTING_TOO_FAST", "CHANNEL_NOT_CONFIGURED"):
        return False
    if getattr(exc, "graph_code", None) == 100:
        return True
    msg = (str(getattr(exc, "user_message", "") or "") + " " + str(exc)).lower()
    return any(
        needle in msg
        for needle in (
            "(#100)",
            "graph code 100",
            "code 100",
            "does not exist",
            "not found",
            "already deleted",
            "đã bị xoá",
            "không tồn tại",
            "unsupported delete request",
            "http 404",
        )
    )


def _pause_if_needed(seen_pages: set[str], page_id: str) -> None:
    if page_id in seen_pages and FB_WRITE_PAUSE_SEC > 0:
        _sleep(FB_WRITE_PAUSE_SEC)
    seen_pages.add(page_id)


# ---------------- Mô hình Pydantic nghiêm ngặt (extra="forbid", strict=True) ----------------

class EmptyIn(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class BulkCommentsIn(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    ids: list[str] = Field(min_length=1, max_length=50)
    action: Literal["hide", "unhide", "delete", "ignore", "unignore"]
    confirm: Optional[bool] = None

    @field_validator("ids")
    @classmethod
    def _validate_ids(cls, v: list[str]) -> list[str]:
        cleaned: list[str] = []
        seen: set[str] = set()
        for raw in v:
            cid = raw.strip()
            if not cid:
                raise ValueError("mã bình luận không được để trống")
            if cid in seen:
                raise ValueError("danh sách ids không được trùng lặp: %s" % cid)
            seen.add(cid)
            cleaned.append(cid)
        return cleaned


class ModerationSettingIn(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    enabled: bool
    mode: Literal["dry_run", "live"]
    categories: list[str]
    threshold: float = Field(ge=0.5, le=1.0)
    acknowledgeComplaintRisk: Optional[bool] = None

    @field_validator("threshold")
    @classmethod
    def _validate_threshold(cls, v: float) -> float:
        if not math.isfinite(v):
            raise ValueError("threshold phải là số hữu hạn trong khoảng 0.5..1")
        return float(v)

    @field_validator("categories")
    @classmethod
    def _validate_categories(cls, v: list[str]) -> list[str]:
        out: list[str] = []
        for raw in v:
            cat = raw.strip()
            if not cat:
                raise ValueError("tên nhóm phân loại không được để trống")
            out.append(cat)
        return out


# ---------------- Luồng tự kiểm duyệt sau khi đồng bộ ----------------

def run_auto_moderation(
    tenant_id: str,
    comment_ids: Iterable[str],
    *,
    model=None,
) -> dict:
    """Chạy tự kiểm duyệt cho danh sách `comment_ids` mới đồng bộ thuộc `tenant_id`.

    - Áp dụng cài đặt từng Page (mặc định TẮT), ngưỡng `threshold`, giới hạn 20/lần và 100/ngày mỗi Page.
    - Chỉ được phép ẨN (hoặc ghi `would_hide` ở chế độ `dry_run`), không bao giờ xoá hay tự trả lời.
    - Bỏ qua bình luận của chính Page, bình luận đã có trả lời từ Page, và bình luận đã bị ẩn/xoá.
    - Không bao giờ ném ngoại lệ ra ngoài khi một bình luận gặp lỗi.
    """
    moderation_store.init_moderation()
    ids = list(dict.fromkeys(str(x).strip() for x in (comment_ids or ()) if str(x).strip()))
    summary = {
        "tenantId": tenant_id,
        "evaluated": 0,
        "autoHidden": 0,
        "wouldHide": 0,
        "flagged": 0,
        "skipped": 0,
        "failed": 0,
        "stoppedByRateLimit": False,
    }
    if not ids:
        return summary

    active_model = model if model is not None else MODEL
    comments_map = moderation_store.list_comments_by_ids(tenant_id, ids)
    now_dt = _now()
    day_start = _local_day_start(now_dt)

    settings_cache: dict[str, dict] = {}
    recent_cache: dict[str, list[str]] = {}
    run_counts: dict[str, int] = {}
    fb_written_pages: set[str] = set()
    rate_limited_pages: set[str] = set()

    for cid in ids:
        try:
            c = comments_map.get(cid)
            if not c:
                summary["skipped"] += 1
                continue

            # Không bao giờ tự ẩn bình luận của chính Page, bình luận đã xoá, hoặc đã ẩn.
            if c.get("is_from_page") or c.get("status") == "deleted" or c.get("is_hidden"):
                summary["skipped"] += 1
                continue

            # Không bao giờ tự ẩn bình luận đã có trả lời từ Page.
            if c.get("status") == "replied" or store.has_page_reply_or_sent_draft(tenant_id, c):
                summary["skipped"] += 1
                continue

            page_id = _comment_page_id(c)
            if not page_id:
                summary["skipped"] += 1
                continue

            if page_id not in settings_cache:
                settings_cache[page_id] = moderation_store.get_setting_or_default(tenant_id, page_id)
            setting = settings_cache[page_id]

            if not setting["enabled"]:
                summary["skipped"] += 1
                continue

            if page_id in rate_limited_pages:
                summary["skipped"] += 1
                continue

            if page_id not in recent_cache:
                recent_cache[page_id] = moderation_store.recent_page_comment_texts(
                    tenant_id, page_id, reference_time=now_dt
                )

            # Luật xác định trước, AI sau (chỉ gọi khi luật không quyết định và có model).
            res = moderation.classify(
                c.get("message") or "",
                pii_detector=detect_pii,
                recent_texts=recent_cache[page_id],
                model=active_model,
            )
            category = res["category"]
            confidence = float(res["confidence"])
            reasons = list(res["reasons"])
            source = res["source"]
            reason_text = "; ".join(reasons)
            ts = _now_z()
            summary["evaluated"] += 1

            # PHASE2(complaint-autohide)
            # Quyết định v1: khiếu nại (complaint) KHÔNG BAO GIỜ bị tự ẩn — luôn chỉ gắn cờ để người vận hành xem.
            if category == "complaint":
                moderation_store.update_comment_moderation(
                    tenant_id,
                    cid,
                    category=category,
                    confidence=confidence,
                    reasons=reasons,
                    source=source,
                    action="flagged",
                    moderated_at=ts,
                )
                moderation_store.append_moderation_log(
                    tenant_id,
                    page_id=page_id,
                    comment_id=cid,
                    action="hide",
                    actor="auto",
                    category=category,
                    reason="khiếu nại không tự ẩn trong v1 — gắn cờ để kiểm tra thủ công",
                    result="skipped",
                    error_code="COMPLAINT_FLAG_ONLY",
                    created_at=ts,
                )
                summary["flagged"] += 1
                continue

            if category in ("neutral", "positive"):
                moderation_store.update_comment_moderation(
                    tenant_id,
                    cid,
                    category=category,
                    confidence=confidence,
                    reasons=reasons,
                    source=source,
                    action="",
                    moderated_at=ts,
                )
                summary["skipped"] += 1
                continue

            enabled_cats = set(setting["categories"]) & _AUTO_HIDE_CATEGORY_SET
            threshold = float(setting["threshold"])
            if category not in enabled_cats or confidence < threshold:
                moderation_store.update_comment_moderation(
                    tenant_id,
                    cid,
                    category=category,
                    confidence=confidence,
                    reasons=reasons,
                    source=source,
                    action="flagged",
                    moderated_at=ts,
                )
                skip_reason = (
                    "nhóm '%s' chưa bật tự ẩn" % category
                    if category not in enabled_cats
                    else "độ tin cậy %.2f thấp hơn ngưỡng %.2f" % (confidence, threshold)
                )
                moderation_store.append_moderation_log(
                    tenant_id,
                    page_id=page_id,
                    comment_id=cid,
                    action="hide",
                    actor="auto",
                    category=category,
                    reason=skip_reason,
                    result="skipped",
                    created_at=ts,
                )
                summary["flagged"] += 1
                continue

            mode = setting["mode"]
            cap_actions = ("would_hide",) if mode == "dry_run" else ("hide",)
            run_used = run_counts.get(page_id, 0)

            if run_used >= AUTO_HIDE_RUN_CAP:
                cap_msg = "đạt giới hạn %d lượt tự ẩn mỗi lần chạy" % AUTO_HIDE_RUN_CAP
                moderation_store.update_comment_moderation(
                    tenant_id,
                    cid,
                    category=category,
                    confidence=confidence,
                    reasons=reasons,
                    source=source,
                    action="flagged",
                    moderated_at=ts,
                )
                moderation_store.append_moderation_log(
                    tenant_id,
                    page_id=page_id,
                    comment_id=cid,
                    action="would_hide" if mode == "dry_run" else "hide",
                    actor="auto",
                    category=category,
                    reason=cap_msg,
                    result="skipped",
                    error_code="CAP_REACHED",
                    created_at=ts,
                )
                summary["flagged"] += 1
                continue

            # Khoá tư vấn theo (tenant_id, page_id) để đếm giới hạn ngày và ghi hành động tự động không race.
            with moderation_store.daily_cap_tx(tenant_id, page_id) as tx:
                daily_used = moderation_store._count_auto_actions_since_in_tx(
                    tx, tenant_id, page_id, day_start, actions=cap_actions
                )
                if daily_used >= AUTO_HIDE_DAILY_CAP:
                    cap_msg = "đạt giới hạn %d lượt tự ẩn trong ngày của Page" % AUTO_HIDE_DAILY_CAP
                    moderation_store._update_comment_moderation_in_tx(
                        tx,
                        tenant_id,
                        cid,
                        category=category,
                        confidence=confidence,
                        reasons=reasons,
                        source=source,
                        action="flagged",
                        moderated_at=ts,
                    )
                    moderation_store._append_moderation_log_in_tx(
                        tx,
                        tenant_id,
                        page_id=page_id,
                        comment_id=cid,
                        action="would_hide" if mode == "dry_run" else "hide",
                        actor="auto",
                        category=category,
                        reason=cap_msg,
                        result="skipped",
                        error_code="CAP_REACHED",
                        created_at=ts,
                    )
                    summary["flagged"] += 1
                    continue

                if mode == "dry_run":
                    # Chế độ chạy thử: tuyệt đối không gọi Facebook.
                    moderation_store._update_comment_moderation_in_tx(
                        tx,
                        tenant_id,
                        cid,
                        category=category,
                        confidence=confidence,
                        reasons=reasons,
                        source=source,
                        action="would_hide",
                        moderated_at=ts,
                    )
                    moderation_store._append_moderation_log_in_tx(
                        tx,
                        tenant_id,
                        page_id=page_id,
                        comment_id=cid,
                        action="would_hide",
                        actor="auto",
                        category=category,
                        reason=reason_text,
                        result="ok",
                        created_at=ts,
                    )
                    run_counts[page_id] = run_used + 1
                    summary["wouldHide"] += 1
                    continue

                # Chế độ live: chỉ gọi qua tools.hide_fb_comment (tra cứu động bằng getattr).
                hide_fn = getattr(tools, "hide_fb_comment", None)
                if not callable(hide_fn):
                    moderation_store._update_comment_moderation_in_tx(
                        tx,
                        tenant_id,
                        cid,
                        category=category,
                        confidence=confidence,
                        reasons=reasons,
                        source=source,
                        action="flagged",
                        moderated_at=ts,
                    )
                    moderation_store._append_moderation_log_in_tx(
                        tx,
                        tenant_id,
                        page_id=page_id,
                        comment_id=cid,
                        action="hide",
                        actor="auto",
                        category=category,
                        reason="chưa hỗ trợ ẩn bình luận",
                        result="failed",
                        error_code="UPSTREAM_ERROR",
                        created_at=ts,
                    )
                    summary["failed"] += 1
                    continue

                channel_id = _comment_channel_id(c)
                _pause_if_needed(fb_written_pages, page_id)
                try:
                    ok_fb = hide_fn(cid, True, channel_id)
                    if ok_fb is False:
                        raise facebook.FacebookError("UPSTREAM_ERROR", "Facebook trả về thất bại khi ẩn bình luận.")
                except facebook.FacebookError as e:
                    log.warning(
                        "auto_moderation_fb_error tenant=%s page_id=%s comment_id=%s code=%s",
                        tenant_id, page_id, cid, e.code,
                    )
                    moderation_store._update_comment_moderation_in_tx(
                        tx,
                        tenant_id,
                        cid,
                        category=category,
                        confidence=confidence,
                        reasons=reasons,
                        source=source,
                        action="flagged",
                        moderated_at=ts,
                    )
                    moderation_store._append_moderation_log_in_tx(
                        tx,
                        tenant_id,
                        page_id=page_id,
                        comment_id=cid,
                        action="hide",
                        actor="auto",
                        category=category,
                        reason=e.user_message,
                        result="failed",
                        error_code=e.code,
                        created_at=ts,
                    )
                    summary["failed"] += 1
                    if e.code == "RATE_LIMITED":
                        rate_limited_pages.add(page_id)
                        summary["stoppedByRateLimit"] = True
                    continue
                except Exception as e:
                    log.warning(
                        "auto_moderation_error tenant=%s page_id=%s comment_id=%s err=%s",
                        tenant_id, page_id, cid, type(e).__name__,
                    )
                    moderation_store._update_comment_moderation_in_tx(
                        tx,
                        tenant_id,
                        cid,
                        category=category,
                        confidence=confidence,
                        reasons=reasons,
                        source=source,
                        action="flagged",
                        moderated_at=ts,
                    )
                    moderation_store._append_moderation_log_in_tx(
                        tx,
                        tenant_id,
                        page_id=page_id,
                        comment_id=cid,
                        action="hide",
                        actor="auto",
                        category=category,
                        reason="Ẩn bình luận thất bại: %s" % type(e).__name__,
                        result="failed",
                        error_code="UPSTREAM_ERROR",
                        created_at=ts,
                    )
                    summary["failed"] += 1
                    continue

                moderation_store._update_comment_moderation_in_tx(
                    tx,
                    tenant_id,
                    cid,
                    category=category,
                    confidence=confidence,
                    reasons=reasons,
                    source=source,
                    action="auto_hidden",
                    moderated_at=ts,
                    extra_fields={"is_hidden": 1, "updated_at": ts},
                )
                moderation_store._append_moderation_log_in_tx(
                    tx,
                    tenant_id,
                    page_id=page_id,
                    comment_id=cid,
                    action="hide",
                    actor="auto",
                    category=category,
                    reason=reason_text,
                    result="ok",
                    created_at=ts,
                )
                run_counts[page_id] = run_used + 1
                summary["autoHidden"] += 1
        except Exception as e:
            log.warning(
                "auto_moderation_unexpected tenant=%s comment_id=%s err=%s",
                tenant_id, cid, type(e).__name__,
            )
            summary["failed"] += 1
            continue

    return summary


# ---------------- Routes (đường dẫn tĩnh ĐỨNG TRƯỚC `/comments/{comment_id}/classify`) ----------------

@router.post("/comments/bulk")
def bulk_comments(body: BulkCommentsIn):
    """Thao tác hàng loạt (1..50 bình luận duy nhất): hide, unhide, delete, ignore, unignore.

    `processed` = số mục thành công (`ok=True`), `failed` = số mục thất bại (`ok=False`),
    `notProcessed` = danh sách id chưa xử lý do dừng sớm khi gặp `RATE_LIMITED`.
    """
    moderation_store.init_moderation()
    tenant_id = _tenant_id()

    if body.action == "delete" and body.confirm is not True:
        raise ApiError(
            400,
            "CONFIRM_REQUIRED",
            "Xoá vĩnh viễn %d bình luận trên Facebook cần confirm=true — không hoàn tác được." % len(body.ids),
        )

    comments_map = moderation_store.list_comments_by_ids(tenant_id, body.ids)
    results: list[dict] = []
    not_processed: list[str] = []
    fb_written_pages: set[str] = set()

    for idx, cid in enumerate(body.ids):
        ts = _now_z()
        c = comments_map.get(cid)
        if not c:
            msg = "Không tìm thấy bình luận này."
            moderation_store.append_moderation_log(
                tenant_id,
                page_id="",
                comment_id=cid,
                action=body.action,
                actor="operator",
                result="failed",
                error_code="NOT_FOUND",
                reason=msg,
                created_at=ts,
            )
            results.append({"id": cid, "ok": False, "code": "NOT_FOUND", "message": msg})
            continue

        page_id = _comment_page_id(c)
        category = str(c.get("moderation_category") or "")

        if c.get("is_from_page"):
            msg = "Không thể thực hiện thao tác kiểm duyệt lên bình luận của chính Fanpage."
            moderation_store.append_moderation_log(
                tenant_id,
                page_id=page_id,
                comment_id=cid,
                action=body.action,
                actor="operator",
                category=category,
                result="failed",
                error_code="FORBIDDEN",
                reason=msg,
                created_at=ts,
            )
            results.append({"id": cid, "ok": False, "code": "FORBIDDEN", "message": msg})
            continue

        if c.get("status") == "deleted":
            if body.action == "delete":
                moderation_store.append_moderation_log(
                    tenant_id,
                    page_id=page_id,
                    comment_id=cid,
                    action="delete",
                    actor="operator",
                    category=category,
                    result="ok",
                    reason="bình luận đã ở trạng thái đã xoá",
                    created_at=ts,
                )
                results.append({"id": cid, "ok": True})
            else:
                msg = "Bình luận này đã bị xoá."
                moderation_store.append_moderation_log(
                    tenant_id,
                    page_id=page_id,
                    comment_id=cid,
                    action=body.action,
                    actor="operator",
                    category=category,
                    result="failed",
                    error_code="NOT_FOUND",
                    reason=msg,
                    created_at=ts,
                )
                results.append({"id": cid, "ok": False, "code": "NOT_FOUND", "message": msg})
            continue

        if body.action == "ignore":
            store.update_fb_comment(tenant_id, cid, status="ignored", updated_at=ts)
            moderation_store.append_moderation_log(
                tenant_id,
                page_id=page_id,
                comment_id=cid,
                action="ignore",
                actor="operator",
                category=category,
                result="ok",
                reason="người vận hành bỏ qua",
                created_at=ts,
            )
            results.append({"id": cid, "ok": True})
            continue

        if body.action == "unignore":
            restored = "replied" if store.has_page_reply_or_sent_draft(tenant_id, c) else "unreplied"
            store.update_fb_comment(tenant_id, cid, status=restored, updated_at=ts)
            moderation_store.append_moderation_log(
                tenant_id,
                page_id=page_id,
                comment_id=cid,
                action="unignore",
                actor="operator",
                category=category,
                result="ok",
                reason="người vận hành hoàn tác bỏ qua",
                created_at=ts,
            )
            results.append({"id": cid, "ok": True})
            continue

        channel_id = _comment_channel_id(c)

        if body.action in ("hide", "unhide"):
            hide_fn = getattr(tools, "hide_fb_comment", None)
            if not callable(hide_fn):
                msg = "chưa hỗ trợ ẩn/hiện bình luận"
                moderation_store.append_moderation_log(
                    tenant_id,
                    page_id=page_id,
                    comment_id=cid,
                    action=body.action,
                    actor="operator",
                    category=category,
                    result="failed",
                    error_code="UPSTREAM_ERROR",
                    reason=msg,
                    created_at=ts,
                )
                results.append({"id": cid, "ok": False, "code": "UPSTREAM_ERROR", "message": msg})
                continue

            hidden = body.action == "hide"
            _pause_if_needed(fb_written_pages, page_id)
            try:
                ok_fb = hide_fn(cid, hidden, channel_id)
                if ok_fb is False:
                    raise facebook.FacebookError(
                        "UPSTREAM_ERROR",
                        "Facebook trả về thất bại khi cập nhật trạng thái ẩn bình luận.",
                    )
            except facebook.FacebookError as e:
                log.warning(
                    "bulk_hide_error tenant=%s page_id=%s comment_id=%s action=%s code=%s",
                    tenant_id, page_id, cid, body.action, e.code,
                )
                moderation_store.append_moderation_log(
                    tenant_id,
                    page_id=page_id,
                    comment_id=cid,
                    action=body.action,
                    actor="operator",
                    category=category,
                    result="failed",
                    error_code=e.code,
                    reason=e.user_message,
                    created_at=ts,
                )
                results.append({"id": cid, "ok": False, "code": e.code, "message": e.user_message})
                if e.code == "RATE_LIMITED":
                    not_processed = list(body.ids[idx + 1:])
                    break
                continue
            except Exception as e:
                msg = "Cập nhật trạng thái bình luận trên Facebook thất bại: %s" % type(e).__name__
                log.warning(
                    "bulk_hide_error tenant=%s page_id=%s comment_id=%s action=%s err=%s",
                    tenant_id, page_id, cid, body.action, type(e).__name__,
                )
                moderation_store.append_moderation_log(
                    tenant_id,
                    page_id=page_id,
                    comment_id=cid,
                    action=body.action,
                    actor="operator",
                    category=category,
                    result="failed",
                    error_code="UPSTREAM_ERROR",
                    reason=msg,
                    created_at=ts,
                )
                results.append({"id": cid, "ok": False, "code": "UPSTREAM_ERROR", "message": msg})
                continue

            upd = {"is_hidden": 1 if hidden else 0, "updated_at": ts}
            if not hidden and c.get("moderation_action") == "auto_hidden":
                upd["moderation_action"] = ""
            store.update_fb_comment(tenant_id, cid, **upd)
            moderation_store.append_moderation_log(
                tenant_id,
                page_id=page_id,
                comment_id=cid,
                action=body.action,
                actor="operator",
                category=category,
                result="ok",
                reason="người vận hành ẩn bình luận" if hidden else "người vận hành hiện lại bình luận",
                created_at=ts,
            )
            results.append({"id": cid, "ok": True})
            continue

        # body.action == "delete"
        delete_fn = getattr(tools, "delete_fb_comment", None)
        if not callable(delete_fn):
            msg = "chưa hỗ trợ xoá"
            moderation_store.append_moderation_log(
                tenant_id,
                page_id=page_id,
                comment_id=cid,
                action="delete",
                actor="operator",
                category=category,
                result="failed",
                error_code="UPSTREAM_ERROR",
                reason=msg,
                created_at=ts,
            )
            results.append({"id": cid, "ok": False, "code": "UPSTREAM_ERROR", "message": msg})
            continue

        _pause_if_needed(fb_written_pages, page_id)
        already_deleted = False
        try:
            ok_fb = delete_fn(channel_id, cid)
            if ok_fb is False:
                raise facebook.FacebookError("UPSTREAM_ERROR", "Facebook trả về thất bại khi xoá bình luận.")
        except Exception as e:
            if _is_fb_already_deleted(e):
                already_deleted = True
            elif isinstance(e, facebook.FacebookError):
                log.warning(
                    "bulk_delete_error tenant=%s page_id=%s comment_id=%s code=%s",
                    tenant_id, page_id, cid, e.code,
                )
                moderation_store.append_moderation_log(
                    tenant_id,
                    page_id=page_id,
                    comment_id=cid,
                    action="delete",
                    actor="operator",
                    category=category,
                    result="failed",
                    error_code=e.code,
                    reason=e.user_message,
                    created_at=ts,
                )
                results.append({"id": cid, "ok": False, "code": e.code, "message": e.user_message})
                if e.code == "RATE_LIMITED":
                    not_processed = list(body.ids[idx + 1:])
                    break
                continue
            else:
                msg = "Xoá bình luận trên Facebook thất bại: %s" % type(e).__name__
                log.warning(
                    "bulk_delete_error tenant=%s page_id=%s comment_id=%s err=%s",
                    tenant_id, page_id, cid, type(e).__name__,
                )
                moderation_store.append_moderation_log(
                    tenant_id,
                    page_id=page_id,
                    comment_id=cid,
                    action="delete",
                    actor="operator",
                    category=category,
                    result="failed",
                    error_code="UPSTREAM_ERROR",
                    reason=msg,
                    created_at=ts,
                )
                results.append({"id": cid, "ok": False, "code": "UPSTREAM_ERROR", "message": msg})
                continue

        store.update_fb_comment(tenant_id, cid, status="deleted", updated_at=ts)
        moderation_store.append_moderation_log(
            tenant_id,
            page_id=page_id,
            comment_id=cid,
            action="delete",
            actor="operator",
            category=category,
            result="ok",
            reason="đã bị xoá trên Facebook trước đó" if already_deleted else "người vận hành xoá bình luận",
            created_at=ts,
        )
        results.append({"id": cid, "ok": True})

    processed = sum(1 for r in results if r["ok"])
    failed = sum(1 for r in results if not r["ok"])
    return {
        "tenantId": tenant_id,
        "results": results,
        "processed": processed,
        "failed": failed,
        "notProcessed": not_processed,
    }


@router.get("/comments/moderation-settings")
def get_moderation_settings():
    """Trả cài đặt tự kiểm duyệt cho mọi Fanpage đã nối (mặc định tắt, chạy thử, ngưỡng 0.85)."""
    moderation_store.init_moderation()
    tenant_id = _tenant_id()
    saved = {s["page_id"]: s for s in moderation_store.list_settings(tenant_id)}
    items = []
    for p in _connected_pages():
        s = saved.get(p["pageId"]) or moderation_store.default_setting(tenant_id, p["pageId"])
        items.append(_setting_view(p, s))
    return {"tenantId": tenant_id, "items": items}


@router.put("/comments/moderation-settings/{page_id}")
def put_moderation_setting(page_id: str, body: ModerationSettingIn):
    """Cập nhật cài đặt tự kiểm duyệt cho một Fanpage đã nối."""
    moderation_store.init_moderation()
    tenant_id = _tenant_id()
    pages = {p["pageId"]: p for p in _connected_pages()}
    page_info = pages.get(page_id)
    if not page_info:
        raise ApiError(404, "NOT_FOUND", "Không tìm thấy Fanpage đã kết nối với mã '%s'." % page_id)

    cats = list(dict.fromkeys(body.categories))

    # PHASE2(complaint-autohide)
    # Quyết định v1: không cho phép bật tự ẩn cho nhóm `complaint`; khiếu nại luôn chỉ được gắn cờ cho người vận hành.
    if "complaint" in cats:
        raise ApiError(
            400,
            "COMPLAINT_AUTOHIDE_DISABLED",
            "Trong v1 không hỗ trợ tự ẩn khiếu nại (complaint) — khiếu nại luôn chỉ được gắn cờ để người vận hành kiểm tra.",
        )

    invalid = [c for c in cats if c not in _AUTO_HIDE_CATEGORY_SET]
    if invalid:
        raise ApiError(
            400,
            "INVALID_INPUT",
            "Nhóm tự kiểm duyệt không hợp lệ: %s (chỉ nhận %s)."
            % (", ".join(invalid), ", ".join(AUTO_HIDE_CATEGORIES)),
        )

    saved = moderation_store.upsert_setting(
        tenant_id,
        page_id,
        enabled=body.enabled,
        mode=body.mode,
        categories=cats,
        threshold=body.threshold,
        updated_by="operator",
        updated_at=_now_z(),
    )
    return {"tenantId": tenant_id, "setting": _setting_view(page_info, saved)}


@router.get("/comments/moderation-log")
def get_moderation_log(
    pageId: Optional[str] = None,
    action: Optional[str] = None,
    actor: Optional[str] = None,
    cursor: Optional[str] = None,
    limit: int = Query(20, ge=1, le=100),
):
    """Xem nhật ký kiểm duyệt có phân trang và lọc theo pageId, action, actor."""
    moderation_store.init_moderation()
    tenant_id = _tenant_id()

    page_f = (pageId or "").strip() or None
    action_f = (action or "").strip() or None
    actor_f = (actor or "").strip() or None
    cursor_f = (cursor or "").strip() or None

    if action_f and action_f not in LOG_ACTIONS:
        raise ApiError(400, "INVALID_INPUT", "action không hợp lệ: chỉ nhận %s" % ", ".join(LOG_ACTIONS))
    if actor_f and actor_f not in LOG_ACTORS:
        raise ApiError(400, "INVALID_INPUT", "actor không hợp lệ: chỉ nhận %s" % ", ".join(LOG_ACTORS))

    try:
        rows, next_cursor = moderation_store.list_moderation_logs(
            tenant_id,
            page_id=page_f,
            action=action_f,
            actor=actor_f,
            cursor=cursor_f,
            limit=limit,
        )
    except ValueError:
        raise ApiError(400, "INVALID_INPUT", "cursor không hợp lệ")

    return {
        "tenantId": tenant_id,
        "items": [_log_view(r) for r in rows],
        "nextCursor": next_cursor,
        "limit": limit,
    }


@router.post("/comments/{comment_id}/classify")
def classify_comment(comment_id: str, body: Optional[EmptyIn] = None):
    """Chạy lại phân loại cho một bình luận khách mà KHÔNG thực hiện hành động ẩn/xoá nào."""
    moderation_store.init_moderation()
    tenant_id = _tenant_id()
    c = moderation_store.get_comment(tenant_id, comment_id, customer_only=False)
    if not c or c.get("status") == "deleted":
        raise ApiError(404, "NOT_FOUND", "Không tìm thấy bình luận này.")
    if c.get("is_from_page"):
        raise ApiError(403, "FORBIDDEN", "Không thể phân loại bình luận của chính Fanpage.")

    page_id = _comment_page_id(c)
    ref_dt = facebook.parse_time(c.get("created_time")) or _now()
    recent_texts = moderation_store.recent_page_comment_texts(tenant_id, page_id, reference_time=ref_dt)
    res = moderation.classify(
        c.get("message") or "",
        pii_detector=detect_pii,
        recent_texts=recent_texts,
        model=_classify_model(),
    )
    ts = _now_z()
    moderation_store.update_comment_moderation(
        tenant_id,
        comment_id,
        category=res["category"],
        confidence=res["confidence"],
        reasons=res["reasons"],
        source=res["source"],
        moderated_at=ts,
        update_action=False,
    )
    return {
        "tenantId": tenant_id,
        "commentId": comment_id,
        "moderation": {
            "category": res["category"],
            "confidence": float(res["confidence"]),
            "reasons": list(res["reasons"]),
            "source": res["source"],
            "action": (c.get("moderation_action") or None),
            "at": ts,
        },
    }
