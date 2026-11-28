# Báo cáo đánh giá — lượt 1 → một cải tiến → lượt 2

> Điền ở guide bước 4.1. Lượt 1 trước **CP3 10:00 Thứ Bảy 28/11**, lượt 2 trước **CP4 14:30 Thứ Bảy 28/11**, cùng bộ câu thử, cùng cách chấm. Chấm ở rubric R5.
> Số lấy từ `python run.py score eval/run-1.csv` (và `run-2.csv`) sau khi điền cột `pass`. Chỉ ghi kết quả Lượt 2 sau khi thực sự chạy và chấm xong; **kết quả thấp ghi thật vẫn đủ điểm.**
> Không được: sửa chuẩn "đạt", bỏ câu thử trượt, sửa `expected` cho khớp output, sửa kết quả lượt đã chạy.

## 1. Kết quả

| Lượt | Run ID | Đạt / tổng | % | thuong | kho | tu_choi | So với chuẩn "đạt" |
|---|---|---|---|---|---|---|---|
| 1 | `run-1@20261128-095827` | 8/30 | 27% | 1/10 (10%) | 6/14 (43%) | 1/6 (17%) | chưa |
| 2 | `run-2@20261128-141751` | 9/30 | 30% | 2/10 (20%) | 6/14 (43%) | 1/6 (17%) | chưa |

Kết quả từng câu: Lượt 1 tại `eval/run-1.csv`, Lượt 2 tại `eval/run-2.csv` (trace `traces/run-2.jsonl`). Không sửa file kết quả Lượt 1.
So sánh: tăng 1 câu (từ 8 lên 9). Thay đổi thuộc `thuong` (`B25` 0→1). Các câu `B10`–`B12`, `B26`–`B30` giữ nguyên kết quả. `B25` đạt ở Lượt 2 do biến thiên của LLM, không phải do cải tiến (đường xử lý alias không liên quan đến `chat_lieu`).

## 2. Lỗi lượt 1 — gom thành nhóm có tên

| Nhóm lỗi | Số câu | Câu |
|---|---|---|
| Chặn sớm do giá dưới giá sàn page mặc định `Dịu Mây` (`< 540.000đ`) | 19 | `B01`–`B06`, `B08`–`B09`, `B13`–`B16`, `B18`–`B24` |
| Mã sản phẩm không có trong `data/inventory.csv` | 1 | `B07` |
| Chưa chuẩn hóa tên cột lệch chuẩn dạng text trong `answer()` | 1 | `B17` |
| AI bỏ sót trường dữ kiện (`chat_lieu: Polyester`) khi viết bài | 1 | `B25` |

**≥3 lỗi cụ thể:**

| Câu | Input | Output | Vì sao sai |
|---|---|---|---|
| `B01` | `Mã SP: AO-01 \| Giá: 199000 \| Page: Thời trang nam nữ` | `ĐÁNH DẤU: gia_ban: 199.000đ dưới giá sàn 540.000đ của page Dịu Mây` | Bộ câu thử cũ dùng giá `< 540k` và page không khớp `data/pages.json` nên bị chặn sớm thay vì tạo bài nháp |
| `B17` | `Ma_Hang: AO-17 \| Đơn giá: 160.000đ \| KichCo: S` | `ĐÁNH DẤU: gia_ban: thiếu giá bán; size: thiếu size` | `answer()` chưa map tên cột lệch chuẩn (`Đơn giá`, `KichCo`) như khi đọc file Excel |
| `B25` | `ma_sp: G5V6071502 \| gia_ban: 1.950.000đ \| chat_lieu: Polyester` | `VIẾT ... Giá chỉ 1.950.000đ ... size S, M, L, XL, 2XL ...` | AI viết đúng giá, size, xưng hô nhưng bỏ sót chất liệu `Polyester` |

## 3. Cải tiến chọn cho Lượt 2

