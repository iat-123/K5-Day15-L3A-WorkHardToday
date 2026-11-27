"""API theo hợp đồng giao diện VPOST (vpost/src/ui/services/*.api.ts, schema zod ở vpost/src/ui/schemas/).

Giao diện Next.js chuyển mọi /api/* sang đây (vpost/next.config.ts, biến VPOST_API_URL). Một dòng sản phẩm đi:
  POST /api/posts/compose   code: kiểm dòng + kiểm tồn + ảnh (KHÔNG gọi AI; giao diện chờ tối đa 15s)
  POST /api/posts/captions  AI quyết định viết hay đánh dấu (agent.process_row: soát bài, viết lại ≤1 lần)
  POST /api/posts/batches   người đã duyệt → lên lịch (kiểm tồn lần 2, khoá trùng, mỗi kênh một post_job)
Giờ luôn trả dạng ...Z (zod z.iso.datetime() không nhận +00:00). Lỗi luôn trả {code, message}.
"""
import os
import re
import secrets
import uuid
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Depends, File, Query, Request, UploadFile
from fastapi import HTTPException
from fastapi.responses import RedirectResponse, Response
from pydantic import BaseModel, ConfigDict, Field

import agent
import facebook
import rules
import schedule
import store
import tools
from ai import MODEL_NAME, MODEL_PROVIDER, call_model

# Một shop = một tenant. Phiên + tenant do Next (Postgres) giữ; VPOST_TENANT_ID = id tenant đó.
TENANT_ID = os.environ.get("VPOST_TENANT_ID", "").strip() or "00000000-0000-4000-8000-000000000001"
TENANT_COOKIE = "vpost_active_tenant"   # Next đặt, rewrite /api chuyển tiếp nguyên cookie


def _same_tenant(request: Request):
    """Tenant khác đang chọn trên giao diện thì không được đọc dữ liệu shop này. Không có cookie = gọi thẳng/test."""
    active = request.cookies.get(TENANT_COOKIE)
    if active and active != TENANT_ID:
        raise ApiError(403, "FORBIDDEN", "Công ty đang chọn không có quyền với dữ liệu shop này.")


router = APIRouter(prefix="/api", dependencies=[Depends(_same_tenant)])
FB_CHANNEL = "fb-test"
MODEL = call_model                                    # test thay bằng model giả
TONES = {"thoi-trang-he": "trẻ trung, hợp mùa hè", "sang-trong": "sang trọng, tinh tế",
         "than-thien": "thân thiện, gần gũi", "sale-manh": "dứt khoát, rủ chốt đơn (không nêu khuyến mãi nếu file không có)"}
ACTIVE = ("queued", "publishing", "scheduled_on_facebook", "published")


class ApiError(HTTPException):
    def __init__(self, status, code, message):
        super().__init__(status, {"code": code, "message": message})


def now():
    return datetime.now(timezone.utc)


def z(dt_or_str):
    if not dt_or_str:
        return None
    dt = datetime.fromisoformat(dt_or_str.replace("Z", "+00:00")) if isinstance(dt_or_str, str) else dt_or_str
    return schedule.iso_z(dt)


def _parse_dt(s, field):
    try:
        dt = datetime.fromisoformat(str(s).replace("Z", "+00:00"))
    except ValueError:
        raise ApiError(400, "INVALID_INPUT", "%s không phải thời điểm hợp lệ" % field)
    return dt if dt.tzinfo else dt.replace(tzinfo=schedule.TZ)


# ---------------- khung trang ----------------
@router.get("/me")
def me():
    return {"account": {"id": "dev-acc", "displayName": "Dev Bypass", "platformRole": None},
            "tenants": [{"id": TENANT_ID, "name": "Shop váy demo", "slug": "demo", "plan": "pro", "role": "editor"}],
            "activeTenantId": TENANT_ID, "isBootstrapAdmin": False, "supportSession": None}


FB_PAGE_PREFIX = "fb-"   # kênh = Page nối qua OAuth, channelId = "fb-<page id>"


