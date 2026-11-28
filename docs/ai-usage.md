# Khai báo dùng AI

README của nhóm có mục "Dùng AI vào việc gì" (2–3 dòng, bắt buộc). Ghi chi tiết vào bảng dưới đây.

> Luật của đề: dùng AI để làm bài thoải mái, nhưng **ai không giải thích được phần có tên mình thì phần đó nhận 0 điểm**. Khai thiếu không bị trừ; giấu mới bị.

| Việc | Công cụ AI | AI làm gì | Người kiểm/sửa gì | Ai phụ trách |
|---|---|---|---|---|
| Code bản chạy thử | Claude Code (Claude Opus 5.5); 1 commit có GitHub Copilot | Viết code backend Python (`codebase/`), giao diện VPOST (`vpost/`), test, CI/CD — 56/94 commit (không tính merge) có dòng `Co-Authored-By: Claude` | Mọi thay đổi đi qua PR vào `dev` / `main`; CI chạy pytest (1.034 test), vitest, typecheck, lint, build trước khi merge | Cả nhóm, theo phần việc ở `TEAMS.md` |
| Prompt / thiết kế lời gọi mô hình | Claude Code (Claude Opus 5.5) | Viết `codebase/prompts.py` (SYSTEM prompt viết / đánh dấu, cấu hình giọng viết theo Page) | Luồng và chỗ chặn do nhóm chốt ở `spec.md` §4; đo bằng 3 lượt eval (`eval/report.md`) | Trần Văn Tài (luồng AI của agent) |
| Đào data (viết script đếm, gợi ý nhãn) | Claude Code (Claude Opus 5.5) | Viết `scripts/build_data.py` (`mine_posts`, `mine_promo`: đếm bằng regex) | Kiểm tay: *(nhóm điền số dòng đã kiểm)* | Nguyễn Hoàng Huy (data card) |
| Rà câu hỏi phỏng vấn / khảo sát | *(nhóm điền nếu có)* | Chỉ rà câu dẫn dắt | | Nguyễn Thế Văn (bằng chứng) |
| Viết câu thử (benchmark) | Khung `B01`–`B24` tạo trong commit CP1 có Claude đồng tác giả; `B25`–`B30` không có dòng đồng tác giả AI | Gợi ý câu thử theo lưới 4 chiều (`eval/README.md` mục 2) | Mỗi câu thử có `source`: 24 câu `tu_viet`, 6 câu từ data thật / khảo sát | Hồ Xuân Vũ (bộ câu thử) |
| Sinh data `synthetic` (nếu có) | Claude Code (Claude Opus 5.5) | Viết `scripts/build_data.py` sinh `data/inventory.csv` (tồn kho `synthetic`) | Seed 42 · kiểm tay: *(nhóm điền)* | Nguyễn Hoàng Huy |
| Chấm cột `pass` bằng LLM (nếu có) | Không dùng | — | Cột `pass` do người chấm theo `eval/metric_spec.yaml` (grader `code` / `nguoi`) | Hồ Xuân Vũ |
| Slide, văn bản | Claude Code (Claude Opus 5.5) | Dựng `slides/demo-slides.html` → `demo-slides.pdf`; soạn nháp các mục còn trống của `spec.md`, `cost/cost-estimate.md` từ số đã có trong repo | Số trên slide và trong spec lấy từ `evidence/`, `eval/`, `cost/`; nhóm đọc lại trước khi nộp | Trần Văn Tài |

**Không dùng AI để:** tạo người được phỏng vấn, trích dẫn, câu trả lời khảo sát; sửa kết quả các lượt đã chạy (`eval/run-*.csv`, `cost/simulate-*.csv`, `traces/`).
