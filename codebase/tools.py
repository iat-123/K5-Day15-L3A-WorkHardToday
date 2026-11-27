"""Công cụ của bài toán. Mỗi công cụ một hàm có @tool (khung tự ghi vào trace).

Docstring: tên · input · output · có tác động ra ngoài không. Luật nằm ở rules.py (hàm thuần, có test).
"""
import json
import os
import re

import rules
from tracing import tool, TOOLS  # noqa: F401

GLOB, PAGES = rules.load_config()
DEFAULT_PAGE = "diu-may"
_inv = {"key": None, "data": {}}
DEMO_INVENTORY = os.path.join(rules.DATA, "inventory.csv")          # tồn dựng, có trong repo
LOCAL_INVENTORY = os.path.join(rules.DATA, "inventory.local.csv")   # file tồn người dùng tải lên (không commit)
INV_ALIASES = {"ma_sp": ["ma_sp", "ma", "ma san pham", "ma hang"], "mau": ["mau", "mau sac"], "size": ["size", "kich co"],
               "ton": ["ton", "co the ban", "so luong", "ton kho"], "trang_thai": ["trang_thai", "trang thai", "luu y nhan sx 1c"]}


def inventory_path():
    return LOCAL_INVENTORY if os.path.exists(LOCAL_INVENTORY) else DEMO_INVENTORY


def inventory():
    """Đọc lại file tồn khi file đổi (người dùng tải file tồn mới qua API)."""
    path = inventory_path()
    key = (path, os.path.getmtime(path)) if os.path.exists(path) else None
    if key != _inv["key"]:
        _inv.update(key=key, data=rules.load_inventory(path))
    return _inv["data"]


def save_inventory(data, filename):
    """File tồn mới (.csv/.xlsx: mã, màu, size, tồn, trạng thái) → data/inventory.local.csv. Trả số biến thể."""
    import csv
    import io
    if filename.lower().endswith((".xlsx", ".xlsm")):
        import openpyxl
        ws = openpyxl.load_workbook(io.BytesIO(data), read_only=True, data_only=True).worksheets[0]
        rows = [[rules._cell(c) for c in r] for r in ws.iter_rows(values_only=True)]
    elif filename.lower().endswith(".csv"):
        rows = list(csv.reader(io.StringIO(data.decode("utf-8-sig"))))
    else:
        raise ValueError("chỉ nhận .xlsx hoặc .csv")
    rows = [r for r in rows if any(str(c).strip() for c in r)]
    if len(rows) < 2:
        raise ValueError("file tồn trống")
    alias = {a: k for k, v in INV_ALIASES.items() for a in v}
    head = [alias.get(rules.fold(h)) for h in rows[0]]
    if "ma_sp" not in head or "ton" not in head:
        raise ValueError("file tồn cần ít nhất cột mã sản phẩm và tồn")
    out = []
    for r in rows[1:]:
        d = {k: str(v).strip() for k, v in zip(head, r) if k}
        try:
            d["ton"] = int(float(d.get("ton") or 0))
        except ValueError:
            raise ValueError("cột tồn có giá trị không phải số: %r" % d.get("ton"))
        if d.get("ma_sp"):
            out.append(d)
    with open(LOCAL_INVENTORY, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=["ma_sp", "mau", "size", "ton", "trang_thai"], extrasaction="ignore")
        w.writeheader()
        w.writerows(out)
    return len(out)


def page_for(row, default=None):
    """Cột page của dòng thắng nếu khớp; trống/lạ → page mặc định (kèm cảnh báo)."""
    pid = (row.get("page") or "").strip()
    if pid in PAGES:
        return PAGES[pid], None
    for p in PAGES.values():  # cho phép ghi tên page thay vì id
        if pid and rules.fold(pid) == rules.fold(p["name"]):
            return p, None
    d = PAGES.get(default) or PAGES[DEFAULT_PAGE]
    return d, (("page", "page '%s' không có — dùng page %s" % (pid, d["name"])) if pid else None)


