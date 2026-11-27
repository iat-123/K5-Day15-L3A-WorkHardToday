"""Luật xác định (không gọi AI): đọc file, đọc giá/size/màu, kiểm dòng, kiểm tồn, soát bài.

Mọi thứ sai thì mất tiền (giá, tồn kho, tuyên bố) nằm ở đây để luôn chạy và chấm được bằng code.
"""
import csv
import io
import json
import math
import os
import re
import unicodedata

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")

TE_FLOOR = 13_500                    # luật shop: giá tệ × 13,5 = giá sàn (sheet quy định chọn hàng)
PRICE_MIN, PRICE_MAX = 50_000, 20_000_000
PRICE_TOL = 0.02                     # sai số làm tròn cho phép khi bài nhắc giá
LOW_STOCK = 2

FIELDS = ["ma_sp", "ten_sp", "loai", "gia_ban", "gia_te", "size", "mau", "chat_lieu", "mo_ta", "anh", "page", "prompt"]
FACT_FIELDS = ["ma_sp", "ten_sp", "loai", "gia_ban", "size", "mau", "chat_lieu", "mo_ta"]
LABEL = {"ma_sp": "Mã", "ten_sp": "Tên", "loai": "Loại", "gia_ban": "Giá bán", "gia_te": "Giá tệ", "size": "Size",
         "mau": "Màu", "chat_lieu": "Chất liệu", "mo_ta": "Mô tả", "anh": "Ảnh", "page": "Page", "prompt": "Prompt", "ton_kho": "Tồn kho"}


def fold(s):
    """bỏ dấu + chữ thường — chỉ dùng để so tên cột (không dùng cho nội dung: 'len' ≠ 'lên')."""
    s = unicodedata.normalize("NFD", str(s or "")).replace("đ", "d").replace("Đ", "D")
    return re.sub(r"\s+", " ", "".join(c for c in s if unicodedata.category(c) != "Mn")).strip().lower()


ALIASES = {
    "ma_sp": ["ma_sp", "ma", "ma sp", "ma san pham", "ma hang", "code", "sku"],
    "ten_sp": ["ten_sp", "ten", "ten sp", "ten san pham"],
    "loai": ["loai", "chung loai", "loai san pham"],
    "gia_ban": ["gia_ban", "gia ban", "gia", "gia ban (theo anh)", "nguyen gia", "nguyen gia (bat buoc)", "gia tmdt lam tron"],
    "gia_te": ["gia_te", "gia te", "gia nhap (te)", "gia te (cny)"],
    "size": ["size", "size so", "kich co", "sizes"],
    "mau": ["mau", "mau sac", "colors"],
    "chat_lieu": ["chat_lieu", "chat lieu", "chat lieu tu van khach", "chat lieu thuc te"],
    "mo_ta": ["mo_ta", "mo ta", "mo ta san pham"],
    "anh": ["anh", "hinh anh", "link anh", "link anh info", "anh san pham", "image", "images", "anh drive json", "thu muc anh"],
    "page": ["page", "fanpage", "trang"],
    "prompt": ["prompt", "yeu cau", "yeu cau viet", "yeu cau bai viet"],
}
_ALIAS = {a: k for k, v in ALIASES.items() for a in v}


def _cell(v):
    if v is None:
        return ""
    if isinstance(v, float) and v.is_integer():
        return str(int(v))
    return str(v).strip()


def normalize_row(raw):
    """dict tên cột bất kỳ → dict đúng FIELDS. 'Màu 1..5' gộp vào mau."""
    row = {k: "" for k in FIELDS}
    colors = []
    for k, v in raw.items():
        key, val = fold(k), _cell(v)
        if re.fullmatch(r"mau ?\d", key):
            if val:
                colors.append(val)
            continue
        f = _ALIAS.get(key)
        if f and not row[f]:
            row[f] = val
    if colors and not row["mau"]:
        row["mau"] = ", ".join(colors)
    return row


