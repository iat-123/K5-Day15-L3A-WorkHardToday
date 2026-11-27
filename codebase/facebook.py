"""OAuth Facebook (đăng nhập để lấy quyền trên Page) — gọi Graph API qua HTTPS, không phụ thuộc ngôn ngữ backend.

Luồng (giống MYSP, vpost/src/adapters/meta/facebook-oauth.ts):
  1. authorize_url(state) → hộp thoại www.facebook.com/<ver>/dialog/oauth (người dùng tự đăng nhập + bấm cho phép)
  2. Facebook gọi lại redirect_uri?code=…&state=… → exchange_code(code) → user token NGẮN hạn
  3. long_lived(token) → user token DÀI hạn (~60 ngày) → pages(token) → token của từng Page (không hết hạn)
.env cần: FB_APP_ID, FB_APP_SECRET (người dùng tự điền, không commit), FB_OAUTH_REDIRECT_URI (tuỳ chọn),
FB_LOGIN_CONFIG_ID (tuỳ chọn — app dùng "Facebook Login for Business" thì cấu hình quyền bằng config_id thay cho scope).
"""
import os
from datetime import datetime, timezone
from urllib.parse import urlencode

SCOPES = (
    "pages_show_list",
    "pages_manage_posts",
    "pages_read_engagement",
    "pages_read_user_content",
    "pages_manage_engagement",
)
DEFAULT_REDIRECT = "http://localhost:3010/api/channels/callback"   # đi qua proxy Next của giao diện VPOST
COMMENT_FIELDS = "id,message,created_time,from{id,name},parent{id},permalink_url,is_hidden,can_comment"


class FacebookError(Exception):
    """Lỗi từ Facebook — `code` là mã cho giao diện, `user_message` là câu tiếng Việt cho người vận hành."""

    def __init__(self, code, user_message):
        super().__init__(user_message)
        self.code, self.user_message = code, user_message


def _version():
    return os.environ.get("FB_GRAPH_VERSION", "v23.0").strip() or "v23.0"


def app_config():
    """(app_id, app_secret, redirect_uri) hoặc None khi .env chưa đủ."""
    app_id, secret = os.environ.get("FB_APP_ID", "").strip(), os.environ.get("FB_APP_SECRET", "").strip()
    if not (app_id and secret):
        return None
    return app_id, secret, os.environ.get("FB_OAUTH_REDIRECT_URI", "").strip() or DEFAULT_REDIRECT


def _require_app():
    cfg = app_config()
    if not cfg:
        raise FacebookError("APP_NOT_CONFIGURED", "Chưa cấu hình app Facebook: thêm FB_APP_ID và FB_APP_SECRET vào .env.")
    return cfg


def authorize_url(state):
    app_id, _, redirect = _require_app()
    q = {"client_id": app_id, "redirect_uri": redirect, "state": state, "response_type": "code"}
    config_id = os.environ.get("FB_LOGIN_CONFIG_ID", "").strip()
    if config_id:
        q["config_id"] = config_id
    else:
        q["scope"] = ",".join(SCOPES)
    return "https://www.facebook.com/%s/dialog/oauth?%s" % (_version(), urlencode(q))


class CommentList(list):
    """Danh sách bình luận trả về từ list_comments; giữ nguyên kiểu list và gắn cờ `truncated` nếu chạm max_pages."""

    def __init__(self, items=(), *, truncated=False):
        super().__init__(items)
        self.truncated = bool(truncated)


