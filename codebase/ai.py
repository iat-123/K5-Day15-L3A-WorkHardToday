"""Nối model — chỗ DUY NHẤT trong bản chạy thử gọi model AI. NHÓM VIẾT phần gọi model thật.

Hợp đồng (giữ nguyên để khung đo được token):
    call_model(system: str, user: str) -> dict với 4 khoá
        "text":       str   chữ model trả về
        "model":      str   tên model đã gọi (để tra giá ở bảng giá model)
        "tokens_in":  int   số token vào, lấy từ trường usage trong phản hồi API — KHÔNG ước lượng
        "tokens_out": int   số token ra, gồm cả token suy luận / suy nghĩ nếu API tính riêng
    @model_call (từ tracing.py) tự ghi mỗi lần gọi vào trace; agent.py gọi call_model bao nhiêu lần
    cũng được, khung tự cộng token.
    Lỗi gọi model (hết lượt, sai key, mất mạng): cứ để exception bay ra — khung ghi lỗi vào cột error.

Chế độ giả (mặc định khi .env chưa có MODEL_PROVIDER, hoặc MODEL_PROVIDER=fake):
    trả một câu giả cố định, model "fake", token 0 — để luồng chạy hết từ trước CP2 (guide bước 3.2).
    Lượt `run.py eval` / `run.py simulate` chạy bằng model giả KHÔNG được tính.

Nối model thật: điền .env (chép từ .env.example), rồi viết nhánh gọi API ở dưới theo docs/connect-model.md
(có ví dụ OpenAI, Claude, model chạy trên máy, và cách nối nhà cung cấp khác). Không dán API key vào file này.
"""
import json
import os

from tracing import model_call

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def load_env(path=os.path.join(ROOT, ".env")):
    """Đọc file .env (KEY=VALUE mỗi dòng) vào biến môi trường, không ghi đè biến đã có. Khung — không cần sửa."""
    if not os.path.exists(path):
        return
    with open(path, encoding="utf-8-sig") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


load_env()
MODEL_PROVIDER = (os.environ.get("MODEL_PROVIDER") or "fake").strip().lower()
MODEL_NAME = (os.environ.get("MODEL_NAME") or "").strip()
API_KEY = (os.environ.get("API_KEY") or "").strip()


_client = None


@model_call
def call_model(system: str, user: str, schema: dict = None) -> dict:
    """schema (tuỳ chọn): JSON schema — model bắt buộc trả JSON đúng schema (OpenAI structured outputs)."""
    if MODEL_PROVIDER == "fake":
        if schema:  # chế độ giả vẫn trả JSON hợp lệ để luồng chạy hết
            props = schema.get("properties") if isinstance(schema, dict) else None
            if isinstance(props, dict) and "reply" in props:
                text = json.dumps({"decision": "reply", "flag_reasons": [],
                                   "reply": "[trả lời giả — chưa nối model]", "facts_used": []}, ensure_ascii=False)
            else:
                text = json.dumps({"decision": "write", "flag_reasons": [], "hook": "[bài giả — chưa nối model]",
                                   "body": "", "cta": "", "hashtags": [], "facts_used": []}, ensure_ascii=False)
        else:
            text = "[câu trả lời giả — chưa nối model] " + (user.strip().splitlines() or [""])[-1][:60]
        return {"text": text, "model": "fake", "tokens_in": 0, "tokens_out": 0}

    if MODEL_PROVIDER == "openai":
        global _client
        if _client is None:
            from openai import OpenAI
            _client = OpenAI(api_key=API_KEY, timeout=90)
        kw = {}
        if schema:
            kw["response_format"] = {"type": "json_schema", "json_schema": {"name": "result", "strict": True, "schema": schema}}
        r = _client.chat.completions.create(
            model=MODEL_NAME, messages=[{"role": "system", "content": system}, {"role": "user", "content": user}],
            max_completion_tokens=4000, **kw)
        # model = tên đã cấu hình (không lấy bản có ngày) để khớp bảng giá trong cost/personas.yaml
        return {"text": r.choices[0].message.content or "", "model": MODEL_NAME,
                "tokens_in": r.usage.prompt_tokens, "tokens_out": r.usage.completion_tokens}

    raise NotImplementedError("MODEL_PROVIDER=%s chưa hỗ trợ — dùng openai hoặc fake" % MODEL_PROVIDER)