def read_table(data, filename):
    """bytes của .csv/.xlsx → list dòng đã chuẩn hoá (bỏ dòng trống). Lỗi định dạng → ValueError."""
    name = filename.lower()
    if name.endswith((".xlsx", ".xlsm")):
        import openpyxl
        try:
            vals = openpyxl.load_workbook(io.BytesIO(data), read_only=True, data_only=True).worksheets[0]
            forms = openpyxl.load_workbook(io.BytesIO(data), read_only=True, data_only=False).worksheets[0]
        except Exception as e:
            raise ValueError("không mở được file Excel: %s" % e)
        rows = []
        for rv, rf in zip(vals.iter_rows(values_only=True), forms.iter_rows(values_only=True)):
            # ô =IMAGE("url") không có giá trị đã tính → lấy chữ công thức để đọc link ảnh
            rows.append([v if v is not None else (f if isinstance(f, str) and f.upper().startswith("=IMAGE(") else None)
                         for v, f in zip(rv, rf)])
    elif name.endswith(".csv"):
        for enc in ("utf-8-sig", "utf-16", "cp1258"):
            try:
                text = data.decode(enc)
                break
            except UnicodeDecodeError:
                continue
        else:
            raise ValueError("không đọc được mã hoá file CSV")
        rows = list(csv.reader(io.StringIO(text)))
    else:
        raise ValueError("chỉ nhận .xlsx hoặc .csv")
    rows = [r for r in rows if r and any(_cell(c) for c in r)]
    if not rows:
        raise ValueError("file trống")
    head = [_cell(c) for c in rows[0]]
    if not any(_ALIAS.get(fold(h)) or re.fullmatch(r"mau ?\d", fold(h)) for h in head):
        raise ValueError("không thấy cột nào quen (cần ít nhất: tên/mã, giá bán, size…)")
    return [normalize_row(dict(zip(head, r))) for r in rows[1:]]


# ---------------- đọc giá / size / màu ----------------
def parse_price(s):
    """'1.560.000đ' '560k' '1tr2' '1,25 triệu' '1560000.0' → int VNĐ; không đọc được → None."""
    t = str(s or "").strip().lower().replace(" ", "")
    t = re.sub(r"(đ|₫|vnđ|vnd|dong|đồng)$", "", t)
    if not t:
        return None
    m = re.fullmatch(r"(\d+)tr(\d{1,3})?", t)
    if m:
        return int(m.group(1)) * 1_000_000 + (int(m.group(2).ljust(3, "0")) * 1000 if m.group(2) else 0)
    m = re.fullmatch(r"(\d+(?:[.,]\d+)?)(tr|triệu|trieu)", t)
    if m:
        return int(round(float(m.group(1).replace(",", ".")) * 1_000_000))
    m = re.fullmatch(r"(\d{1,3}(?:[.,]\d{3})+|\d+(?:[.,]\d+)?)(k|nghìn|ngàn|nghin|ngan)", t)
    if m:
        n = m.group(1)
        n = re.sub(r"[.,]", "", n) if re.fullmatch(r"\d{1,3}(?:[.,]\d{3})+", n) else n.replace(",", ".")
        return int(round(float(n) * 1000))
    if re.fullmatch(r"\d{1,3}(?:[.,]\d{3})+", t):
        return int(re.sub(r"[.,]", "", t))
    if re.fullmatch(r"\d+(?:\.0+)?", t):
        return int(float(t))
    return None


_DRIVE_ID = re.compile(r"drive\.google\.com/(?:file/d/|open\?id=|uc\?(?:export=\w+&)?id=|thumbnail\?id=)([\w-]{20,})")
MAX_IMAGES = 10


def parse_images(s):
    """Ô ảnh → danh sách link ảnh. Nhận: link thường, link Google Drive (đổi sang link ảnh trực tiếp),
    =IMAGE("url") của Google Sheets, JSON [{"id": …}] (cột 'Ảnh Drive JSON'), đường dẫn /uploads/… của app."""
    t = str(s or "").strip()
    if not t:
        return []
    ids = []
    if t.startswith("["):
        try:
            ids = ["https://lh3.googleusercontent.com/d/%s" % x["id"] for x in json.loads(t) if isinstance(x, dict) and x.get("id")]
        except ValueError:
            ids = []
    if ids:
        return ids[:MAX_IMAGES]
    t = re.sub(r'(?i)=IMAGE\(\s*"([^"]+)"[^)]*\)', r"\1", t)
    out = []
    for tok in re.split(r"[\s,;]+", t):
        tok = tok.strip().strip('"').strip("'")
        m = _DRIVE_ID.search(tok)
        if m:
            tok = "https://lh3.googleusercontent.com/d/%s" % m.group(1)
        if re.match(r"https?://\S+$", tok) or re.match(r"/uploads/[\w.-]+$", tok):
            out.append(tok)
    return list(dict.fromkeys(out))[:MAX_IMAGES]


def fmt_vnd(n):
    return "{:,}".format(int(n)).replace(",", ".") + "đ"


SIZE_ORDER = ["XS", "S", "M", "L", "XL", "2XL", "3XL", "4XL", "5XL"]
_SIZE_ALIAS = {"XXL": "2XL", "XXXL": "3XL"}