def _raise_for_error(r, body, extended=False):
    if r.status_code == 200 and not (isinstance(body, dict) and "error" in body):
        return
    raw_err = body.get("error") if isinstance(body, dict) else None
    err = raw_err if isinstance(raw_err, dict) else {}
    raw_code = err.get("code")
    subcode = err.get("error_subcode")
    msg = err.get("message") or (str(raw_err) if raw_err and not isinstance(raw_err, dict) else "")
    if raw_code == 190:
        raise FacebookError("TOKEN_INVALID", "Token Facebook không hợp lệ hoặc đã hết hạn — kết nối lại Page ở mục Kênh.")
    if extended:
        if raw_code in (10, 200):
            raise FacebookError(
                "PERMISSION_MISSING",
                "Page thiếu quyền đọc hoặc trả lời bình luận — vui lòng kết nối lại Page trong mục Kênh.",
            )
        if raw_code in (4, 17, 32, 613):
            raise FacebookError("RATE_LIMITED", "Facebook đang giới hạn tần suất gọi API — vui lòng thử lại sau ít phút.")
        if raw_code in (368, 1390008) or subcode == 1390008:
            raise FacebookError("POSTING_TOO_FAST", "Facebook tạm chặn bình luận do gửi quá nhanh — vui lòng đợi một lát rồi thử lại.")
    raise FacebookError("GRAPH_ERROR", "Facebook từ chối: %s" % (msg or "HTTP %s" % r.status_code))


def _get(path, extended_errors=False, **params):
    import httpx
    headers = {}
    token = params.pop("access_token", None)
    if token:
        headers["Authorization"] = "Bearer %s" % token
    try:
        r = httpx.get(
            "https://graph.facebook.com/%s%s" % (_version(), path),
            params=params,
            headers=headers or None,
            timeout=30,
        )
        body = r.json()
    except (httpx.HTTPError, ValueError) as e:
        code = "UPSTREAM_ERROR" if extended_errors else "GRAPH_UNREACHABLE"
        raise FacebookError(code, "Không gọi được Facebook: %s" % type(e).__name__)
    _raise_for_error(r, body, extended=extended_errors)
    return body


def _post(path, extended_errors=True, **data):
    import httpx
    try:
        r = httpx.post("https://graph.facebook.com/%s%s" % (_version(), path), data=data, timeout=30)
        body = r.json()
    except (httpx.HTTPError, ValueError) as e:
        code = "UPSTREAM_ERROR" if extended_errors else "GRAPH_UNREACHABLE"
        raise FacebookError(code, "Không gọi được Facebook: %s" % type(e).__name__)
    _raise_for_error(r, body, extended=extended_errors)
    return body


def parse_time(value):
    """Đổi chuỗi thời gian ISO của Graph API (kể cả +0000 / Z) sang datetime UTC, lỗi → None."""
    if not value:
        return None
    if isinstance(value, datetime):
        return value.astimezone(timezone.utc) if value.tzinfo else value.replace(tzinfo=timezone.utc)
    t = str(value).strip()
    if t.endswith("Z"):
        t = t[:-1] + "+00:00"
    elif len(t) >= 5 and t[-5] in ("+", "-") and t[-4:].isdigit():
        t = t[:-2] + ":" + t[-2:]
    try:
        dt = datetime.fromisoformat(t)
    except ValueError:
        return None
    return dt.astimezone(timezone.utc) if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def list_comments(fb_post_id, page_token, since=None, max_pages=20):
    """Lấy bình luận trên một bài đăng Facebook (mới nhất trước), dừng khi gặp bình luận cũ hơn `since`."""
    since_dt = parse_time(since)
    if since_dt is not None:
        # Graph API trả created_time theo độ chính xác giây — làm tròn xuống giây để không rớt bình luận cùng giây
        since_dt = since_dt.replace(microsecond=0)
    out, after, truncated = [], None, False
    for page_idx in range(max_pages):
        params = {
            "filter": "stream",
            "order": "reverse_chronological",
            "limit": 50,
            "fields": COMMENT_FIELDS,
            "access_token": page_token,
        }
        if after:
            params["after"] = after
        try:
            body = _get("/%s/comments" % fb_post_id, extended_errors=True, **params)
        except FacebookError as e:
            if e.code == "GRAPH_UNREACHABLE":
                raise FacebookError("UPSTREAM_ERROR", e.user_message)
            raise
        stop = False
        for item in body.get("data") or []:
            if not isinstance(item, dict) or not item.get("id"):
                continue
            if since_dt is not None:
                cdt = parse_time(item.get("created_time"))
                if cdt is not None and cdt < since_dt:
                    stop = True
                    break
            out.append(item)
        if stop:
            break
        paging = body.get("paging") or {}
        nxt = (paging.get("cursors") or {}).get("after") if paging.get("next") else None
        if not nxt or nxt == after:
            break
        if page_idx == max_pages - 1:
            truncated = True
            break
        after = nxt
    return CommentList(out, truncated=truncated)