def channels_list():
    """Page nối qua OAuth (đăng thật) + Fanpage thử từ .env + 5 page mẫu trong pages.json (chỉ lịch trong app)."""
    out = [{"channelId": FB_PAGE_PREFIX + p["page_id"], "platform": "facebook", "name": p["name"] or p["page_id"],
            "externalId": p["page_id"], "status": "active", "tokenExpiresAt": None} for p in store.fb_pages()]
    fb = tools.fb_page()
    if fb and not any(c["externalId"] == fb[0] for c in out):
        out.append({"channelId": FB_CHANNEL, "platform": "facebook", "externalId": fb[0], "status": "active",
                    "name": os.environ.get("FB_PAGE_NAME", "Fanpage thử (Facebook thật)"), "tokenExpiresAt": None})
    out += [{"channelId": p["id"], "platform": "facebook", "name": p["name"] + " (chỉ lịch trong app)",
             "externalId": p["id"], "status": "active", "tokenExpiresAt": None} for p in tools.PAGES.values()]
    statuses = store.channel_statuses()
    for c in out:
        c["status"] = statuses.get(c["channelId"], "active")
    return out


def page_credentials(ch_id):
    """(page_id, token) để đăng thật lên kênh này, hoặc None = kênh chỉ ghi lịch trong app."""
    if ch_id.startswith(FB_PAGE_PREFIX):
        p = store.fb_page(ch_id[len(FB_PAGE_PREFIX):])
        return (p["page_id"], p["page_token"]) if p else None
    if ch_id == FB_CHANNEL:
        return tools.fb_page()
    return None


@router.get("/channels")
def channels():
    return {"tenantId": TENANT_ID, "channels": channels_list(), "secretsConfigured": bool(tools.fb_page())}


@router.get("/channel-groups")
def channel_groups():
    return {"tenantId": TENANT_ID, "groups": []}


# ---------------- file sản phẩm ----------------
@router.post("/vpost/catalog")
async def upload_catalog(file: UploadFile = File(...)):
    """Tải file Excel/CSV sản phẩm — thay toàn bộ danh sách mã đang dùng."""
    data = await file.read()
    if len(data) > 10 * 1024 * 1024:
        raise ApiError(413, "INVALID_INPUT", "File lớn hơn 10MB")
    try:
        rows = tools.read_products(data, file.filename or "")
    except ValueError as e:
        raise ApiError(400, "INVALID_INPUT", str(e))
    return load_catalog(rows)


def load_catalog(rows):
    seen, keep, skipped = set(), [], []
    for i, r in enumerate(rows, 2):  # dòng 1 là tiêu đề
        code = (r.get("ma_sp") or "").strip()
        if not code or code in seen:
            skipped.append({"line": i, "reason": "thiếu mã" if not code else "trùng mã %s" % code})
            continue
        seen.add(code)
        keep.append(dict(r, ma_sp=code))
    if not keep:
        raise ApiError(400, "INVALID_INPUT", "File không có dòng nào có mã sản phẩm")
    if len(keep) > 500:
        raise ApiError(400, "INVALID_INPUT", "File có %d mã — tối đa 500" % len(keep))
    store.replace_catalog(keep)
    return {"rows": len(keep), "codes": [r["ma_sp"] for r in keep], "skipped": skipped}


def display_name(row):
    return row.get("ten_sp") or "%s %s" % (row.get("loai") or "Sản phẩm", row["ma_sp"])


def inspect(row):
    """Kiểm bằng code, không gọi AI: → (page, lỗi cứng [(code, message)], cảnh báo, kết quả tồn, ảnh)."""
    page, pwarn = tools.page_for(row)
    c = tools.check_product(row, page)
    hard = [("ROW_DATA_INVALID", "%s: %s" % (rules.LABEL.get(f, f), m)) for f, m in c["hard"]]
    s = tools.check_stock(row) if not c["hard"] else {"hard": [], "warn": [], "colors": [], "low": False, "variants": []}
    hard += [("OUT_OF_STOCK", m) for _, m in s["hard"]]
    images = rules.parse_images(row.get("anh"))
    if not images:
        hard.append(("MEDIA_NOT_FOUND", "Chưa có ảnh sản phẩm — thêm link ảnh vào cột ảnh của file"))
    warns = ["%s: %s" % pwarn] if pwarn else []
    warns += ["%s: %s" % w for w in c["warn"] + s["warn"] if w[0] != "anh"]
    return page, hard, warns, s, images


def _inventory(hard, s):
    blocked = any(code == "OUT_OF_STOCK" for code, _ in hard)
    stock = sum(v["ton"] for v in s.get("variants", [])) if s.get("variants") else None
    return {"status": "blocked" if blocked else ("low_stock" if s.get("low") else "in_stock"), "blocked": blocked,
            "reason": next((m for code, m in hard if code == "OUT_OF_STOCK"), None), "stock": stock,
            "operatorMessage": None, "stockCheckSkipped": False, "stockCheckSkippedReason": None}