def parse_sizes(s):
    """'S-XL' → [S,M,L,XL] · '35-40' → ['35'..'40'] · 'F'/'Freesize' → ['Freesize'] · 'S, M' → [S,M]. Lỗi → []."""
    t = str(s or "").strip().upper().replace("–", "-")
    if not t:
        return []
    if t in ("F", "FREE", "FREESIZE", "FREE SIZE", "FS"):
        return ["Freesize"]
    out = []
    for part in re.split(r"[,/;]|\s+", t):
        part = part.strip()
        if not part:
            continue
        m = re.fullmatch(r"([0-9A-Z]+)-([0-9A-Z]+)", part)
        if m:
            a, b = (_SIZE_ALIAS.get(x, x) for x in m.groups())
            if a in SIZE_ORDER and b in SIZE_ORDER and SIZE_ORDER.index(a) <= SIZE_ORDER.index(b):
                out += SIZE_ORDER[SIZE_ORDER.index(a):SIZE_ORDER.index(b) + 1]
            elif a.isdigit() and b.isdigit() and int(a) <= int(b) and int(b) - int(a) <= 15:
                out += [str(i) for i in range(int(a), int(b) + 1)]
            else:
                return []
            continue
        part = _SIZE_ALIAS.get(part, part)
        if part in SIZE_ORDER or (part.isdigit() and 20 <= int(part) <= 50):
            out.append(part)
        elif part in ("F", "FREESIZE"):
            out.append("Freesize")
        else:
            return []
    return list(dict.fromkeys(out))


def parse_colors(s):
    return [c.strip() for c in re.split(r"[,;/]|\s+và\s+", str(s or "")) if c.strip()]


# ---------------- từ điển nội dung ----------------
MATERIALS = {   # nhóm → cách gọi (khớp nguyên từ, KHÔNG bỏ dấu)
    "cotton": ["cotton", "coton"], "lụa": ["lụa", "silk"], "satin": ["satin"], "voan": ["voan"],
    "chiffon": ["chiffon"], "linen": ["linen", "lanh"], "đũi": ["đũi"], "ren": ["ren", "lace"],
    "kaki": ["kaki", "khaki"], "denim": ["denim", "jean", "jeans", "bò"], "len": ["len", "wool"],
    "nhung": ["nhung", "velvet"], "polyester": ["polyester", "poly"], "taffeta": ["taffeta", "tafta"],
    "tuyết mưa": ["tuyết mưa"], "organza": ["organza"], "thun": ["thun"], "kate": ["kate"],
    "tweed": ["tweed"], "nỉ": ["nỉ"], "lưới": ["lưới"], "kim sa": ["kim sa"],
}
COLORS = ["xanh dương", "xanh lá", "xanh navy", "xanh than", "xanh rêu", "xanh ngọc", "xanh mint", "xanh",
          "đen", "trắng", "đỏ", "hồng", "vàng", "tím", "xám", "nâu", "be", "kem", "bạc", "nude", "cam", "ghi", "mơ",
          "họa tiết", "hoạ tiết", "kẻ", "caro"]
SIZE_TOKEN = re.compile(r"(?<![\w])(XS|S|M|L|XL|XXL|2XL|3XL|4XL|5XL|Freesize|Free size|freesize)(?![\w])")
MONEY = re.compile(r"(?<![\w.,])(\d{1,3}(?:[.,]\d{3})+|\d+(?:[.,]\d+)?)\s*(k|đ|₫|vnđ|vnd|tr|triệu|nghìn|ngàn)?(?![\w])", re.I)
INJECTION = re.compile(r"(bỏ qua|phớt lờ|quên|ghi đè)\s+(hết\s+|mọi\s+|tất cả\s+|các\s+)*(hướng dẫn|chỉ dẫn|luật|quy tắc|lệnh)"
                       r"|ignore\s+(all|any|previous|the above|prior)|system prompt|developer message|you are now", re.I)
NEGATION = ("không", "đừng", "tránh", "chớ", "chẳng", "ko", "k", "cấm")


def _has(term, text):
    return re.search(r"(?<!\w)" + re.escape(term) + r"(?!\w)", text, re.I) is not None


def materials_in(text):
    t = str(text or "").lower()
    return {g for g, names in MATERIALS.items() if any(_has(n, t) for n in names)}


def colors_in(text, explicit_only=True):
    """màu nhắc trong câu. explicit_only: chỉ cụm đứng sau chữ 'màu' (tránh nhầm 'hoa hồng', 'cam kết', 'giấc mơ')."""
    t = str(text or "").lower()
    if explicit_only:
        spans = [m.group(1) for m in re.finditer(r"màu\s+([^\s,.;!?]+(?:\s+[^\s,.;!?]+)?)", t)]
        t = " | ".join(spans)
    found, masked = [], t
    for c in sorted(COLORS, key=len, reverse=True):
        if _has(c, masked):
            found.append(c)
            masked = re.sub(r"(?<!\w)" + re.escape(c) + r"(?!\w)", " ", masked)
    return found


def _color_ok(term, allowed):
    return any(term in a.lower() for a in allowed)