def reply_comment(target_id, message, page_token):
    """Gửi bình luận trả lời vào `target_id` (parent nếu bình luận con, ngược lại chính comment_id). → fb_reply_id."""
    body = _post("/%s/comments" % target_id, extended_errors=True, message=message, access_token=page_token)
    return str(body.get("id") or "")


def hide_comment(comment_id, hidden, page_token):
    """Ẩn (hidden=True) hoặc hiện lại (hidden=False) bình luận trên Facebook. → bool."""
    body = _post("/%s" % comment_id, extended_errors=True, is_hidden="true" if hidden else "false", access_token=page_token)
    return bool(body.get("success", True))


def delete_comment(comment_id, page_token) -> bool:
    """Xoá vĩnh viễn bình luận trên Facebook (`DELETE /{comment_id}`). Mã 100 / not found coi như đã xoá → True."""
    import httpx
    try:
        r = httpx.delete(
            "https://graph.facebook.com/%s/%s" % (_version(), comment_id),
            headers={"Authorization": "Bearer %s" % page_token},
            timeout=30,
        )
        body = r.json()
    except (httpx.HTTPError, ValueError) as e:
        raise FacebookError("UPSTREAM_ERROR", "Không gọi được Facebook: %s" % type(e).__name__)
    if r.status_code == 200 and not (isinstance(body, dict) and "error" in body):
        return bool(body.get("success", True)) if isinstance(body, dict) else True
    raw_err = body.get("error") if isinstance(body, dict) else None
    err = raw_err if isinstance(raw_err, dict) else {}
    raw_code = err.get("code")
    subcode = err.get("error_subcode")
    msg_low = str(err.get("message") or "").lower()
    if raw_code == 100 and subcode != 1390008:
        return True
    if raw_code not in (190, 10, 200, 4, 17, 32, 613, 368, 1390008) and subcode != 1390008:
        if r.status_code == 404 or "not found" in msg_low or "does not exist" in msg_low:
            return True
    _raise_for_error(r, body, extended=True)
    return False


def exchange_code(code):
    """code từ callback → user token ngắn hạn."""
    app_id, secret, redirect = _require_app()
    return _post("/oauth/access_token", extended_errors=False, client_id=app_id, client_secret=secret,
                 redirect_uri=redirect, code=code)["access_token"]


def long_lived(user_token):
    """user token ngắn hạn → dài hạn (để token của Page lấy từ nó không hết hạn)."""
    app_id, secret, _ = _require_app()
    return _post("/oauth/access_token", extended_errors=False, grant_type="fb_exchange_token", client_id=app_id,
                 client_secret=secret, fb_exchange_token=user_token)["access_token"]


def pages(user_token):
    """Các Page người này quản lý: [{id, name, access_token|None}]."""
    out, after = [], None
    for _ in range(10):  # tối đa 10 trang × 100 Page
        params = {"fields": "id,name,access_token", "limit": 100, "access_token": user_token}
        if after:
            params["after"] = after
        body = _get("/me/accounts", extended_errors=False, **params)
        out += [{"id": p["id"], "name": p.get("name") or "", "access_token": p.get("access_token")}
                for p in body.get("data", []) if p.get("id")]
        after = (body.get("paging") or {}).get("cursors", {}).get("after") if (body.get("paging") or {}).get("next") else None
        if not after:
            break
    return out
