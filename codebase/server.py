"""Web app: tải file → bảng bài nháp → duyệt → lịch đăng.   Chạy: python codebase/server.py  → http://127.0.0.1:8020"""
import os
import sys
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import uuid  # noqa: E402

from fastapi import Body, FastAPI, File, Form, HTTPException, UploadFile  # noqa: E402
from fastapi.exceptions import RequestValidationError  # noqa: E402
from fastapi.responses import FileResponse, JSONResponse  # noqa: E402
from fastapi.staticfiles import StaticFiles  # noqa: E402
from starlette.exceptions import HTTPException as StarletteHTTPException  # noqa: E402

import agent  # noqa: E402
import moderation_api  # noqa: E402
import moderation_store  # noqa: E402
import rules  # noqa: E402
import schedule  # noqa: E402
import store  # noqa: E402
import tools  # noqa: E402
import vpost_api  # noqa: E402
from ai import MODEL_NAME, MODEL_PROVIDER, call_model  # noqa: E402

WEB = os.path.join(os.path.dirname(os.path.abspath(__file__)), "web")
MAX_ROWS = 200          # chặn file quá lớn (chi phí)
MAX_BYTES = 10 * 1024 * 1024
MODEL = call_model      # test thay bằng model giả
SYNC = False            # test: xử lý ngay trong request
pool = ThreadPoolExecutor(max_workers=4)
app = FastAPI(title="VPOST")
try:
    store.init()
except Exception as e:
    raise RuntimeError(
        "Không thể kết nối hoặc khởi tạo cơ sở dữ liệu PostgreSQL (DATABASE_URL): %s" % e
    ) from e
moderation_store.init_moderation()
app.include_router(moderation_api.router)
app.include_router(vpost_api.router)
if not store.catalog_rows():  # máy mới: nạp sẵn file demo để giao diện có dữ liệu
    vpost_api.load_catalog(rules.read_table(open(os.path.join(rules.DATA, "demo_products.xlsx"), "rb").read(), "demo.xlsx"))

ERROR_CODES = {400: "INVALID_INPUT", 404: "NOT_FOUND", 405: "INVALID_INPUT", 409: "CONFLICT", 413: "INVALID_INPUT",
               422: "INVALID_INPUT", 502: "UPSTREAM_ERROR"}


@app.exception_handler(StarletteHTTPException)
async def http_error(request, exc):
    """Mọi lỗi trả {code, message} như giao diện VPOST chờ; giữ thêm `detail` cho giao diện cũ (codebase/web)."""
    d = exc.detail
    body = dict(d) if isinstance(d, dict) and "code" in d else \
        {"code": ERROR_CODES.get(exc.status_code, "ERROR"), "message": str(d or "Lỗi")}
    body["detail"] = body["message"]
    return JSONResponse(body, status_code=exc.status_code)


@app.exception_handler(RequestValidationError)
async def validation_error(request, exc):
    issues = [{"path": ".".join(str(p) for p in e["loc"] if p not in ("body", "query", "path")), "message": e["msg"]}
              for e in exc.errors()]
    msg = "Dữ liệu gửi lên không hợp lệ: " + "; ".join("%s %s" % (i["path"], i["message"]) for i in issues)
    return JSONResponse({"code": "INVALID_INPUT", "message": msg, "issues": issues, "detail": msg}, status_code=400)


def _process(row_id, default_page):
    r = store.get_row(row_id)
    tok = [0, 0]

    def counted(system, user, schema=None):
        res = MODEL(system, user, schema)
        tok[0] += res.get("tokens_in", 0)
        tok[1] += res.get("tokens_out", 0)
        return res

    try:
        data, dropped = r["data"], []
        imgs = rules.parse_images(data.get("anh"))
        if imgs:  # ảnh không tải được thì bỏ khỏi dòng, không đưa lên bài
            chk = tools.check_images(imgs)
            if chk["broken"]:
                dropped = chk["broken"]
                data = dict(data, anh="\n".join(chk["ok"]))
                store.update(row_id, data=data)
        page, pwarn = tools.page_for(data, default_page)
        res = agent.process_row(data, page, model=counted)
        if pwarn:
            res["warnings"].insert(0, "%s: %s" % pwarn)
        if dropped:
            res["warnings"].insert(0, "anh: đã bỏ %d ảnh không tải được" % len(dropped))
        store.save_result(row_id, res, tok)
    except Exception as e:  # lỗi gọi model / mạng: ghi lại, không làm sập cả lô
        store.update(row_id, status="error", reasons=[["he_thong", "%s: %s" % (type(e).__name__, str(e)[:200])]],
                     tokens_in=tok[0], tokens_out=tok[1])


def _submit(row_id, default_page):
    if SYNC:
        _process(row_id, default_page)
    else:
        pool.submit(_process, row_id, default_page)