def _phrase_hits(text, phrases, negation_aware=False):
    t = str(text or "").lower()
    hits = []
    for p in phrases:
        for m in re.finditer(r"(?<!\w)" + re.escape(p.lower()) + r"(?!\w)", t):
            if negation_aware:
                before = re.findall(r"\w+", t[:m.start()])[-3:]
                if any(w in NEGATION for w in before):
                    continue
            hits.append(p)
            break
    return hits


def load_config():
    with open(os.path.join(DATA, "pages.json"), encoding="utf-8") as f:
        cfg = json.load(f)
    return cfg["global"], {p["id"]: p for p in cfg["pages"]}


def load_inventory(path=os.path.join(DATA, "inventory.csv")):
    inv = {}
    if not os.path.exists(path):
        return inv
    with open(path, encoding="utf-8-sig") as f:
        for r in csv.DictReader(f):
            try:
                ton = int(float(r.get("ton") or 0))
            except ValueError:
                ton = 0
            inv.setdefault(r["ma_sp"].strip(), []).append(
                {"mau": r.get("mau", "").strip(), "size": r.get("size", "").strip(), "ton": ton,
                 "trang_thai": r.get("trang_thai", "").strip()})
    return inv


# ---------------- 1. kiểm dòng ----------------
def check_product(row, page, glob):
    hard, warn = [], []
    if not row.get("ten_sp") and not row.get("ma_sp"):
        hard.append(("ten_sp", "thiếu cả tên và mã sản phẩm"))
    price = parse_price(row.get("gia_ban"))
    if not row.get("gia_ban"):
        hard.append(("gia_ban", "thiếu giá bán"))
    elif price is None:
        hard.append(("gia_ban", "không đọc được giá '%s'" % row["gia_ban"]))
    elif not PRICE_MIN <= price <= PRICE_MAX:
        hard.append(("gia_ban", "giá %s nằm ngoài khoảng hợp lệ %s–%s" % (fmt_vnd(price), fmt_vnd(PRICE_MIN), fmt_vnd(PRICE_MAX))))
    else:
        try:
            te = float(str(row.get("gia_te") or "").replace(",", "."))
        except ValueError:
            te = None
        if te:
            floor = int(math.ceil(te * TE_FLOOR))
            if price < floor:
                hard.append(("gia_ban", "%s thấp hơn giá sàn %s (= %s tệ × 13.500)" % (fmt_vnd(price), fmt_vnd(floor), te)))
        if page and price < page.get("floor_vnd", 0):
            hard.append(("gia_ban", "%s dưới giá sàn %s của page %s" % (fmt_vnd(price), fmt_vnd(page["floor_vnd"]), page["name"])))
    sizes = parse_sizes(row.get("size"))
    if not row.get("size"):
        hard.append(("size", "thiếu size"))
    elif not sizes:
        hard.append(("size", "không đọc được size '%s'" % row["size"]))
    if not row.get("mau"):
        warn.append(("mau", "thiếu màu — bài không được nhắc màu"))
    if not row.get("chat_lieu"):
        warn.append(("chat_lieu", "thiếu chất liệu — bài không được nhắc chất liệu"))
    if not parse_images(row.get("anh")):
        warn.append(("anh", "chưa có ảnh sản phẩm — thêm ảnh trước khi duyệt" + (" (ô ảnh không có link hợp lệ)" if row.get("anh") else "")))
    # mô tả mâu thuẫn với trường
    desc = row.get("mo_ta", "")
    if desc:
        mats_desc, mats_field = materials_in(desc), materials_in(row.get("chat_lieu"))
        if row.get("chat_lieu") and mats_desc - mats_field:
            hard.append(("mo_ta", "mô tả nói chất %s, trường chất liệu là '%s'" % (", ".join(sorted(mats_desc - mats_field)), row["chat_lieu"])))
        if price:
            for m in MONEY.finditer(desc):
                if m.group(2):
                    v = parse_price(m.group(1) + m.group(2))
                    if v and abs(v - price) > price * PRICE_TOL:
                        hard.append(("mo_ta", "mô tả ghi giá %s, trường giá bán là %s" % (fmt_vnd(v), fmt_vnd(price))))
                        break
        bad = [s for s in SIZE_TOKEN.findall(desc) if sizes and parse_sizes(s) and not set(parse_sizes(s)) <= set(sizes)]
        if bad:
            hard.append(("mo_ta", "mô tả nhắc size %s, trường size là '%s'" % (", ".join(bad), row.get("size"))))
    # chèn lệnh / prompt đòi điều shop không được nói
    for f in ("mo_ta", "prompt", "ten_sp"):
        if INJECTION.search(row.get(f, "")):
            hard.append((f, "có câu lệnh chèn vào dữ liệu — không làm theo"))
    for p in _phrase_hits(row.get("prompt"), glob["banned"] + glob["brands"], negation_aware=True):
        hard.append(("prompt", "đòi viết '%s' — shop không được tự nhận / gắn thương hiệu khác" % p))
    return {"hard": hard, "warn": warn}