@router.get("/catalog/products")
def catalog_products(status: Optional[str] = None, q: Optional[str] = None, limit: int = Query(50, ge=1, le=500),
                     cursor: Optional[str] = None):
    items = []
    for row in store.catalog_rows():
        if q and q.lower() not in (row["ma_sp"] + " " + display_name(row)).lower():
            continue
        page, hard, warns, s, images = inspect(row)
        items.append({"code": row["ma_sp"], "name": display_name(row), "category": row.get("loai") or None, "season": None,
                      "inventory": {k: v for k, v in _inventory(hard, s).items() if k != "blocked"},
                      "mediaImageCount": len(images), "mediaVideoCount": 0, "hasConflict": False,
                      "composable": not hard,
                      "blockedReason": {"code": hard[0][0], "userMessage": hard[0][1]} if hard else None})
    totals = {"total": len(items), "ok": sum(i["composable"] for i in items), "blocked": sum(not i["composable"] for i in items)}
    if status == "ok":
        items = [i for i in items if i["composable"]]
    elif status == "blocked":
        items = [i for i in items if not i["composable"]]
    start = int(cursor or 0)
    return {"items": items[start:start + limit], "nextCursor": str(start + limit) if start + limit < len(items) else None,
            "totals": totals}


# ---------------- compose → captions → batches ----------------
class ComposeIn(BaseModel):
    model_config = ConfigDict(extra="ignore")
    productCode: str = Field(min_length=1, max_length=64)
    mediaKind: Optional[str] = None
    color: Optional[str] = None


@router.post("/posts/compose")
def compose(body: ComposeIn):
    code = body.productCode.strip()
    row = store.catalog_row(code)
    if not row:
        raise ApiError(404, "PRODUCT_NOT_FOUND", "Không có mã %s trong file sản phẩm đã tải" % code)
    page, hard, warns, s, images = inspect(row)
    if images:  # ảnh không tải được thì bỏ, không đưa lên bài
        chk = tools.check_images(images)
        if chk["broken"]:
            warns.append("ảnh: đã bỏ %d ảnh không tải được" % len(chk["broken"]))
        images = chk["ok"]
        if not images and not any(c == "MEDIA_NOT_FOUND" for c, _ in hard):
            hard.append(("MEDIA_NOT_FOUND", "Không ảnh nào của mã này tải được"))
    if hard:
        # một mã lỗi đại diện cho cả dòng; message liệt kê đủ lý do để người đọc sửa file
        first = next((c for c, _ in hard if c in ("OUT_OF_STOCK", "MEDIA_NOT_FOUND")), hard[0][0])
        status = {"OUT_OF_STOCK": 409, "MEDIA_NOT_FOUND": 404}.get(first, 422)
        raise ApiError(status, first, "; ".join(m for _, m in hard))
    return {"tenantId": TENANT_ID, "productCode": code, "channel": "facebook", "productOrigin": "sheet",
            "content": {"code": code, "name": display_name(row), "description": row.get("mo_ta") or None,
                        "category": row.get("loai") or None, "season": None},
            "inventory": _inventory(hard, s),
            "media": [{"driveFileId": u, "fileName": "%s-%d.jpg" % (code, i), "color": None, "sequence": i,
                       "kind": "image", "warnings": [], "needsReview": False} for i, u in enumerate(images, 1)],
            "availableColors": s.get("colors", []), "warnings": warns, "video": None}


class ProductIn(BaseModel):
    model_config = ConfigDict(extra="ignore")
    name: str = ""
    description: str = ""
    category: str = ""
    season: str = ""


class CaptionsIn(BaseModel):
    model_config = ConfigDict(extra="ignore")
    product: ProductIn
    channels: list[str] = Field(min_length=1)
    tone: Optional[str] = None


def find_row(name):
    """Giao diện chỉ gửi tên hiển thị — tên đó chứa mã (display_name), lấy mã dài nhất khớp."""
    rows = store.catalog_rows()
    exact = [r for r in rows if display_name(r) == name]
    if exact:
        return exact[0]
    hits = sorted((r for r in rows if re.search(r"(?<![\w])%s(?![\w])" % re.escape(r["ma_sp"]), name)),
                  key=lambda r: -len(r["ma_sp"]))
    return hits[0] if hits else None


