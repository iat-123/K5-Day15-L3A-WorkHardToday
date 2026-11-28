# Data card — dữ liệu bản chạy thử dùng

Nguồn gốc chung: 2 file Google Sheets vận hành của shop thời trang (công ty mysp), tải về 27/11/2026: "AI - Làm ảnh taobao" (hàng order Taobao/1688, bài đăng Fanpage) và "Hàng thiết kế 2026" (hàng tự thiết kế, khuyến mãi, kho ảnh). **File gốc để ngoài repo.** Mọi file dưới đây sinh lại được bằng `python scripts/build_data.py --raw <thư mục chứa 2 file>` (seed 42).

## Dataset 1 · `demo_products.xlsx` / `.csv` — file sản phẩm để tải vào app

| | |
|---|---|
| Dùng để làm gì | đầu vào demo của luồng "tải file → bài nháp / đánh dấu"; nguồn câu thử |
| Từ đâu | 30 dòng `Loại = Váy` chọn ngẫu nhiên (seed 42) từ sheet `Catalog Order` (400 váy có đủ giá, size, link ảnh). Ảnh thêm lấy từ sheet `Kho ảnh` theo mã (≤3 ảnh / mã) |
| Xử lý những bước gì | giữ mã, giá bán (theo ảnh), size, màu 1–5, chất liệu (`PE` → `Polyester`), link ảnh Drive → link ảnh trực tiếp `lh3.googleusercontent.com/d/<id>`; bỏ ảnh không tải được; gán page dựng + prompt mẫu; **sửa có chủ đích 16 dòng** để cài lỗi (thiếu giá/size/ảnh, giá sai dạng, giá dưới giá sàn, mô tả mâu thuẫn, prompt đòi "chính hãng", chèn lệnh, đòi thông tin không có, hết hàng…) |
| Số dòng | 30 (đáp án lỗi cài: `demo_products_answer_key.csv`) |
| Nhãn | thật (đã sửa một phần) |
| Giới hạn | catalog không có tên sản phẩm và mô tả → bài chỉ dựa vào giá, size, màu, chất liệu; 68% váy trong catalog không ghi chất liệu. Ảnh đã in sẵn mã + giá trên ảnh |

## Dataset 2 · `inventory.csv` — tồn kho theo màu × size

| | |
|---|---|
| Dùng để làm gì | nguồn cho công cụ `check_stock` (kiểm kho trước khi soạn) |
| Từ đâu | **dựng (synthetic)**, theo dạng sheet "Đổ tồn" của shop (mã, màu, size, tồn, trạng thái sản xuất) |
| Xử lý | tồn ngẫu nhiên 2–9 / biến thể; cài: 1 mã không có trong kho, 1 hết hàng, 1 "thanh toán hết mới nhận sx 1c", 1 còn một phần (hết 1 màu), 1 sắp hết (≤2) |
| Nhãn | `synthetic`, seed 42 |

## Dataset 3 · `pages.json` — giọng page, giá sàn, khung giờ

| | |
|---|---|
| Từ đâu | sheet `QUY ĐỊNH CHỌN HÀNG` (gu từng page, giá tệ tối thiểu × 13.500) và `Lịch đăng bài` (khung giờ) |
| Xử lý | 5 page, tên đã đổi thành tên dựng; giá sàn và khung giờ giữ nguyên mức của page gốc; từ cấm + thương hiệu khác + cụm có điều kiện do nhóm viết |

## Dataset 4 · `style_examples.json` — bài cũ để cảm nhịp giọng

| | |
|---|---|
| Từ đâu | cột `Content AI` của sheet `Đăng bài Order` / `Đăng bài BOT` (bài đã đăng công khai) |
| Xử lý | 24 bài, ưu tiên bài có chữ váy/đầm; bỏ dòng cam kết cuối bài, dòng có số điện thoại / hotline / địa chỉ / link |

## Dataset 5 · `evidence/data-mining-numbers.md` — số bằng chứng

Chỉ chứa số tổng hợp (4.671 bài đã đăng, sổ soi lệch khuyến mãi). Cách đếm nằm trong `scripts/build_data.py` (`mine_posts`, `mine_promo`). **Đây là data thật, dùng cho bằng chứng pain**, không phải data chạy thử.

## File dữ liệu cũ của bản CP2 đầu — `products_sample.csv`, `pages.csv`, `post_rules.md`, `make_data.py`

Bản đầu (Tài, 27/11) dựng 40 sản phẩm synthetic, 8 Page, luật bài đăng bằng `python data/make_data.py`. Code hiện tại (`codebase/agent.py`, `tools.py`, `rules.py`) **không đọc** các file này; giữ lại để đối chiếu câu thử. **Không chạy `data/make_data.py`**: script ghi đè `data/inventory.csv` của bản hiện tại.

## Bộ câu thử — `eval/benchmark.csv`

Mô tả ở `eval/README.md`. Hiện 37 câu: 24 `tu_viet`, 12 `data_that` (`B25`–`B28`, `B30`–`B37`, lấy từ `demo_products.csv`), 1 `nguoi_dung` (`B29`, khảo sát câu 9b) → 13/37 từ người dùng / data thật, đạt ≥ 1/3.