# ---------------- 2. kiểm tồn ----------------
def check_stock(row, inventory):
    code = (row.get("ma_sp") or "").strip()
    out = {"hard": [], "warn": [], "colors": parse_colors(row.get("mau")), "sizes": parse_sizes(row.get("size")),
           "dropped_colors": [], "dropped_sizes": [], "low": False, "variants": []}
    if not code or code not in inventory:
        out["hard"].append(("ton_kho", "mã '%s' không có trong file tồn — không kiểm được còn hàng" % code))
        return out
    want_c = {c.lower() for c in out["colors"]}
    want_s = set(out["sizes"])
    vs = [v for v in inventory[code] if (not want_c or v["mau"].lower() in want_c) and (not want_s or v["size"] in want_s)]
    out["variants"] = vs
    if not vs:
        out["hard"].append(("ton_kho", "file tồn không có biến thể nào khớp màu/size của dòng"))
        return out
    total = sum(v["ton"] for v in vs)
    if total == 0:
        status = max((v["trang_thai"] for v in vs), key=lambda s: sum(1 for v in vs if v["trang_thai"] == s))
        if "thanh toán hết" in status.lower():
            out["hard"].append(("ton_kho", "hết tồn; chỉ nhận đặt may khi khách thanh toán hết — người quyết có đăng không"))
        else:
            out["hard"].append(("ton_kho", "hết hàng (trạng thái: %s)" % (status or "tồn = 0")))
        return out
    instock = [v for v in vs if v["ton"] > 0]
    keep_c = [c for c in out["colors"] if any(v["mau"].lower() == c.lower() for v in instock)] or out["colors"]
    keep_s = [s for s in out["sizes"] if any(v["size"] == s for v in instock)] or out["sizes"]
    out["dropped_colors"] = [c for c in out["colors"] if c not in keep_c]
    out["dropped_sizes"] = [s for s in out["sizes"] if s not in keep_s]
    out["colors"], out["sizes"] = keep_c, keep_s
    if out["dropped_colors"] or out["dropped_sizes"]:
        out["warn"].append(("ton_kho", "chỉ đăng phần còn hàng; bỏ %s" % ", ".join(out["dropped_colors"] + out["dropped_sizes"])))
    if max(v["ton"] for v in instock) <= LOW_STOCK:
        out["low"] = True
        out["warn"].append(("ton_kho", "sắp hết (mỗi biến thể còn ≤%d) — không viết 'sẵn nhiều', 'đủ size'" % LOW_STOCK))
    return out


# ---------------- 3. soát bài ----------------
def allowed_facts(row, stock, page, glob):
    """những gì bài được phép nói — dùng cho verify_post và để đưa vào prompt."""
    price = parse_price(row.get("gia_ban"))
    fact_text = " ".join(str(row.get(f) or "") for f in FACT_FIELDS).lower()
    return {"prices": [price] if price else [], "colors": stock["colors"], "sizes": stock["sizes"],
            "dropped_colors": stock["dropped_colors"], "dropped_sizes": stock["dropped_sizes"],
            "materials": materials_in(row.get("chat_lieu")) | (materials_in(row.get("mo_ta")) if not row.get("chat_lieu") else set()),
            "has_material": bool(row.get("chat_lieu")) or bool(materials_in(row.get("mo_ta"))),
            "has_color": bool(row.get("mau")), "low": stock["low"], "fact_text": fact_text,
            "max_emoji": (page or {}).get("max_emoji", 3), "banned": glob["banned"] + glob["brands"],
            "conditional": glob["conditional"]}


EMOJI = re.compile("[\U0001F300-\U0001FAFF☀-➿]")
COMMENT_MAX_CHARS = 2000