@router.post("/posts/captions")
def captions(body: CaptionsIn):
    if body.tone and body.tone not in TONES:
        raise HTTPException(400, {"code": "INVALID_INPUT", "message": "Giọng viết không hỗ trợ",
                                  "issues": [{"path": "tone", "message": "không hỗ trợ"}]})
    row = find_row(body.product.name)
    if not row:
        raise ApiError(404, "PRODUCT_NOT_FOUND", "Không tìm thấy sản phẩm '%s' trong file đã tải" % body.product.name)
    if body.tone:
        row = dict(row, prompt=((row.get("prompt") or "") + ". Giọng: " + TONES[body.tone]).strip(". "))
    page, _ = tools.page_for(row)
    res = agent.process_row(row, page, model=MODEL)
    if res["decision"] != "write":
        reason = "; ".join("%s: %s" % (rules.LABEL.get(f, f), m) for f, m in res["reasons"])
        return {"generated": [], "failed": [{"channelId": p, "platform": p, "code": "ROW_FLAGGED",
                                             "reason": reason or "AI đánh dấu dòng này"} for p in body.channels]}
    return {"generated": [{"channelId": p, "platform": p, "text": res["post"], "hashtags": [],
                           "model": MODEL_NAME or "fake", "provider": MODEL_PROVIDER} for p in body.channels],
            "failed": []}


class MediaIn(BaseModel):
    model_config = ConfigDict(extra="ignore")
    driveFileId: str = Field(min_length=1)
    fileName: Optional[str] = None
    kind: Optional[str] = None


class BatchIn(BaseModel):
    model_config = ConfigDict(extra="ignore")
    productCode: str = Field(min_length=1, max_length=64)
    color: Optional[str] = None
    format: Optional[str] = "image_post"
    scheduledAt: Optional[str] = None
    spacingMs: Optional[int] = Field(None, ge=0)
    channelIds: list[str] = Field(min_length=1)
    captionByChannel: dict[str, str]
    media: list[MediaIn] = Field(min_length=1)


def _channel_map():
    return {c["channelId"]: c for c in channels_list()}


def _publish(job_id, ch_id, text, images, when):
    """Một post_job: kênh có token Page thì gọi Facebook, kênh mẫu chỉ ghi lịch trong app. → các trường cập nhật."""
    creds = page_credentials(ch_id)
    if creds:
        try:
            res = tools.schedule_post(text, int(when.timestamp()) if when else None, images, page=creds)
        except Exception as e:  # lỗi Facebook: ghi vào job, không làm hỏng các kênh khác
            return {"status": "failed", "error_code": "PUBLISH_FAILED", "user_message": "Facebook từ chối: %s" % str(e)[:200]}
        url = "https://www.facebook.com/%s" % res["fb_post_id"] if res.get("fb_post_id") else None
        if when:
            return {"status": "scheduled_on_facebook", "fb_post_id": res["fb_post_id"],
                    "user_message": "Đã hẹn giờ trên Facebook"}
        return {"status": "published", "fb_post_id": res["fb_post_id"], "published_url": url,
                "published_at": z(now()), "user_message": "Đã đăng lên Facebook"}
    if not when:
        return {"status": "blocked", "error_code": "CHANNEL_NOT_CONFIGURED",
                "user_message": "Kênh này chưa nối Fanpage thật — chỉ hẹn giờ trong app được, chưa đăng ngay được"}
    return {"status": "queued", "user_message": "Đã lên lịch trong app (kênh chưa nối Fanpage nên không tự đăng)"}


