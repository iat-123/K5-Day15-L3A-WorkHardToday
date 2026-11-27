"""Lưu trữ cài đặt kiểm duyệt tự động, nhật ký kiểm duyệt và trạng thái kiểm duyệt bình luận trong PostgreSQL.

Tái sử dụng kết nối (`store.connect`), khoá tư vấn theo giao dịch (`store.tx_locked`) và timestamp (`store._ts`)
từ `store.py`. Mọi bảng mới đều nằm trong schema của shop (`store.schema_name()`), có `tenant_id` và mọi truy vấn
đều lọc theo `tenant_id`. Đọc bình luận ưu tiên qua hàm công khai của `store` (`store.get_fb_comment`,
`store.list_fb_comments`, hoặc `store.get_comment` / `store.list_comments_by_ids`), kèm helper riêng tư dự phòng.
"""
from __future__ import annotations

from contextlib import contextmanager
import json
import uuid
from datetime import datetime, timedelta, timezone
from typing import Iterable, Optional

from psycopg import sql as pg_sql

import schedule
import store

DEFAULT_MODE = "dry_run"
DEFAULT_THRESHOLD = 0.85

FB_COMMENT_MODERATION_COLUMNS = (
    ("moderation_category", "text default ''"),
    ("moderation_confidence", "double precision"),
    ("moderation_reasons", "text default '[]'"),
    ("moderation_source", "text default ''"),
    ("moderation_action", "text default ''"),
    ("moderated_at", "text default ''"),
)

MODERATION_SCHEMA_STATEMENTS = (
    """
    create table if not exists moderation_setting(
      tenant_id text not null,
      page_id text not null,
      enabled integer not null default 0,
      mode text not null default 'dry_run',
      categories text not null default '[]',
      threshold double precision not null default 0.85,
      updated_by text not null default '',
      updated_at text not null default '',
      primary key (tenant_id, page_id)
    )
    """,
    """
    create table if not exists moderation_log(
      seq bigint generated always as identity,
      id text primary key,
      tenant_id text not null,
      page_id text not null default '',
      comment_id text not null,
      action text not null,
      actor text not null,
      category text not null default '',
      reason text not null default '',
      result text not null,
      error_code text not null default '',
      created_at text not null
    )
    """,
    """
    create index if not exists moderation_log_tenant_created
      on moderation_log(tenant_id, created_at desc, seq desc)
    """,
    """
    create index if not exists moderation_log_daily
      on moderation_log(tenant_id, page_id, actor, action, result, created_at desc)
    """,
)


def init_moderation() -> None:
    """Khởi tạo bảng kiểm duyệt và thêm các cột `moderation_*` vào `fb_comment` một cách idempotent.

    An toàn khi gọi lặp lại nhiều lần và sẵn sàng được gọi từ `store.init()`.
    """
    schema = store.schema_name()
    with store.tx_locked("moderation:init") as c:
        c.execute(pg_sql.SQL("create schema if not exists {}").format(pg_sql.Identifier(schema)))
        c.execute(pg_sql.SQL("set local search_path to {}").format(pg_sql.Identifier(schema)))
        for stmt in MODERATION_SCHEMA_STATEMENTS:
            c.execute(stmt)
        has_fb_comment = c.execute(
            "select 1 from information_schema.tables "
            "where table_schema = current_schema() and table_name = 'fb_comment'"
        ).fetchone()
        if has_fb_comment:
            existing = {
                r["column_name"]
                for r in c.execute(
                    "select column_name from information_schema.columns "
                    "where table_schema = current_schema() and table_name = 'fb_comment'"
                ).fetchall()
            }
            for col_name, col_def in FB_COMMENT_MODERATION_COLUMNS:
                if col_name not in existing:
                    c.execute(
                        pg_sql.SQL("alter table fb_comment add column if not exists {} {}").format(
                            pg_sql.Identifier(col_name),
                            pg_sql.SQL(col_def),
                        )
                    )
            c.execute(
                "create index if not exists fb_comment_moderation "
                "on fb_comment(tenant_id, is_from_page, moderation_action, created_time desc)"
            )


def _daily_cap_lock_key(tenant_id: str, page_id: str) -> str:
    return "moderation:daily:%s:%s" % (tenant_id, str(page_id))