_DATE_RE = re.compile(
    r"(?<![A-Za-z0-9])(?:"
    r"(?:0?[1-9]|[12]\d|3[01])([./\-])(?:0?[1-9]|1[0-2])\1(?:19|20)\d{2}"
    r"|(?:19|20)\d{2}([./\-])(?:0?[1-9]|1[0-2])\2(?:0?[1-9]|[12]\d|3[01])"
    r")(?![A-Za-z0-9])"
)
_EMAIL_RE = re.compile(
    r"(?<![A-Za-z0-9._%+-])"
    r"[A-Za-z0-9_%+-][A-Za-z0-9._%+-]*"
    r"@(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\.)+"
    r"(?:"
    r"(?:com|net|org|edu|gov|vn|io|co|me|info|biz|xyz|shop|store|online|site|app|dev|ai|uk|us|jp|kr|sg|au|ca|de|fr)(?![A-Za-z0-9-])"
    r"|(?:com|net|org|edu|gov|vn)(?=[A-Za-z]*[^\x00-\x7f])"
    r"|[A-Za-z]{2,10}(?![A-Za-z0-9-])"
    r"|(?:com|net|org|edu|gov|vn)"
    r")",
    re.I,
)
_PHONE_SEP = r"(?:[ \t\u00a0]*[.\-\u2013\u2014][ \t\u00a0]*|/|[ \t\u00a0]+)"
_PHONE_CANDIDATE_RE = re.compile(
    r"(?<![A-Za-z0-9])(?:"
    r"(?:(?:\(\+84\)|\+84)(?:[ \t\u00a0]*\(0\)[ \t\u00a0]*|(?:[ \t\u00a0]*[.\-\u2013\u2014][ \t\u00a0]*|[ \t\u00a0]+)?0?(?:[ \t\u00a0]*[.\-\u2013\u2014][ \t\u00a0]*|[ \t\u00a0]+)?)"
    r"|84(?:[ \t\u00a0]*\(0\)[ \t\u00a0]*|(?:[ \t\u00a0]*[.\-\u2013\u2014][ \t\u00a0]*|[ \t\u00a0]+)?))"
    r"[235789]\d*(?:" + _PHONE_SEP + r"\d{2,4}){0,4}"
    r"|\(0[235789]\d{1,2}\)[ \t\u00a0]*(?:[.\-\u2013\u2014][ \t\u00a0]*)?\d+(?:" + _PHONE_SEP + r"\d{2,4}){0,3}"
    r"|0[235789]\d*(?:" + _PHONE_SEP + r"\d{2,4}){0,4}"
    r")(?![A-Za-z0-9đ₫])"
)
_SCHEME_URL_RE = re.compile(r"(?i)(?<![A-Za-z0-9])https?://[^\s<>\"'()\[\]{}]+")
_WWW_URL_RE = re.compile(r"(?i)(?<![A-Za-z0-9@._/-])www\.[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:/[^\s<>\"'()\[\]{}]*)?")
_BARE_URL_PATH_RE = re.compile(
    r"(?i)(?<![A-Za-z0-9@._/-])[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*"
    r"\.(?:com|net|org|vn|ly|gl|co|gy|gd|at|cc|id|so|to|ee|me|xyz|top|vip|click|info|biz|shop|store|online|site|club|icu|link|pro|live|bet|win|io|app|tk|ml|ga|cf|gq|gg)"
    r"/[^\s<>\"'()\[\]{}]+"
)
_BARE_URL_DOMAIN_RE = re.compile(
    r"(?i)(?<![A-Za-z0-9@._/-])[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*"
    r"\.(?:com\.vn|net\.vn|edu\.vn|gov\.vn|com|net|org|vn|xyz|info|biz|vip|icu|click|site|online)"
    r"(?![A-Za-z0-9./-])"
)

_OOS_NEG_PHRASE = re.compile(
    r"(?<!\w)(?:đã\s+hết|tạm\s+hết|hiện\s+hết|hết\s+hàng|hết\s+tồn|hết\s+mất|hết\s+rồi|hết\s+size|hết\s+màu|hết"
    r"|cháy\s+hàng|không\s+còn|ko\s+còn|k\s+còn|ngừng\s+bán)(?!\w)",
    re.I,
)
_OOS_ANTI_NEG = re.compile(r"(?<!\w)(?:chưa\s+hết|không\s+hết|ko\s+hết|k\s+hết|hết\s+đâu)(?!\w)", re.I)
_OOS_AFFIRM = re.compile(
    r"(?<!\w)(?:vẫn\s+còn|đang\s+còn|còn\s+hàng|còn\s+sẵn|sẵn\s+hàng|có\s+sẵn|còn\s+đủ|đủ\s+size|full\s+size)(?!\w)",
    re.I,
)
_CLAUSE_BOUNDARY = re.compile(
    r"[.!?;,\n]|(?<!\w)(?:nhưng|tuy\s+nhiên|chỉ\s+còn|shop\s+còn|hiện\s+còn|bên\s+mình\s+còn|vẫn\s+còn|đang\s+còn|còn\s+lại)(?!\w)",
    re.I,
)


def _mask_spans(text, spans):
    if not spans:
        return text
    chars = list(text)
    for a, b in spans:
        for i in range(a, b):
            chars[i] = " "
    return "".join(chars)


def _merge_spans(spans):
    if not spans:
        return []
    ordered = sorted(spans, key=lambda r: (r[0], -r[1]))
    merged = [ordered[0]]
    for a, b in ordered[1:]:
        pa, pb = merged[-1]
        if a <= pb:
            merged[-1] = (pa, max(pb, b))
        else:
            merged.append((a, b))
    return merged


def _valid_vn_phone(raw):
    digits = re.sub(r"\D", "", raw)
    stripped = raw.lstrip()
    if stripped.startswith(("(+84", "+84", "84")):
        sub = digits[2:]
        if sub.startswith("0"):
            sub = sub[1:]
    elif digits.startswith("0"):
        sub = digits[1:]
    else:
        return False
    return 8 <= len(sub) <= 10 and bool(sub) and sub[0] in "235789"