@app.get("/api/meta")
def meta():
    inv = tools.inventory()
    return {"model": MODEL_NAME if MODEL_PROVIDER != "fake" else "fake (chưa nối model)",
            "facebook": bool(os.environ.get("FB_PAGE_ID") and os.environ.get("FB_PAGE_TOKEN")),
            "inventory": {"codes": len(inv), "variants": sum(len(v) for v in inv.values()),
                          "file": os.path.basename(tools.inventory_path())}}


@app.get("/api/pages")
def pages():
    return [{k: p[k] for k in ("id", "name", "gu", "floor_vnd", "slots")} for p in tools.PAGES.values()]


@app.post("/api/batches")
async def upload(file: UploadFile = File(...), default_page: str = Form(tools.DEFAULT_PAGE)):
    data = await file.read()
    if len(data) > MAX_BYTES:
        raise HTTPException(413, "file lớn hơn 10MB")
    try:
        rows = tools.read_products(data, file.filename or "")
    except ValueError as e:
        raise HTTPException(400, str(e))
    if not rows:
        raise HTTPException(400, "file không có dòng sản phẩm nào")
    if len(rows) > MAX_ROWS:
        raise HTTPException(400, "file có %d dòng — tối đa %d dòng mỗi lần" % (len(rows), MAX_ROWS))
    if default_page not in tools.PAGES:
        raise HTTPException(400, "page mặc định không hợp lệ")
    bid = store.create_batch(file.filename, default_page, rows)
    for r in store.get_batch(bid)["rows"]:
        _submit(r["id"], default_page)
    return {"id": bid, "rows": len(rows)}


@app.get("/api/batches")
def batches():
    return store.list_batches()


@app.get("/api/batches/{bid}")
def batch(bid: int):
    b = store.get_batch(bid)
    if not b:
        raise HTTPException(404, "không có lô này")
    return b


def _row_or_404(rid):
    r = store.get_row(rid)
    if not r:
        raise HTTPException(404, "không có dòng này")
    return r


def _allowed(r):
    page = tools.PAGES.get(r["page_id"]) or tools.PAGES[tools.DEFAULT_PAGE]
    return rules.allowed_facts(r["data"], rules.check_stock(r["data"], tools.inventory()), page, tools.GLOB)


@app.patch("/api/rows/{rid}")
def edit(rid: int, body: dict = Body(...)):
    """Người sửa bài. Soát lại bằng code và trả cảnh báo — người có quyền quyết, nhưng phải thấy."""
    r = _row_or_404(rid)
    if r["status"] != "written":
        raise HTTPException(409, "chỉ sửa được bài đang chờ duyệt")
    text = str(body.get("text", ""))
    if not text.strip():
        raise HTTPException(400, "bài trống")
    store.update(rid, edited=text)
    v = rules.verify_post(text, _allowed(r))
    return {"ok": True, "check": v}


@app.post("/api/rows/{rid}/approve")
def approve(rid: int, body: dict = Body(default={})):
    r = _row_or_404(rid)
    if r["status"] != "written":
        raise HTTPException(409, "chỉ duyệt được bài đang chờ duyệt (dòng bị đánh dấu / đã lên lịch thì không)")
    if not r["images"]:
        raise HTTPException(409, "bài cần ít nhất 1 ảnh sản phẩm — thêm ảnh rồi duyệt")
    page = tools.PAGES.get(r["page_id"]) or tools.PAGES[tools.DEFAULT_PAGE]
    taken = store.taken_slots(page["id"])
    if body.get("when"):
        try:
            when = schedule.parse_when(body["when"])
        except ValueError:
            raise HTTPException(400, "giờ không hợp lệ")
        if when < schedule.now() + schedule.MIN_LEAD:
            raise HTTPException(400, "giờ đăng phải sau hiện tại ít nhất 10 phút")
        if when.isoformat() in taken:
            raise HTTPException(409, "khung giờ này của page đã có bài")
    else:
        when = schedule.next_free_slot(page, taken)
        if not when:
            raise HTTPException(409, "page hết khung giờ trống trong 30 ngày tới")
    try:
        sch = tools.schedule_post(r["text"], int(when.timestamp()), r["images"])
    except Exception as e:
        raise HTTPException(502, "Facebook từ chối hẹn giờ: %s" % str(e)[:200])
    store.update(rid, status="scheduled", slot=when.isoformat(), schedule_mode=sch["mode"], fb_post_id=sch["fb_post_id"] or "")
    return {"ok": True, "slot": when.isoformat(), "mode": sch["mode"]}


@app.post("/api/rows/{rid}/unschedule")
def unschedule(rid: int):
    r = _row_or_404(rid)
    if r["status"] != "scheduled":
        raise HTTPException(409, "dòng chưa lên lịch")
    if r["schedule_mode"] == "facebook":
        raise HTTPException(409, "bài đã hẹn giờ trên Facebook — huỷ trên Meta Business Suite")
    store.update(rid, status="written", slot="", schedule_mode="")
    return {"ok": True}