@contextmanager
def daily_cap_tx(tenant_id: str, page_id: str):
    """Mở giao dịch có khoá tư vấn theo `(tenant_id, page_id)` để đếm giới hạn ngày và ghi hành động tự động an toàn."""
    with store.tx_locked(_daily_cap_lock_key(tenant_id, page_id)) as c:
        yield c


def _parse_json_list(raw) -> list[str]:
    if isinstance(raw, list):
        return [str(x) for x in raw]
    if not raw:
        return []
    try:
        parsed = json.loads(raw)
        return [str(x) for x in parsed] if isinstance(parsed, list) else []
    except (ValueError, TypeError):
        return []


def _parse_utc(value) -> Optional[datetime]:
    if not value:
        return None
    if isinstance(value, datetime):
        return value.astimezone(timezone.utc) if value.tzinfo else value.replace(tzinfo=timezone.utc)
    s = str(value).strip()
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    elif len(s) >= 5 and s[-5] in ("+", "-") and s[-4:].isdigit():
        s = s[:-2] + ":" + s[-2:]
    try:
        dt = datetime.fromisoformat(s)
    except ValueError:
        return None
    return dt.astimezone(timezone.utc) if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def _hydrate_comment(row: Optional[dict]) -> Optional[dict]:
    if row is None:
        return None
    out = dict(row)
    out["moderation_reasons"] = _parse_json_list(out.get("moderation_reasons"))
    return out


# ---------------- Đọc bình luận qua hàm của store (kèm fallback riêng tư) ----------------

def _read_comment_fallback(tenant_id: str, comment_id: str, *, customer_only: bool = False) -> Optional[dict]:
    """Helper riêng tư dự phòng khi `store` chưa cung cấp `get_fb_comment`/`get_comment`."""
    query = "select * from fb_comment where id=%s and tenant_id=%s"
    if customer_only:
        query += " and is_from_page=0"
    with store.connect() as c:
        r = c.execute(query, (comment_id, tenant_id)).fetchone()
    return dict(r) if r else None


def get_comment(tenant_id: str, comment_id: str, *, customer_only: bool = False) -> Optional[dict]:
    """Đọc một bình luận theo `tenant_id` (mặc định gồm cả bình luận của Page để phân biệt FORBIDDEN vs NOT_FOUND)."""
    fn = getattr(store, "get_fb_comment", None)
    if callable(fn):
        row = fn(tenant_id, comment_id, customer_only=customer_only)
        return _hydrate_comment(row)

    alt = getattr(store, "get_comment", None)
    if callable(alt):
        row = alt(tenant_id, comment_id)
        if not row:
            return None
        if customer_only and row.get("is_from_page"):
            return None
        return _hydrate_comment(row)

    return _hydrate_comment(_read_comment_fallback(tenant_id, comment_id, customer_only=customer_only))


def _list_comments_by_ids_fallback(tenant_id: str, comment_ids: list[str]) -> dict[str, dict]:
    """Helper riêng tư dự phòng khi `store.list_comments_by_ids` chưa tồn tại."""
    out: dict[str, dict] = {}
    for cid in comment_ids:
        row = get_comment(tenant_id, cid, customer_only=False)
        if row is not None:
            out[row["id"]] = row
    return out


def list_comments_by_ids(tenant_id: str, comment_ids: Iterable[str]) -> dict[str, dict]:
    """Trả dict `{comment_id: row}` chỉ cho các bình luận thuộc `tenant_id` (gồm cả Page-own)."""
    ids = list(dict.fromkeys(str(x).strip() for x in comment_ids if str(x).strip()))
    if not ids:
        return {}
    fn = getattr(store, "list_comments_by_ids", None)
    if callable(fn):
        rows = fn(tenant_id, ids)
        if isinstance(rows, dict):
            return {k: _hydrate_comment(v) for k, v in rows.items() if v is not None}
        return {r["id"]: _hydrate_comment(r) for r in rows if r and r.get("id")}
    return _list_comments_by_ids_fallback(tenant_id, ids)