@tool
def read_products(data: bytes, filename: str) -> list:
    """read_products · input: nội dung file .xlsx/.csv + tên file · output: danh sách dòng đã chuẩn hoá tên cột
    · không tác động ra ngoài. Lỗi định dạng → ValueError."""
    return rules.read_table(data, filename)


@tool
def check_product(row: dict, page: dict) -> dict:
    """check_product · input: 1 dòng + page · output: {"hard": [(trường, vấn đề)], "warn": [...]} · không tác động ra ngoài."""
    return rules.check_product(row, page, GLOB)


@tool
def check_stock(row: dict) -> dict:
    """check_stock · input: 1 dòng (mã, màu, size) · output: lỗi hết hàng / màu, size còn tồn / cảnh báo sắp hết
    · không tác động ra ngoài (chỉ đọc data/inventory.csv)."""
    return rules.check_stock(row, inventory())


@tool
def verify_post(text: str, allowed: dict, is_comment: bool = False) -> dict:
    """verify_post · input: bài/trả lời + dữ kiện được phép + is_comment · output: {"block": [...], "warn": [...]} · không tác động ra ngoài."""
    return rules.verify_post(text, allowed, is_comment=is_comment)


@tool
def save_drafts(batch_id: int, results: list) -> int:
    """save_drafts · input: mã lô + kết quả từng dòng · output: số dòng đã lưu · chỉ ghi DB nội bộ của app."""
    import store
    for r in results:
        store.save_result(r["row_id"], r["result"])
    return len(results)


UPLOADS = os.path.join(rules.DATA, "uploads")           # ảnh người dùng tải lên trong app (không commit)


@tool
def check_images(urls: list) -> dict:
    """check_images · input: danh sách link ảnh · output: {"ok": [...], "broken": [...]} — ảnh không tải được
    (lỗi mạng, không phải ảnh, không công khai) vào broken · chỉ đọc (GET link ảnh), không tác động ra ngoài."""
    import httpx
    ok, broken = [], []
    with httpx.Client(timeout=10, follow_redirects=True, headers={"User-Agent": "Mozilla/5.0"}) as c:
        for url in urls:
            path = local_image(url)
            if path:
                (ok if os.path.exists(path) else broken).append(url)
                continue
            try:
                with c.stream("GET", url) as r:
                    good = r.status_code == 200 and r.headers.get("content-type", "").startswith("image/")
            except httpx.HTTPError:
                good = False
            (ok if good else broken).append(url)
    return {"ok": ok, "broken": broken}


def local_image(url):
    """'/uploads/x.png' (ảnh tải lên trong app) → đường dẫn file trên máy; link ngoài → None."""
    m = re.match(r"/uploads/([\w.-]+)$", url or "")
    return os.path.join(UPLOADS, m.group(1)) if m else None


def fb_page():
    """(page_id, token) của Fanpage thử nếu .env có đủ, ngược lại None."""
    page_id, token = os.environ.get("FB_PAGE_ID", "").strip(), os.environ.get("FB_PAGE_TOKEN", "").strip()
    return (page_id, token) if page_id and token else None


def _graph():
    return "https://graph.facebook.com/" + os.environ.get("FB_GRAPH_VERSION", "v23.0")