def find_emails(text):
    """Tìm vị trí (start, end) mọi địa chỉ email trong văn bản (không bị phá bởi chữ tiếng Việt đứng liền)."""
    s = str(text or "")
    return [(m.start(), m.end()) for m in _EMAIL_RE.finditer(s)]


def find_phones(text):
    """Tìm vị trí (start, end) số điện thoại Việt Nam, bỏ qua ngày tháng, số lượng và mã sản phẩm."""
    s = str(text or "")
    email_spans = find_emails(s)
    date_spans = [(m.start(), m.end()) for m in _DATE_RE.finditer(s)]
    scan = _mask_spans(s, _merge_spans(email_spans + date_spans))
    return [(m.start(), m.end()) for m in _PHONE_CANDIDATE_RE.finditer(scan) if _valid_vn_phone(m.group(0))]


def find_urls(text):
    """Tìm vị trí (start, end) mọi đường link (có http/www hoặc tên miền trần/rút gọn), không tính email."""
    s = str(text or "")
    scan = _mask_spans(s, _merge_spans(find_emails(s) + [(m.start(), m.end()) for m in _DATE_RE.finditer(s)]))
    spans = []
    for rx in (_SCHEME_URL_RE, _WWW_URL_RE, _BARE_URL_PATH_RE, _BARE_URL_DOMAIN_RE):
        for m in rx.finditer(scan):
            spans.append((m.start(), m.end()))
    return _merge_spans(spans)


def find_pii_spans(text):
    """Danh sách khoảng (start, end) đã gộp của mọi SĐT Việt Nam và email cần ẩn."""
    s = str(text or "")
    return _merge_spans(find_emails(s) + find_phones(s))


def scrub_pii(text):
    """Thay số điện thoại Việt Nam và email bằng '[đã ẩn]' (dùng chung bộ nhận diện đã gia cố)."""
    s = str(text or "")
    spans = find_pii_spans(s)
    if not spans:
        return s
    parts, cursor = [], 0
    for a, b in spans:
        parts.append(s[cursor:a])
        parts.append("[đã ẩn]")
        cursor = b
    parts.append(s[cursor:])
    return "".join(parts)


def _is_oos_negated(text, start, end):
    """True nếu vị trí (start, end) nhắc size/màu hết hàng kèm phủ định rõ ràng ('đã hết', 'hết hàng', 'không còn'…)."""
    sent_start = 0
    for m in re.finditer(r"[.!?\n;]", text[:start]):
        sent_start = m.end()
    m_end = re.search(r"[.!?\n;]", text[end:])
    sent_end = end + m_end.start() if m_end else len(text)
    sent = text[sent_start:sent_end]
    rel_start, rel_end = start - sent_start, end - sent_start

    before = sent[:rel_start]
    after = sent[rel_end:]

    b_cut = 0
    for m in _CLAUSE_BOUNDARY.finditer(before):
        b_cut = m.end()
    local_before = before[b_cut:][-60:]

    m_a = _CLAUSE_BOUNDARY.search(after)
    local_after = (after[:m_a.start()] if m_a else after)[:60]
    local_clause = local_before + sent[rel_start:rel_end] + local_after

    if _OOS_ANTI_NEG.search(local_clause) or _OOS_AFFIRM.search(local_clause):
        return False
    if _OOS_NEG_PHRASE.search(local_before) or _OOS_NEG_PHRASE.search(local_after):
        return True

    # Liệt kê nhiều mục cùng hết hàng: 'size M, màu trắng đều đã hết hàng'
    m_contrast = re.search(
        r"(?<!\w)(?:nhưng|tuy\s+nhiên|chỉ\s+còn|shop\s+còn|hiện\s+còn|vẫn\s+còn|đang\s+còn)(?!\w)",
        after,
        re.I,
    )
    tail = (after[:m_contrast.start()] if m_contrast else after)[:65]
    if re.search(r"(?<!\w)đều(?!\w)", tail, re.I) and _OOS_NEG_PHRASE.search(tail):
        if not _OOS_ANTI_NEG.search(tail) and not _OOS_AFFIRM.search(tail):
            return True
    return False


