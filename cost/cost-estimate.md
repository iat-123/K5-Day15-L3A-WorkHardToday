# Chi phí khi dùng thật

> Điền ở guide bước 4.2, nộp ở CP4 14:30 Thứ Bảy 28/11. Ôn lại: ngày 13, ngày 1, ngày 14 · lab ngày 13, lab ngày 14. Chấm ở rubric R6.
> Số **không điền tay**: điền `cost/personas.yaml` → `python run.py simulate` → chép bảng trong `cost/simulate-N-summary.md` vào đây.
> Lúc build dùng gói miễn phí vẫn tính theo **giá gói trả phí** — đây là chi phí cho lúc đưa vào dùng thật.

## 1. Đầu vào

- **Persona** (`cost/personas.yaml`, bản hiện tại): 3 kiểu, 1 phiên = 1 lần tải file, 1 lượt = 1 dòng sản phẩm — `dung_it` 20% · 1 dòng / phiên · `dung_vua` 20% · 3 dòng · `dung_nhieu` 60% · 5 dòng; đều 4 phiên / người / tháng. Nguồn: khảo sát câu 2 "số bài trong 7 ngày qua" (5 người nhớ được số: 1 bài `1/5` · 3 bài `1/5` · 5 bài `3/5`, `evidence/survey/results_summary.md`); 4 phiên / tháng (gom bài mỗi tuần thành 1 file) là *(tự ước tính)*.
- **Số người dùng thật** 3 kịch bản: thấp 6 · cơ sở 30 · cao 100. Nguồn: thấp = 6 người trực tiếp soạn/đăng bài trong khảo sát; cơ sở, cao *(tự ước tính)* — chưa có số công khai về số nhân viên soạn bài của các shop thời trang.
- **Giá** ≥2 mức model (từ `further-reading/model-prices.md` của repo đề, BTC xem 25/11/2026 — https://developers.openai.com/api/docs/pricing): `gpt-4o-mini` vào 0.15 · ra 0.60 $/1M (tầng Nhỏ) · `gpt-6.2-sol` vào 2.00 · ra 10.00 $/1M (tầng Lớn)
- **Tỉ lệ đạt** dùng để tính: 12/30 (40%) — lượt `run-3@20261128-143901` (lượt mới nhất đã chấm)
- Đo token trên model `gpt-4o-mini` (cùng model với 3 lượt eval), tính giá model `gpt-4o-mini` và `gpt-6.2-sol` (cùng hãng; bộ tách token có thể khác nên số token thật trên `gpt-6.2-sol` có thể lệch).

## 2. Kết quả mô phỏng

Lượt mô phỏng: `cost/simulate-3.csv` · run ID `simulate-3@20261128-225022` · 50 phiên · seed 42 · 0/50 phiên lỗi · tỉ lệ đạt 12/30 (40%) từ `eval/run-3.csv`.

| Persona | Số phiên mô phỏng | Lượt hỏi / phiên | Token vào / phiên | Token ra / phiên | Gọi model / phiên | Gọi công cụ / phiên |
|---|---:|---:|---:|---:|---:|---:|
| dung_it | 10 | 1 | 558 | 58 | 0.4 | 2.0 |
| dung_vua | 12 | 3 | 2768 | 272 | 2.0 | 7.1 |
| dung_nhieu | 28 | 5 | 4820 | 483 | 3.5 | 12.0 |

| Model | Chi phí / phiên | Chi phí / task thành công | Chi phí / câu hỏi đạt | Chi phí / tháng — thấp (6 người) | Chi phí / tháng — cơ sở (30 người) | Chi phí / tháng — cao (100 người) | Chi phí / người / tháng (cơ sở) |
|---|---:|---:|---:|---:|---:|---:|---:|
| gpt-4o-mini | $0.00073 | $0.0018 | $0.00049 | $0.0179 | $0.0897 | $0.2989 | $0.0030 |
| gpt-6.2-sol | $0.0104 | $0.0261 | $0.0070 | $0.2562 | $1.28 | $4.27 | $0.0427 |

Chi phí / task thành công = chi phí trung bình mỗi phiên ÷ tỉ lệ đạt — **không coi như đạt 100%**. Bảng chép từ `cost/simulate-3-summary.md`.

- Dòng bị code chặn (giá, tồn kho, lệnh chèn…) không gọi model, nên `dung_it` (1 dòng / phiên) chỉ gọi model 0,4 lần / phiên.
- `simulate-3` chạy trên code hiện tại, sau khi đã gỡ luật chặn cứng thiếu ảnh (commit `c1a684a`), nên số lần gọi model / phiên cao hơn các lượt trước (lượt `simulate-2`: 0,1–0,4 lần / phiên). Tỉ lệ đạt vẫn lấy từ `run-3` (code lúc đó còn luật này).
- Lượt cũ `simulate-1`, `simulate-2` chạy khi `personas.yaml` còn persona và số người dùng mẫu của khung (300 / 700 / 1.000) → không dùng làm kết luận; giữ file, không sửa.

## 3. So với impact

- Impact / người / tháng (`spec.md` §2): ≈ 21 bài × 15 phút = 315 phút ≈ 5,25 giờ công đang tốn cho việc soạn + đăng.
- Chi phí / người / tháng (cơ sở, model `gpt-4o-mini`): $0.0030 · nếu dùng `gpt-6.2-sol`: $0.0427.
- **Kết luận một dòng — đáng làm không:** đáng làm — kể cả với model tầng Lớn, chi phí model chưa tới 5 cent / người / tháng so với ~5 giờ công; điều cần cải thiện trước khi dùng thật là chất lượng (12/30 câu đạt, chưa đạt chuẩn), không phải chi phí.

## 4. *(Muốn sâu hơn, không bắt buộc)*

- Bảng độ nhạy: model rẻ hơn · cache · cắt ngữ cảnh · giới hạn bước — mỗi cần gạt đổi chi phí bao nhiêu
- Chi phí ngoài model: hosting, lưu trữ, giờ công người duyệt
- Quy mô nào thì bài toán còn đáng làm