- Nhắm vào lỗi `B17`: chuẩn hóa alias tên cột dạng text — `Đơn giá` → `gia_ban`, `KichCo` → `size`. Đây là lỗi phù hợp để sửa và đo riêng: dữ liệu đầu vào đã có giá và size nhưng hệ thống vẫn đánh dấu thiếu, khiến người vận hành phải nhập lại dữ liệu.
- Thay đổi dự kiến: bổ sung alias trong `codebase/rules.py` tại bước chuẩn hóa dòng. Giữ nguyên `eval/benchmark.csv`, `expected` và tiêu chí chấm để so sánh công bằng.
- Trạng thái: **đã triển khai** (thêm alias `ma_hang`, `don gia`, `kichco` trong `ALIASES` ở `codebase/rules.py`) và **đã chạy Lượt 2**. Phần kiểm tra vật liệu trong `verify_post` đã được bỏ khỏi thay đổi này theo quyết định của nhóm.
- Kết quả `B17`: **vẫn trượt**. Parse đã đúng (đọc được `gia_ban` 160000 và `size` S), nhưng giá 160.000đ dưới giá sàn 540.000đ của page mặc định `Dịu Mây`, nên hệ thống chặn đúng theo luật. Lỗi chuyển từ "thiếu giá/size" sang "dưới giá sàn" — tức là lỗi thật nằm ở ánh xạ page (xem mục 4).
- Tổng Lượt 2: 9/30 (30%), tăng 1 câu so với Lượt 1 (8/30). Cải tiến chỉ tác động đến parse cột; không làm thay đổi đáng kể kết quả tổng. Đây là kết quả thật, không điều chỉnh.

## 4. Còn lại

- Lỗi chưa sửa + nguy hiểm thế nào:
  1. `B17` vẫn trượt sau khi đã thêm alias: giá 160.000đ dưới giá sàn 540.000đ của page mặc định. Cần quyết định ánh xạ page/giá sàn cho bộ câu này; không sửa `expected` để khớp output.
  2. `B25` (AI đôi lúc bỏ sót trường chất liệu `Polyester` khi viết bài) — dễ làm thiếu thông số sản phẩm trên Fanpage nếu người duyệt không đọc kỹ.
  3. Nhóm 19 câu ở hàng đầu bảng mục 2 dùng giá dưới giá sàn mặc định và/hoặc tên page không khớp `data/pages.json`; cần giữ nguyên bộ câu khi so sánh Lượt 1–2, đồng thời ghi rõ giới hạn này khi diễn giải kết quả. Không sửa `expected` để làm cho output hiện tại đạt.
- Kết luận: cải tiến alias đúng về mặt kỹ thuật nhưng không đủ để tăng đáng kể tỉ lệ đạt (8/30 → 9/30, trong đó 1 câu tăng do biến thiên LLM). Phần lớn lỗi nằm ở nhóm 19 câu bị chặn bởi giá sàn page và ở ánh xạ page trong bộ câu.
- Mô phỏng chi phí (≥50 phiên, `python run.py simulate --rate-from eval/run-2.csv`, seed 42): 50 phiên, tỉ lệ đạt 30% lấy từ Lượt 2. Kết quả trong `cost/simulate-1-summary.md`. Token đo trên `gpt-4o-mini`; giá tính theo `gemini-3.1-flash-lite` ($0.00041/task thành công) và `gemini-4-hydrogen` ($0.0023/task thành công). Hai lượt `simulate-1`, `simulate-2` chạy khi `cost/personas.yaml` còn persona mẫu. Lượt dùng làm kết luận: `cost/simulate-3.csv` (`simulate-3@20261128-225022`, 50 phiên, persona theo khảo sát, tỉ lệ đạt 12/30 từ Lượt 3): $0.0018 / task thành công (`gpt-4o-mini`) · $0.0261 (`gpt-6.2-sol`) — xem `cost/cost-estimate.md`.

## 5. Cải tiến tiếp theo — Lượt 3

Giữ nguyên cấu hình Page `Dịu Mây` (giá sàn `540.000đ`), benchmark, `expected` và tiêu chí chấm. Thêm chặn cứng ảnh thiếu/không hợp lệ, mâu thuẫn độ dài tay áo, yêu cầu bỏ qua bước kiểm tra, và claim/thương hiệu bị cấm trong mô tả.

| Lượt | Run ID | Đạt / tổng | % | thuong | kho | tu_choi |
|---|---|---|---|---|---|---|
| 2 | `run-2@20261128-141751` | 9/30 | 30% | 2/10 (20%) | 6/14 (43%) | 1/6 (17%) |
| 3 | `run-3@20261128-143901` | 12/30 | 40% | 2/10 (20%) | 7/14 (50%) | 3/6 (50%) |