def verify_post(text, allowed, *, is_comment=False):
    """→ {"block": [...], "warn": [...]} — block thì phải viết lại / đánh dấu.
    is_comment=True: cho phép nhắc size/màu đã hết khi có phủ định rõ, bỏ cảnh báo 150–1500 ký tự, chặn >2000 ký tự."""
    block, warn = [], []
    t = str(text or "")
    low = t.lower()
    # giá: mọi số tiền phải khớp giá bán (±2%); số kèm cm/kg/%… không phải tiền
    for m in MONEY.finditer(t):
        num, unit = m.group(1), m.group(2)
        tail = t[m.end():m.end() + 4].lower()
        if not unit and not re.fullmatch(r"\d{1,3}(?:[.,]\d{3})+", num):
            continue
        if re.match(r"\s*(cm|kg|m\b|%|tuổi|lớp|màu|size|ngày)", tail):
            continue
        v = parse_price(num + (unit or ""))
        if v and not any(abs(v - p) <= p * PRICE_TOL for p in allowed["prices"]):
            block.append("giá %s không khớp giá bán %s" % (m.group(0).strip(), ", ".join(fmt_vnd(p) for p in allowed["prices"]) or "(không có)"))
    pct = re.findall(r"\d+\s*%", t)
    if pct and not any(p.replace(" ", "") in allowed["fact_text"].replace(" ", "") for p in pct):
        block.append("có con số phần trăm %s không có trong file" % ", ".join(pct))
    # size
    dropped_sizes = set(allowed["dropped_sizes"])
    for m in SIZE_TOKEN.finditer(t):
        s = m.group(1)
        got = parse_sizes(s)
        if not got:
            continue
        got_set = set(got)
        if not got_set <= set(allowed["sizes"]):
            if is_comment and got_set <= dropped_sizes and _is_oos_negated(t, m.start(), m.end()):
                continue
            block.append("nhắc size %s — chỉ được nói %s" % (s, ", ".join(allowed["sizes"]) or "(không có)"))
    for s in allowed["dropped_sizes"]:
        for m in SIZE_TOKEN.finditer(t):
            if s in parse_sizes(m.group(1)):
                if is_comment and _is_oos_negated(t, m.start(), m.end()):
                    continue
                block.append("nhắc size %s đã hết hàng" % s)
                break
    # màu
    for m in re.finditer(r"màu\s+([^\s,.;!?]+(?:\s+[^\s,.;!?]+)?)", low):
        for c in colors_in(m.group(1), explicit_only=False):
            if not allowed["has_color"]:
                block.append("nhắc màu %s nhưng file không có màu" % c)
            elif not _color_ok(c, allowed["colors"]):
                if is_comment and _color_ok(c, allowed["dropped_colors"]) and _is_oos_negated(t, m.start(), m.end()):
                    continue
                block.append("nhắc màu %s — chỉ được nói %s" % (c, ", ".join(allowed["colors"])))
    for c in allowed["dropped_colors"]:
        for m in re.finditer(r"(?<!\w)" + re.escape(c.lower()) + r"(?!\w)", low):
            if is_comment and _is_oos_negated(t, m.start(), m.end()):
                continue
            block.append("nhắc màu %s đã hết hàng" % c)
            break
    # chất liệu — bỏ tên màu trước ('Xanh jean', 'Kaki' là màu, không phải lời nói về chất vải)
    masked = low
    for c in sorted(allowed["colors"] + allowed["dropped_colors"], key=len, reverse=True):
        masked = masked.replace(c.lower(), " ")
    mats = materials_in(masked)
    if mats and not allowed["has_material"]:
        block.append("nhắc chất liệu %s nhưng file không có chất liệu" % ", ".join(sorted(mats)))
    elif mats - allowed["materials"]:
        block.append("nhắc chất %s — file ghi %s" % (", ".join(sorted(mats - allowed["materials"])), ", ".join(sorted(allowed["materials"])) or "(không có)"))
    # cụm cấm, thương hiệu, cụm có điều kiện
    for p in _phrase_hits(t, allowed["banned"]):
        block.append("có cụm cấm '%s'" % p)
    for p in _phrase_hits(t, allowed["conditional"]):
        if p.lower() not in allowed["fact_text"]:
            block.append("có '%s' nhưng file không nói" % p)
    if allowed["low"]:
        for p in _phrase_hits(t, ["sẵn nhiều", "đủ size", "full size", "còn nhiều", "sẵn hàng số lượng lớn"]):
            block.append("hàng sắp hết nhưng bài viết '%s'" % p)
    if find_phones(t):
        block.append("có số điện thoại")
    if find_emails(t):
        block.append("có địa chỉ email")
    if find_urls(t):
        block.append("có đường link")
    n_emoji = len(EMOJI.findall(t))
    if n_emoji > allowed["max_emoji"]:
        warn.append("%d emoji (page cho tối đa %d)" % (n_emoji, allowed["max_emoji"]))
    if is_comment:
        if len(t.strip()) > COMMENT_MAX_CHARS:
            block.append("độ dài %d ký tự vượt quá giới hạn 2.000 ký tự" % len(t.strip()))
    elif not 150 <= len(t) <= 1500:
        warn.append("độ dài %d ký tự (nên 150–1.500)" % len(t))
    return {"block": list(dict.fromkeys(block)), "warn": warn}