def recent_page_comment_texts(
    tenant_id: str,
    page_id: str,
    *,
    reference_time: Optional[datetime] = None,
    window_hours: int = 24,
) -> list[str]:
    """Lấy nội dung các bình luận khách (chưa bị xoá) trên cùng Page trong cửa sổ 24 giờ để phát hiện spam lặp."""
    if not page_id:
        return []
    now_utc = datetime.now(timezone.utc)
    ref = _parse_utc(reference_time) or now_utc
    delta = timedelta(hours=window_hours)
    if abs((now_utc - ref).total_seconds()) <= delta.total_seconds():
        lo = now_utc - delta
        hi = now_utc + timedelta(hours=1)
    else:
        lo = ref - delta
        hi = ref + timedelta(seconds=1)

    rows = store.list_fb_comments(tenant_id)
    texts: list[str] = []
    for row in rows:
        if str(row.get("page_id") or "") != str(page_id):
            continue
        if row.get("status") == "deleted":
            continue
        cdt = _parse_utc(row.get("created_time"))
        if cdt is None or (lo <= cdt <= hi):
            texts.append(str(row.get("message") or ""))
    return texts


# ---------------- Cập nhật cột moderation_* trên fb_comment ----------------

def _build_comment_moderation_fields(
    *,
    category: str,
    confidence: float,
    reasons: list[str],
    source: str,
    action: Optional[str] = None,
    moderated_at: Optional[str] = None,
    update_action: bool = True,
    extra_fields: Optional[dict] = None,
) -> dict:
    fields = {
        "moderation_category": str(category or ""),
        "moderation_confidence": float(confidence),
        "moderation_reasons": json.dumps([str(r) for r in reasons], ensure_ascii=False),
        "moderation_source": str(source or ""),
        "moderated_at": moderated_at or schedule.iso_z(datetime.now(timezone.utc)),
    }
    if update_action:
        fields["moderation_action"] = str(action or "")
    if extra_fields:
        fields.update(extra_fields)
    return fields


def _update_comment_moderation_in_tx(
    c,
    tenant_id: str,
    comment_id: str,
    *,
    category: str,
    confidence: float,
    reasons: list[str],
    source: str,
    action: Optional[str] = None,
    moderated_at: Optional[str] = None,
    update_action: bool = True,
    extra_fields: Optional[dict] = None,
) -> None:
    fields = _build_comment_moderation_fields(
        category=category,
        confidence=confidence,
        reasons=reasons,
        source=source,
        action=action,
        moderated_at=moderated_at,
        update_action=update_action,
        extra_fields=extra_fields,
    )
    clean = {
        k: (int(v) if k in store.INT_BOOL_COMMENT_COLS and isinstance(v, bool) else v)
        for k, v in fields.items()
    }
    assignments = pg_sql.SQL(", ").join(pg_sql.SQL("{}=%s").format(pg_sql.Identifier(k)) for k in clean)
    c.execute(
        pg_sql.SQL("update fb_comment set {} where id=%s and tenant_id=%s").format(assignments),
        (*clean.values(), comment_id, tenant_id),
    )


def update_comment_moderation(
    tenant_id: str,
    comment_id: str,
    *,
    category: str,
    confidence: float,
    reasons: list[str],
    source: str,
    action: Optional[str] = None,
    moderated_at: Optional[str] = None,
    update_action: bool = True,
    extra_fields: Optional[dict] = None,
) -> None:
    """Cập nhật các trường kiểm duyệt trên `fb_comment` theo `tenant_id`."""
    fields = _build_comment_moderation_fields(
        category=category,
        confidence=confidence,
        reasons=reasons,
        source=source,
        action=action,
        moderated_at=moderated_at,
        update_action=update_action,
        extra_fields=extra_fields,
    )
    store.update_fb_comment(tenant_id, comment_id, **fields)


def format_comment_moderation(row: dict) -> Optional[dict]:
    """Chuyển các cột `moderation_*` của một dòng `fb_comment` thành object `moderation` (hoặc None)."""
    cat = (row.get("moderation_category") or "").strip()
    act = (row.get("moderation_action") or "").strip()
    if not cat and not act:
        return None
    conf = row.get("moderation_confidence")
    raw_at = (row.get("moderated_at") or "").strip()
    if raw_at:
        parsed_at = _parse_utc(raw_at)
        at_val = schedule.iso_z(parsed_at) if parsed_at is not None else raw_at
    else:
        at_val = None
    return {
        "category": cat,
        "confidence": float(conf) if conf is not None else 0.0,
        "reasons": _parse_json_list(row.get("moderation_reasons")),
        "source": (row.get("moderation_source") or "").strip(),
        "action": act or None,
        "at": at_val,
    }