@app.post("/api/rows/{rid}/reject")
def reject(rid: int):
    r = _row_or_404(rid)
    if r["status"] not in ("written", "flagged", "error"):
        raise HTTPException(409, "không bỏ được dòng ở trạng thái này")
    store.update(rid, status="rejected")
    return {"ok": True}


@app.post("/api/rows/{rid}/regenerate")
def regenerate(rid: int, body: dict = Body(default={})):
    """Viết lại; body.fields (tuỳ chọn) sửa dữ liệu dòng trước — vd điền giá còn thiếu."""
    r = _row_or_404(rid)
    if r["status"] in ("scheduled", "pending"):
        raise HTTPException(409, "dòng đang xử lý hoặc đã lên lịch")
    data = dict(r["data"])
    for k, v in (body.get("fields") or {}).items():
        if k in rules.FIELDS:
            data[k] = str(v).strip()
    b = store.get_batch(r["batch_id"])
    store.update(rid, data=data, status="pending", reasons=[], warnings=[], post="", edited="")
    _submit(rid, b["default_page"])
    return {"ok": True}


IMAGE_TYPES = {b"\xff\xd8\xff": "jpg", b"\x89PNG": "png", b"RIFF": "webp"}
MAX_IMAGE_BYTES = 8 * 1024 * 1024


@app.post("/api/rows/{rid}/images")
async def add_images(rid: int, files: list[UploadFile] = File(...)):
    """Thêm ảnh cho một dòng (jpg/png/webp, ≤8MB/ảnh, tối đa 10 ảnh/bài)."""
    r = _row_or_404(rid)
    if r["status"] in ("scheduled", "pending"):
        raise HTTPException(409, "dòng đang xử lý hoặc đã lên lịch")
    urls = list(r["images"])
    os.makedirs(tools.UPLOADS, exist_ok=True)
    for f in files:
        data = await f.read()
        ext = next((e for magic, e in IMAGE_TYPES.items() if data.startswith(magic)), None)
        if not ext or (ext == "webp" and data[8:12] != b"WEBP"):
            raise HTTPException(400, "'%s' không phải ảnh jpg/png/webp" % f.filename)
        if len(data) > MAX_IMAGE_BYTES:
            raise HTTPException(413, "'%s' lớn hơn 8MB" % f.filename)
        if len(urls) >= rules.MAX_IMAGES:
            raise HTTPException(400, "mỗi bài tối đa %d ảnh" % rules.MAX_IMAGES)
        name = "%d-%s.%s" % (rid, uuid.uuid4().hex[:8], ext)
        with open(os.path.join(tools.UPLOADS, name), "wb") as out:
            out.write(data)
        urls.append("/uploads/" + name)
    data = dict(r["data"], anh="\n".join(urls))
    store.update(rid, data=data, warnings=[w for w in r["warnings"] if not w.startswith("anh:")])
    return {"ok": True, "images": urls}


@app.post("/api/rows/{rid}/images/remove")
def remove_image(rid: int, body: dict = Body(...)):
    r = _row_or_404(rid)
    if r["status"] in ("scheduled", "pending"):
        raise HTTPException(409, "dòng đang xử lý hoặc đã lên lịch")
    url = body.get("url")
    if url not in r["images"]:
        raise HTTPException(404, "bài không có ảnh này")
    path = tools.local_image(url)
    if path and url.startswith("/uploads/") and os.path.exists(path):
        os.remove(path)
    urls = [u for u in r["images"] if u != url]
    store.update(rid, data=dict(r["data"], anh="\n".join(urls)))
    return {"ok": True, "images": urls}


@app.get("/api/schedule")
def calendar(start: str = None, days: int = 7):
    s = datetime.fromisoformat(start).replace(tzinfo=schedule.TZ) if start else \
        schedule.now().replace(hour=0, minute=0, second=0, microsecond=0)
    e = s + timedelta(days=max(1, min(days, 31)))
    return {"start": s.isoformat(), "end": e.isoformat(), "posts": store.scheduled_between(s.isoformat(), e.isoformat())}


@app.post("/api/inventory")
async def upload_inventory(file: UploadFile = File(...)):
    data = await file.read()
    try:
        n = tools.save_inventory(data, file.filename or "")
    except ValueError as e:
        raise HTTPException(400, str(e))
    return {"ok": True, "variants": n}


@app.get("/api/sample")
def sample():
    return FileResponse(os.path.join(rules.DATA, "demo_products.xlsx"), filename="san-pham-mau.xlsx")


app.mount("/static", StaticFiles(directory=WEB), name="static")
os.makedirs(tools.UPLOADS, exist_ok=True)
app.mount("/uploads", StaticFiles(directory=tools.UPLOADS), name="uploads")


@app.get("/")
def index():
    return FileResponse(os.path.join(WEB, "index.html"))


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=int(os.environ.get("PORT", 8020)))
