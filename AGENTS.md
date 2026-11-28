# AGENTS.md — hướng dẫn cho coding agent (Claude Code, Cursor, Codex…) làm việc trong repo này

> Ôn lại: ngày 12 · lab ngày 12. Nhóm sửa file này cho khớp bài của mình (thêm quy ước riêng, bỏ dòng không dùng).

## Repo này là gì

Repo nộp bài hackathon AI20K của nhóm: một bản chạy thử AI cho **một lát cắt** (xem `spec.md` §4), kèm bằng chứng, bộ câu thử và mô phỏng chi phí. Mọi câu trả lời phải chạy được bằng các lệnh dưới đây.

## Lệnh

```
python run.py                    # chạy bản chạy thử
python run.py check              # kiểm eval/benchmark.csv + eval/metric_spec.yaml
python run.py eval --try         # thử 3 câu đầu
python run.py eval               # chạy cả bộ → eval/run-N.csv + traces/run-N.jsonl
python run.py score eval/run-N.csv
python run.py simulate --try     # thử mô phỏng chi phí 10 phiên
python run.py simulate           # mô phỏng chi phí → cost/simulate-N.csv
```

Khung chỉ dùng thư viện chuẩn của Python. Thêm thư viện thì ghi vào `requirements.txt`.

## Cấu trúc code

| File | Ai sửa | Hợp đồng |
|---|---|---|
| `codebase/agent.py` | nhóm | `answer(text) -> {"output": str}` — luồng chính, đúng hình dạng ở `spec.md` §4 |
| `codebase/ai.py` | nhóm | `call_model(system, user) -> {"text", "model", "tokens_in", "tokens_out"}`, giữ `@model_call`. Token lấy từ `usage` của API, không ước lượng |
| `codebase/tools.py` | nhóm | mỗi công cụ một hàm có `@tool`, docstring: tên · input · output · có tác động ra ngoài không |
| `codebase/tracing.py`, `eval/run_eval.py`, `cost/simulate.py`, `run.py` | **khung — không sửa** | ghi trace, chạy bộ câu thử, mô phỏng chi phí |

## Luật — agent KHÔNG được làm

- Không commit `.env`, API key, dữ liệu cá nhân thật, nguyên file data BTC cấp.
- Không sửa `eval/run-*.csv`, `cost/simulate-*.csv`, `traces/*` đã chạy (trừ điền cột `pass`, `ghi_chu`).
- Không sửa chuẩn "đạt" (`spec.md` §7), `eval/metric_spec.yaml` sau CP2; không xoá câu thử trượt, không sửa `expected` cho khớp output.
- Không bịa người được phỏng vấn, trích dẫn, câu trả lời khảo sát, số liệu. Số không có nguồn thì ghi rõ *(tự ước tính)*.
- Công cụ có tác động ra ngoài (gửi tin, sửa dữ liệu, chấm điểm): chỉ tạo bản nháp chờ người duyệt.
- Không viết prompt "giấu" câu thử vào code (vd so khớp nguyên văn input của bộ câu thử).

## Quy ước của nhóm

- Ngôn ngữ trả lời người dùng: tiếng Việt (giao diện, bài đăng, tài liệu, commit message).
- Phong cách code / đặt tên: Python chỉ dùng thư viện chuẩn, tên hàm / biến `snake_case`, tên trường theo cột data (`ma_sp`, `gia_ban`…); giao diện `vpost/` TypeScript + Next.js, theo lint và typecheck của repo.
- Ai duyệt thay đổi do agent tạo trước khi commit: người giao việc cho agent đọc diff trước khi commit; mọi thay đổi vào `dev` / `main` đi qua PR, CI (pytest, vitest, typecheck, build) phải xanh, Tài hoặc Văn merge.
- Ngoại lệ luật "chỉ tạo bản nháp" (quyết định của chủ shop): tự trả lời bình luận (hỏi giá / size / màu + tư vấn size) và bộ lọc ngôn từ / tự kiểm duyệt (`spam`, `scam`, `abusive`, `pii`; khiếu nại `complaint` KHÔNG BAO GIỜ bị tự ẩn) luôn chạy thẳng chế độ thật (`live`) mặc định cho mọi Fanpage đã kết nối, không có công tắc bật/tắt theo từng Page; chỉ giữ công tắc khẩn cấp toàn hệ thống (`VPOST_AUTO_REPLY_DISABLED=1`, `VPOST_AUTO_MODERATION_DISABLED=1`). Trần tự trả lời mặc định ở mức tối đa cho phép (200/giờ, 2000/ngày). Câu trả lời ghép từ dữ liệu sản phẩm và bảng size, không do AI viết; trường hợp khác gắn "Cần bạn" chờ người xử lý.