# ---------------- Cài đặt tự kiểm duyệt theo Page (moderation_setting) ----------------

def _decode_setting(row) -> dict:
    d = dict(row)
    return {
        "tenant_id": d["tenant_id"],
        "page_id": d["page_id"],
        "enabled": bool(d["enabled"]),
        "mode": d["mode"] or DEFAULT_MODE,
        "categories": _parse_json_list(d.get("categories")),
        "threshold": float(d["threshold"]) if d.get("threshold") is not None else DEFAULT_THRESHOLD,
        "updated_by": d.get("updated_by") or "",
        "updated_at": d.get("updated_at") or "",
    }


def default_setting(tenant_id: str, page_id: str) -> dict:
    return {
        "tenant_id": tenant_id,
        "page_id": str(page_id),
        "enabled": False,
        "mode": DEFAULT_MODE,
        "categories": [],
        "threshold": DEFAULT_THRESHOLD,
        "updated_by": "",
        "updated_at": "",
    }


def get_setting(tenant_id: str, page_id: str) -> Optional[dict]:
    with store.connect() as c:
        r = c.execute(
            "select * from moderation_setting where tenant_id=%s and page_id=%s",
            (tenant_id, str(page_id)),
        ).fetchone()
    return _decode_setting(r) if r else None


def get_setting_or_default(tenant_id: str, page_id: str) -> dict:
    return get_setting(tenant_id, page_id) or default_setting(tenant_id, page_id)


def list_settings(tenant_id: str) -> list[dict]:
    with store.connect() as c:
        rows = c.execute(
            "select * from moderation_setting where tenant_id=%s order by page_id asc",
            (tenant_id,),
        ).fetchall()
    return [_decode_setting(r) for r in rows]


def upsert_setting(
    tenant_id: str,
    page_id: str,
    *,
    enabled: bool,
    mode: str,
    categories: list[str],
    threshold: float,
    updated_by: str = "operator",
    updated_at: Optional[str] = None,
) -> dict:
    ts = updated_at or store._ts()
    cats = list(dict.fromkeys(str(x) for x in categories))
    cats_json = json.dumps(cats, ensure_ascii=False)
    with store.connect() as c:
        c.execute(
            """insert into moderation_setting(
                 tenant_id, page_id, enabled, mode, categories, threshold, updated_by, updated_at
               ) values(%s,%s,%s,%s,%s,%s,%s,%s)
               on conflict(tenant_id, page_id) do update set
                 enabled=excluded.enabled,
                 mode=excluded.mode,
                 categories=excluded.categories,
                 threshold=excluded.threshold,
                 updated_by=excluded.updated_by,
                 updated_at=excluded.updated_at""",
            (tenant_id, str(page_id), 1 if enabled else 0, mode, cats_json, float(threshold), updated_by, ts),
        )
    return {
        "tenant_id": tenant_id,
        "page_id": str(page_id),
        "enabled": bool(enabled),
        "mode": mode,
        "categories": cats,
        "threshold": float(threshold),
        "updated_by": updated_by,
        "updated_at": ts,
    }


# ---------------- Nhật ký kiểm duyệt (moderation_log) ----------------

def _decode_log(row) -> dict:
    d = dict(row)
    d.pop("seq", None)
    return d


def _build_moderation_log_entry(
    tenant_id: str,
    *,
    page_id: str,
    comment_id: str,
    action: str,
    actor: str,
    result: str,
    category: str = "",
    reason: str = "",
    error_code: str = "",
    log_id: Optional[str] = None,
    created_at: Optional[str] = None,
) -> dict:
    return {
        "id": log_id or str(uuid.uuid4()),
        "tenant_id": tenant_id,
        "page_id": str(page_id or ""),
        "comment_id": str(comment_id),
        "action": str(action),
        "actor": str(actor),
        "category": str(category or ""),
        "reason": str(reason or ""),
        "result": str(result),
        "error_code": str(error_code or ""),
        "created_at": created_at or store._ts(),
    }