@router.post("/posts/batches")
def create_batch(body: BatchIn):
    code = body.productCode.strip()
    row = store.catalog_row(code)
    if not row:
        raise ApiError(404, "PRODUCT_NOT_FOUND", "Không có mã %s trong file sản phẩm đã tải" % code)
    chans = _channel_map()
    unknown = [c for c in body.channelIds if c not in chans]
    if unknown:
        raise ApiError(409, "CHANNEL_NOT_CONFIGURED", "Kênh không tồn tại: %s" % ", ".join(unknown))
    off = [chans[c]["name"] for c in body.channelIds if chans[c]["status"] != "active"]
    if off:
        raise ApiError(409, "CHANNEL_NOT_CONFIGURED", "Kênh đang tắt: %s — bật lại ở màn Kênh" % ", ".join(off))
    missing =[c for c in body.channelIds if not (body.captionByChannel.get(c) or "").strip()]
    if missing:
        raise ApiError(400, "INVALID_INPUT", "Thiếu nội dung bài cho kênh: %s" % ", ".join(chans[c]["name"] for c in missing))
    when0 = _parse_dt(body.scheduledAt, "scheduledAt") if body.scheduledAt else None
    if when0 and when0 < now() + schedule.MIN_LEAD:
        raise ApiError(400, "INVALID_INPUT", "Giờ đăng phải sau hiện tại ít nhất 10 phút")
    color, fmt = body.color or "", body.format or "image_post"
    # kiểm tồn lần 2 ngay trước khi đăng — hết hàng thì chặn cả lô
    page, hard, warns, s, _ = inspect(row)
    oos = [m for c, m in hard if c == "OUT_OF_STOCK"]
    if oos:
        raise ApiError(409, "OUT_OF_STOCK", "; ".join(oos))
    images = [m.driveFileId for m in body.media]
    allowed = rules.allowed_facts(row, s, page, tools.GLOB)
    warnings = []
    batch_id, ts = str(uuid.uuid4()), z(now())
    jobs = []
    for i, ch in enumerate(body.channelIds):
        text = body.captionByChannel[ch].strip()
        v = rules.verify_post(text, allowed)
        warnings += ["%s: %s" % (chans[ch]["name"], b) for b in v["block"]]
        dup = store.post_jobs("product_code=? and color=? and channel_id=? and format=? and status in (%s)"
                              % ",".join("?" * len(ACTIVE)), (code, color, ch, fmt, *ACTIVE))
        job = {"id": str(uuid.uuid4()), "batch_id": batch_id, "product_code": code, "color": color, "format": fmt,
               "channel_id": ch, "caption": text, "media": images, "status": "draft", "scheduled_at": None,
               "fb_post_id": None, "published_url": None, "published_at": None, "error_code": None,
               "user_message": "", "attempt_count": 1, "created_at": ts, "updated_at": ts}
        when = when0 + timedelta(milliseconds=(body.spacingMs or 0) * i) if when0 else None
        if dup:
            job.update(status="blocked", error_code="DUPLICATE_POST_BLOCKED",
                       user_message="Mã này đã có bài đang chờ/đã đăng trên kênh này")
        else:
            job.update(scheduled_at=z(when) if when else None, **_publish(job["id"], ch, text, images, when))
        jobs.append(job)
    store.create_post_batch({"id": batch_id, "product_code": code, "color": color, "format": fmt, "created_at": ts}, jobs)
    return {"tenantId": TENANT_ID, "batchId": batch_id, "productCode": code, "color": color, "format": fmt,
            "batchStatus": batch_status([j["status"] for j in jobs]),
            "channels": [{"channelId": j["channel_id"], "postJobId": j["id"], "status": j["status"],
                          "queued": j["status"] == "queued", "queueJobId": j["id"] if j["status"] == "queued" else None,
                          "errorCode": j["error_code"], "userMessage": j["user_message"] or None,
                          "scheduledAt": j["scheduled_at"]} for j in jobs],
            "warnings": warnings + [w for w in warns if not w.startswith("page:")]}


def batch_status(statuses):
    done = [s for s in statuses if s in ("published", "failed", "blocked")]
    if statuses and len(done) == len(statuses):
        if all(s == "published" for s in statuses):
            return "completed"
        if all(s == "blocked" for s in statuses):
            return "blocked"
        if all(s == "failed" for s in statuses):
            return "failed"
        return "partial"
    return "running" if "publishing" in statuses else "pending"


def _job_view(j):
    return {"channelId": j["channel_id"], "postJobId": j["id"], "status": j["status"], "productOrigin": "sheet",
            "attemptCount": j["attempt_count"], "publishedPostId": j["fb_post_id"], "publishedUrl": j["published_url"],
            "publishedAt": j["published_at"], "lastErrorCode": j["error_code"], "userMessage": j["user_message"] or "",
            "progress": None}


@router.get("/posts/batches/{batch_id}")
def get_batch(batch_id: str):
    b = store.post_batch(batch_id)
    if not b:
        raise ApiError(404, "BATCH_NOT_FOUND", "Không có lô đăng này")
    jobs = store.post_jobs("batch_id=?", (batch_id,), order="created_at")
    st = [j["status"] for j in jobs]
    status = batch_status(st)
    totals = {"total": len(st), "published": st.count("published"), "failed": st.count("failed"),
              "blocked": st.count("blocked"), "queued": st.count("queued"), "publishing": st.count("publishing"),
              "scheduledOnFacebook": st.count("scheduled_on_facebook"), "draft": st.count("draft"),
              "inProgress": st.count("queued") + st.count("publishing")}
    parts = [("%d hẹn giờ trên Facebook" % totals["scheduledOnFacebook"]) if totals["scheduledOnFacebook"] else "",
             ("%d chờ trong lịch app" % totals["queued"]) if totals["queued"] else "",
             ("%d đã đăng" % totals["published"]) if totals["published"] else "",
             ("%d bị chặn" % totals["blocked"]) if totals["blocked"] else "",
             ("%d lỗi" % totals["failed"]) if totals["failed"] else ""]
    return {"tenantId": TENANT_ID, "batchId": batch_id, "productCode": b["product_code"], "productOrigin": "sheet",
            "color": b["color"] or "", "format": b["format"], "status": status, "totals": totals,
            "startedAt": b["created_at"], "finishedAt": None, "durationMs": None,
            "channels": [_job_view(j) for j in jobs],
            "summaryMessage": "%d kênh: %s" % (len(st), ", ".join(p for p in parts if p) or "đang xử lý"),
            "progressSteps": []}