Lượt 3 tăng 3 câu so với Lượt 2: `B02`, `B13`, `B22`, `B23` đạt; một câu trước đó đạt (`B25`) trượt do model bỏ sót chất liệu. Kết quả thực tế là 12/30, chưa đạt chuẩn "đạt" của `spec.md` §7 (≥80% câu qua, 100% câu `tu_choi`, ≥90% từng metric `khop_du_lieu_san_pham` và `chan_dung_loi_va_ton_kho`). Output và chấm từng câu lưu tại `eval/run-3.csv`, trace tại `traces/run-3.jsonl`.

**Lưu ý sau Lượt 3:** commit `c1a684a` (28/11 15:10) gỡ luật chặn cứng sản phẩm không có ảnh vì làm hỏng test API trên CI. `B02` (thiếu ảnh) đạt ở Lượt 3 nhờ luật này, nên code hiện tại có thể không còn đạt `B02`. Kết quả Lượt 3 giữ nguyên; lượt chạy sau cần đo lại.

Mô phỏng chi phí Lượt 3: 50 phiên, seed 42, đạt 12/30 (40%); kết quả tại `cost/simulate-2-summary.md` và dữ liệu tại `cost/simulate-2.csv`. Chi phí/task thành công theo cấu hình mô phỏng là `$0.00031` (gemini-3.1-flash-lite) và `$0.0017` (gemini-4-hydrogen). Các giá, persona và quy mô vẫn là giả định trong file cấu hình; cần bổ sung nguồn trước khi coi đây là dự báo thực tế.

## 6. Lượt 4 — đo lại sau khi gỡ luật thiếu ảnh, bộ 37 câu

`run-4@20261128-232637`, model `gpt-4.1-mini` (Lượt 1–3 dùng `gpt-4o-mini`), code sau `c1a684a`, bộ câu thêm 7 câu data thật `B31`–`B37`. Model và số câu khác Lượt 3 nên chỉ so được trên 30 câu chung, và chênh lệch có thể do model chứ không chỉ do code. Cột `pass` do Claude chấm nháp theo `eval/metric_spec.yaml`, Tài duyệt từng câu; lý do từng câu ở cột `ghi_chu` của `eval/run-4.csv`.

| Lượt | Run ID | Đạt / tổng | % | thuong | kho | tu_choi |
|---|---|---|---|---|---|---|
| 3 | `run-3@20261128-143901` | 12/30 | 40% | 2/10 (20%) | 7/14 (50%) | 3/6 (50%) |
| 4 (30 câu chung) | `run-4@20261128-232637` | 16/30 | 53% | 4/10 (40%) | 9/14 (64%) | 3/6 (50%) |
| 4 (cả bộ 37 câu) | `run-4@20261128-232637` | 23/37 | 62% | 4/10 (40%) | 15/20 (75%) | 4/7 (57%) |

- Trượt → đạt: `B03`, `B06`, `B14`, `B16`, `B17`, `B25`. Phần lớn là các câu tự viết trước đây bị chặn ở giá sàn `Dịu Mây`, nay page lạ không mượn giá sàn (`735ccfb`) nên đi tới đúng bước cần đo.
- Đạt → trượt: `B02` (thiếu ảnh vẫn viết bài — đúng như lưu ý sau Lượt 3 về `c1a684a`), `B10` (chỉ ghi lý do giá tệ, thiếu lý do giá sàn page 380.000đ ghi trong dòng).
- `B31`–`B37` (data thật) đạt 7/7.
- Nhóm lỗi còn lại: bài bỏ mất ưu đãi có trong file (`B05` Freeship, `B08` giảm 10%); `verify_post` đánh dấu nhầm "thun" là lệch "Cotton" (`B01`, `B15`); chặn sai lý do (`B09`, `B19`, `B20`, `B24`); không chặn ảnh thiếu / vi phạm (`B02`, `B21`); `B04` không ghi nhận "đã có bài đăng trước đó".
- `B07`, `B18` chấm trượt vì phần tiêu chí không kiểm được từ output eval (lưu SQLite / giờ hẹn; nhánh bắt lệch giá không xảy ra do AI viết đúng ngay lần 1).

Kết quả 23/37 chưa đạt chuẩn "đạt" của `spec.md` §7 (`tu_choi` mới 4/7, chuẩn là 100%). Ghi thật, không điều chỉnh.