def _append_moderation_log_in_tx(
    c,
    tenant_id: str,
    *,
    page_id: str,
    comment_id: str,
    action: str,
    actor: str,
    result: str,
    category: str = "",
    reason: str = "",
    error_code: str = "",
    log_id: Optional[str] = None,
    created_at: Optional[str] = None,
) -> dict:
    entry = _build_moderation_log_entry(
        tenant_id,
        page_id=page_id,
        comment_id=comment_id,
        action=action,
        actor=actor,
        result=result,
        category=category,
        reason=reason,
        error_code=error_code,
        log_id=log_id,
        created_at=created_at,
    )
    c.execute(
        """insert into moderation_log(
             id, tenant_id, page_id, comment_id, action, actor,
             category, reason, result, error_code, created_at
           ) values(%(id)s, %(tenant_id)s, %(page_id)s, %(comment_id)s, %(action)s, %(actor)s,
                    %(category)s, %(reason)s, %(result)s, %(error_code)s, %(created_at)s)""",
        entry,
    )
    return entry


def append_moderation_log(
    tenant_id: str,
    *,
    page_id: str,
    comment_id: str,
    action: str,
    actor: str,
    result: str,
    category: str = "",
    reason: str = "",
    error_code: str = "",
    log_id: Optional[str] = None,
    created_at: Optional[str] = None,
) -> dict:
    ctx = daily_cap_tx(tenant_id, page_id) if (str(actor) == "auto" and str(page_id or "")) else store.connect()
    with ctx as c:
        return _append_moderation_log_in_tx(
            c,
            tenant_id,
            page_id=page_id,
            comment_id=comment_id,
            action=action,
            actor=actor,
            result=result,
            category=category,
            reason=reason,
            error_code=error_code,
            log_id=log_id,
            created_at=created_at,
        )


def list_moderation_logs(
    tenant_id: str,
    *,
    page_id: Optional[str] = None,
    action: Optional[str] = None,
    actor: Optional[str] = None,
    cursor: Optional[str] = None,
    limit: int = 20,
) -> tuple[list[dict], Optional[str]]:
    """Đọc nhật ký kiểm duyệt theo `tenant_id` (mới nhất trước), hỗ trợ lọc và phân trang cursor."""
    offset = 0
    if cursor is not None and str(cursor).strip() != "":
        try:
            offset = int(str(cursor).strip())
        except ValueError:
            raise ValueError("cursor không hợp lệ")
        if offset < 0:
            raise ValueError("cursor không hợp lệ")

    where, params = ["tenant_id=%s"], [tenant_id]
    if page_id:
        where.append("page_id=%s")
        params.append(str(page_id))
    if action:
        where.append("action=%s")
        params.append(str(action))
    if actor:
        where.append("actor=%s")
        params.append(str(actor))

    query = (
        "select * from moderation_log where "
        + " and ".join(where)
        + " order by created_at desc, seq desc limit %s offset %s"
    )
    with store.connect() as c:
        rows = c.execute(query, (*params, limit + 1, offset)).fetchall()

    items = [_decode_log(r) for r in rows[:limit]]
    next_cursor = str(offset + limit) if len(rows) > limit else None
    return items, next_cursor


def _count_auto_actions_since_in_tx(
    c,
    tenant_id: str,
    page_id: str,
    since_dt: datetime,
    *,
    actions: tuple[str, ...] = ("hide",),
) -> int:
    if not actions:
        return 0
    since_utc = _parse_utc(since_dt) or datetime.now(timezone.utc)
    rows = c.execute(
        "select created_at from moderation_log "
        "where tenant_id=%s and page_id=%s and actor='auto' and result='ok' and action = any(%s)",
        (tenant_id, str(page_id), [str(a) for a in actions]),
    ).fetchall()
    total = 0
    for r in rows:
        dt = _parse_utc(r["created_at"])
        if dt is not None and dt >= since_utc:
            total += 1
    return total


def count_auto_actions_since(
    tenant_id: str,
    page_id: str,
    since_dt: datetime,
    *,
    actions: tuple[str, ...] = ("hide",),
) -> int:
    """Đếm số lần tự kiểm duyệt thành công (`actor='auto', result='ok'`) của Page kể từ `since_dt` (UTC)."""
    if not actions:
        return 0
    with daily_cap_tx(tenant_id, page_id) as c:
        return _count_auto_actions_since_in_tx(c, tenant_id, page_id, since_dt, actions=actions)