# ---------------- lịch đã hẹn + nhật ký ----------------
def _page(items, cursor, limit):
    start = int(cursor or 0)
    return items[start:start + limit], (str(start + limit) if start + limit < len(items) else None)


@router.get("/posts/scheduled")
def scheduled(channelId: Optional[str] = None, from_: Optional[str] = Query(None, alias="from"),
              to: Optional[str] = None, cursor: Optional[str] = None, limit: int = Query(50, ge=1, le=200)):
    jobs = store.post_jobs("scheduled_at is not null and status in ('queued','scheduled_on_facebook')", order="scheduled_at")
    lo = _parse_dt(from_, "from") if from_ else None
    hi = _parse_dt(to, "to") if to else None
    t = now()
    items = []
    for j in jobs:
        when = _parse_dt(j["scheduled_at"], "scheduledAt")
        if (channelId and j["channel_id"] != channelId) or (lo and when < lo) or (hi and when >= hi):
            continue
        starts = int((when - t).total_seconds() * 1000)
        items.append({"postJobId": j["id"], "batchId": j["batch_id"], "productCode": j["product_code"],
                      "color": j["color"] or "", "channelId": j["channel_id"], "format": j["format"],
                      "status": j["status"], "scheduledAt": j["scheduled_at"], "startsInMs": starts,
                      "overdue": starts < 0 and j["status"] == "queued", "captionPreview": j["caption"][:160],
                      "mediaCount": len(j["media"]), "userMessage": j["user_message"] or "",
                      "canReschedule": j["status"] == "queued", "canCancel": True, "createdAt": j["created_at"]})
    page_items, nxt = _page(items, cursor, limit)
    return {"tenantId": TENANT_ID, "items": page_items, "nextCursor": nxt, "limit": limit}


def _job_or_404(job_id):
    j = store.post_job(job_id)
    if not j:
        raise ApiError(404, "BATCH_NOT_FOUND", "Không có bài này")
    return j


class RescheduleIn(BaseModel):
    model_config = ConfigDict(extra="ignore")
    scheduledAt: str


@router.post("/posts/scheduled/{job_id}/reschedule")
def reschedule(job_id: str, body: RescheduleIn):
    j = _job_or_404(job_id)
    if j["status"] != "queued":
        raise ApiError(409, "INVALID_INPUT", "Bài đã hẹn trên Facebook — đổi giờ trên Meta Business Suite" if
                       j["status"] == "scheduled_on_facebook" else "Bài này không còn chờ đăng")
    when = _parse_dt(body.scheduledAt, "scheduledAt")
    if when < now() + schedule.MIN_LEAD:
        raise ApiError(400, "INVALID_INPUT", "Giờ đăng phải sau hiện tại ít nhất 10 phút")
    store.update_post_job(job_id, z(now()), scheduled_at=z(when))
    return {"tenantId": TENANT_ID, "postJobId": job_id, "channelId": j["channel_id"], "batchId": j["batch_id"],
            "previousScheduledAt": j["scheduled_at"], "scheduledAt": z(when),
            "delayMs": int((when - now()).total_seconds() * 1000), "queueJobId": job_id,
            "previousQueueEntryRemoved": True, "userMessage": "Đã đổi giờ đăng"}