@tool
def schedule_post(text: str, when_ts, images: list, page=None) -> dict:
    """schedule_post · input: bài đã DUYỆT + thời điểm (unix; None = đăng ngay) + danh sách ảnh
    · output: {"mode": "app"|"facebook", "fb_post_id"}
    · CÓ tác động ra ngoài khi .env có FB_PAGE_ID + FB_PAGE_TOKEN: tải ảnh lên Fanpage thử ở dạng chưa đăng, rồi tạo
    bài HẸN GIỜ (published=false, huỷ được) hoặc đăng ngay khi when_ts=None. Chỉ được gọi từ nút Duyệt của người."""
    fb = page or fb_page()   # page = (page_id, token) của Page nối qua OAuth; không có thì dùng Fanpage thử trong .env
    if not fb:
        return {"mode": "app", "fb_post_id": None}
    page_id, token = fb
    import httpx
    base = "%s/%s" % (_graph(), page_id)
    media = []
    with httpx.Client(timeout=60) as c:
        for url in images:
            data = {"published": "false", "access_token": token}
            if when_ts:  # ảnh cho bài hẹn giờ phải là ảnh tạm, Facebook gắn vào bài lúc đăng
                data["temporary"] = "true"
            path = local_image(url)
            if path:
                with open(path, "rb") as f:
                    r = c.post(base + "/photos", data=data, files={"source": (os.path.basename(path), f)})
            else:
                r = c.post(base + "/photos", data=dict(data, url=url))
            r.raise_for_status()
            media.append(r.json()["id"])
        body = {"message": text, "access_token": token}
        if when_ts:
            body.update(published="false", scheduled_publish_time=str(when_ts))
        for i, mid in enumerate(media):
            body["attached_media[%d]" % i] = json.dumps({"media_fbid": mid})
        r = c.post(base + "/feed", data=body)
        r.raise_for_status()
        return {"mode": "facebook", "fb_post_id": r.json().get("id")}


@tool
def delete_fb_post(post_id: str, channel_id: str = None) -> bool:
    """delete_fb_post · input: id bài trên Facebook + channel_id (tuỳ chọn, mặc định Fanpage thử) · output: True nếu Facebook xoá được
    · CÓ tác động ra ngoài: xoá bài (dùng khi người bấm Huỷ lịch một bài đã hẹn giờ trên Facebook)."""
    fb = fb_credentials(channel_id) if channel_id else fb_page()
    if not fb or not post_id:
        return False
    import httpx
    r = httpx.delete("%s/%s" % (_graph(), post_id), headers={"Authorization": "Bearer %s" % fb[1]}, timeout=30)
    return r.status_code == 200 and r.json().get("success") is True


def fb_credentials(channel_id: str):
    """(page_id, token) của kênh Facebook thật (Fanpage thử .env hoặc Page nối qua OAuth), hoặc None."""
    if channel_id == "fb-test":
        return fb_page()
    if channel_id and channel_id.startswith("fb-"):
        import store
        p = store.fb_page(channel_id[3:])
        return (p["page_id"], p["page_token"]) if p and p.get("page_token") else None
    return None


def _resolve_fb_token(channel_id: str) -> str:
    creds = fb_credentials(channel_id)
    if creds and creds[1]:
        return creds[1]
    import facebook
    raise facebook.FacebookError("TOKEN_INVALID", "Kênh chưa có token Page Facebook — kết nối lại ở mục Kênh.")


@tool
def reply_fb_comment(target_id: str, message: str, channel_id: str) -> str:
    """reply_fb_comment · input: target_id (parent_id nếu bình luận con, ngược lại comment_id) + message + channel_id
    · output: fb_reply_id (id bình luận trả lời mới trên Facebook)
    · CÓ tác động ra ngoài: đăng bình luận trả lời công khai lên Facebook Page. Chỉ gọi từ POST /api/comments/{id}/reply."""
    import facebook
    token = _resolve_fb_token(channel_id)
    return facebook.reply_comment(target_id, message, token)


@tool
def hide_fb_comment(comment_id: str, hidden: bool, channel_id: str) -> bool:
    """hide_fb_comment · input: comment_id + hidden (True=ẩn, False=hiện) + channel_id
    · output: True nếu Facebook cập nhật thành công
    · CÓ tác động ra ngoài: ẩn hoặc hiện bình luận trên Facebook Page. Chỉ gọi từ POST /api/comments/{id}/hide."""
    import facebook
    token = _resolve_fb_token(channel_id)
    return facebook.hide_comment(comment_id, hidden, token)


@tool
def delete_fb_comment(channel_id: str, comment_id: str) -> bool:
    """delete_fb_comment · input: channel_id + comment_id · output: True nếu đã xoá (hoặc đã không còn trên Facebook)
    · CÓ tác động ra ngoài: xoá vĩnh viễn bình luận trên Facebook Page (chỉ gọi khi người vận hành xác nhận)."""
    import facebook
    token = _resolve_fb_token(channel_id)
    return facebook.delete_comment(comment_id, token)