@router.post("/posts/scheduled/{job_id}/cancel")
def cancel(job_id: str, body: Optional[dict] = None):
    j = _job_or_404(job_id)
    if j["status"] not in ("queued", "scheduled_on_facebook"):
        raise ApiError(409, "INVALID_INPUT", "Bài này không còn chờ đăng")
    creds = page_credentials(j["channel_id"])
    deleted = tools.delete_fb_post(j["fb_post_id"], creds[1] if creds else None) \
        if j["status"] == "scheduled_on_facebook" else False
    if j["status"] == "scheduled_on_facebook" and not deleted:
        raise ApiError(502, "PUBLISH_FAILED", "Facebook chưa xoá được bài hẹn giờ — thử lại hoặc huỷ trên Meta Business Suite")
    msg = "Đã huỷ" + (" và xoá bài hẹn giờ trên Facebook" if deleted else "")
    store.update_post_job(job_id, z(now()), status="blocked", user_message=msg)
    return {"tenantId": TENANT_ID, "postJobId": job_id, "batchId": j["batch_id"], "channelId": j["channel_id"],
            "status": "blocked", "scheduledAt": j["scheduled_at"], "queueEntryRemoved": True,
            "platformPostDeleted": deleted, "userMessage": msg}


@router.get("/posts/jobs")
def jobs(status: Optional[str] = None, batchId: Optional[str] = None, cursor: Optional[str] = None,
         limit: int = Query(25, ge=1, le=200)):
    where, params = ["1=1"], []
    if status:
        where.append("status=?")
        params.append(status)
    if batchId:
        where.append("batch_id=?")
        params.append(batchId)
    rows = store.post_jobs(" and ".join(where), tuple(params))
    items = [{"postJobId": j["id"], "batchId": j["batch_id"], "productCode": j["product_code"], "productOrigin": "sheet",
              "color": j["color"] or "", "channelId": j["channel_id"], "format": j["format"], "status": j["status"],
              "attemptCount": j["attempt_count"], "lastErrorCode": j["error_code"], "userMessage": j["user_message"] or "",
              "publishedPostId": j["fb_post_id"], "publishedUrl": j["published_url"], "publishedAt": j["published_at"],
              "scheduledAt": j["scheduled_at"], "createdAt": j["created_at"], "updatedAt": j["updated_at"],
              "canRetry": j["status"] == "failed"} for j in rows]
    page_items, nxt = _page(items, cursor, limit)
    return {"tenantId": TENANT_ID, "items": page_items, "nextCursor": nxt, "limit": limit}


@router.post("/posts/jobs/{job_id}/retry")
def retry(job_id: str, body: Optional[dict] = None):
    j = _job_or_404(job_id)
    if j["status"] != "failed":
        raise ApiError(409, "INVALID_INPUT", "Chỉ thử lại được bài bị lỗi")
    when = _parse_dt(j["scheduled_at"], "scheduledAt") if j["scheduled_at"] else None
    if when and when < now() + schedule.MIN_LEAD:
        raise ApiError(409, "INVALID_INPUT", "Giờ hẹn cũ đã qua — tạo lại bài với giờ mới")
    upd = _publish(job_id, j["channel_id"], j["caption"], j["media"], when)
    upd.setdefault("error_code", None)
    store.update_post_job(job_id, z(now()), attempt_count=j["attempt_count"] + 1, **upd)
    return {"tenantId": TENANT_ID, "postJobId": job_id, "batchId": j["batch_id"], "channelId": j["channel_id"],
            "productCode": j["product_code"], "previousStatus": "failed", "status": upd["status"],
            "queueJobId": job_id, "attemptCount": j["attempt_count"] + 1, "userMessage": upd["user_message"]}


@router.get("/posts/worker-health")
def worker_health():
    queued = store.post_jobs("status='queued'")
    # không có worker tự đăng: chỉ Facebook (khi có token) đăng đúng giờ — nói thật trên banner
    return {"workersAvailable": bool(tools.fb_page()), "workersOnline": 1 if tools.fb_page() else 0,
            "queueReachable": True, "untouchedQueuedJobs": len(queued), "oldestUntouchedWaitMs": None,
            "checkedAt": z(now())}


# ---------------- phần giao diện cần nhưng lát cắt không dùng ----------------
@router.get("/posts/drafts")
def get_draft():
    return {"draft": None, "updatedAt": None, "persisted": False, "ownerKey": None}


@router.put("/posts/drafts")
@router.post("/posts/drafts")
def save_draft():
    return {"updatedAt": None, "persisted": False, "reason": "VPOST chưa lưu nháp soạn bài"}


@router.delete("/posts/drafts")
def delete_draft():
    return Response(status_code=204)


@router.post("/posts/uploads/detect-code")
def detect_code(body: dict):
    files = [f.get("fileName", "") for f in (body.get("files") or []) if isinstance(f, dict)]
    return {"verdict": {"status": "no_code"},
            "files": [{"fileName": f, "status": "none", "productCode": None} for f in files], "warnings": []}


# ---------------- OAuth Facebook: nối Page thật cho màn Kênh ----------------
STATE_COOKIE = "vpost_fb_state"
CHANNELS_SCREEN = os.environ.get("VPOST_UI_URL", "http://localhost:3010").rstrip("/") + "/channels"


def _back(query):
    return RedirectResponse("%s?%s" % (CHANNELS_SCREEN, query), status_code=302)


def _import_pages(user_token):
    """Token người dùng → lưu mọi Page có token. Lỗi Facebook → ApiError có mã."""
    try:
        if facebook.app_config():
            user_token = facebook.long_lived(user_token)   # để token Page không hết hạn
        pages = facebook.pages(user_token)
    except facebook.FacebookError as e:
        raise ApiError(502 if e.code == "GRAPH_UNREACHABLE" else 400, e.code, e.user_message)
    usable = [p for p in pages if p.get("access_token")]
    new, upd = store.save_fb_pages(usable, user_token, z(now()))
    return {"tenantId": TENANT_ID, "imported": new, "updated": upd, "skipped": len(pages) - len(usable),
            "channels": [c for c in channels_list() if c["channelId"].startswith(FB_PAGE_PREFIX)]}


@router.get("/channels/connect")
def channels_connect():
    """Bắt đầu OAuth: 302 sang hộp thoại đăng nhập Facebook, kèm state chống giả mạo (cookie HttpOnly)."""
    state = secrets.token_urlsafe(24)
    try:
        url = facebook.authorize_url(state)
    except facebook.FacebookError as e:
        return _back("connect=error&reason=%s" % e.code)
    resp = RedirectResponse(url, status_code=302)
    resp.set_cookie(STATE_COOKIE, state, max_age=600, httponly=True, samesite="lax", path="/api/channels")
    return resp


@router.get("/channels/callback")
def channels_callback(request: Request, code: str = "", state: str = "", error: str = ""):
    """Facebook gọi lại sau khi người dùng bấm cho phép (hoặc huỷ)."""
    expected = request.cookies.get(STATE_COOKIE, "")
    if error:
        resp = _back("connect=cancelled")
    elif not (code and state and expected and secrets.compare_digest(state, expected)):
        resp = _back("connect=error&reason=STATE_MISMATCH")
    else:
        try:
            r = _import_pages(facebook.exchange_code(code))
            resp = _back("connected=%d&new=%d&skipped=%d" % (r["imported"] + r["updated"], r["imported"], r["skipped"]))
        except facebook.FacebookError as e:
            resp = _back("connect=error&reason=%s" % e.code)
        except ApiError as e:
            resp = _back("connect=error&reason=%s" % e.detail["code"])
    resp.delete_cookie(STATE_COOKIE, path="/api/channels")
    return resp


class ImportIn(BaseModel):
    model_config = ConfigDict(extra="ignore")
    userAccessToken: str = Field(min_length=1, max_length=2000, pattern=r"^\S+$")


@router.post("/channels/import")
def channels_import(body: ImportIn):
    """Cửa phụ: dán User Access Token (từ Graph API Explorer) thay cho đăng nhập."""
    return _import_pages(body.userAccessToken)


@router.post("/channels/refresh")
def channels_refresh(body: Optional[dict] = None):
    token = store.fb_user_token()
    if not token:
        raise ApiError(409, "CHANNEL_NOT_CONFIGURED", "Chưa nối Facebook lần nào — bấm Kết nối Facebook trước")
    return _import_pages(token)


class ChannelStatusIn(BaseModel):
    model_config = ConfigDict(extra="ignore")
    status: str = Field(pattern=r"^(active|disabled)$")


@router.put("/channels/{channel_id}")
def channel_set_status(channel_id: str, body: ChannelStatusIn):
    if channel_id not in _channel_map():
        raise ApiError(404, "CHANNEL_NOT_CONFIGURED", "Không có kênh này")
    store.set_channel_status(channel_id, body.status)
    return {"channelId": channel_id, "status": body.status}


@router.delete("/channels/{channel_id}")
def channel_remove(channel_id: str):
    if not channel_id.startswith(FB_PAGE_PREFIX) or not store.fb_page(channel_id[len(FB_PAGE_PREFIX):]):
        raise ApiError(409, "INVALID_INPUT", "Chỉ gỡ được Page đã nối qua Facebook; kênh mẫu thì tắt thay vì gỡ")
    store.delete_fb_page(channel_id[len(FB_PAGE_PREFIX):])
    return {"channelId": channel_id, "removed": True}
