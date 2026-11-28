# Canvas — WorkHardToday · Track F

> Điền ở guide bước 1.4. CP1 17:00 Thứ Sáu 27/11: nộp bản đầu, đủ 7 dòng (dòng 4 được ghi giả thuyết + nguồn sẽ kiểm).
> CP2 19:30 Thứ Sáu 27/11: cập nhật (số bằng chứng đầu, lát cắt đã chốt) và điền dòng "Đã đổi gì so với CP1".
> Track F: chép thêm thẻ đề của nhóm (khung trong file track F) xuống dưới bảng này.

| # | Dòng | Nhóm điền |
|---|---|---|
| 1 | Track + lát cắt dự kiến | Track F · Từ một file Excel / CSV danh sách sản phẩm thời trang (các trường thông tin sản phẩm + prompt của người dùng), tạo hàng loạt bài đăng Facebook, người quản trị duyệt xong thì đẩy vào lịch đăng bài của Fanpage |
| 2 | Người dùng chính (một vai cụ thể — không phải "học viên nói chung") | Nhân viên phụ trách Vsoạn và đăng bài sản phẩm lên Fanpage Facebook của công ty bán thời trang (vd nhóm nhân viên đang làm việc này ở công ty mysp) |
| 3 | Pain một câu: ai — đang làm gì — vướng đâu — hậu quả | Người quản trị trang bán hàng thời trang đang tự gửi mô tả + ảnh từng sản phẩm vào ChatGPT để viết bài, rồi copy thủ công sang Facebook để đăng / hẹn giờ — mỗi lượt chỉ ra được vài bài — nên tốn nhiều thời gian, công sức, đăng được ít sản phẩm |
| 4 | Bằng chứng đầu — CP1: giả thuyết + nguồn sẽ kiểm · CP2: số đầu tiên + 1 trích dẫn | **Giả thuyết:** nhân viên mất nhiều thời gian cho mỗi bài (dán vào ChatGPT + chỉnh + copy sang Facebook + hẹn giờ), và số bài đăng mỗi ngày bị giới hạn bởi bước thủ công này. **Nguồn sẽ kiểm:** phỏng vấn ≥3 nhân viên soạn / đăng bài ở mysp (bấm giờ một lượt soạn + đăng, đếm số bài / ngày) · review công khai của công cụ đăng bài / quản lý fanpage. **CP2 — đang làm:** đã nghe CEO + nhóm nhân viên mysp mô tả pain (trò chuyện, chưa ghi nguyên văn, chưa bấm giờ). Số đầu tiên + trích dẫn *(cập nhật CP3, 28/11)*: `0/4.671` bài AI cũ của shop nêu giá / size (đào data) · `3/6` người trực tiếp đăng bài mất 20–30+ phút / bài (khảo sát) · *"Làm đi làm lại việc đăng bài rất nhàm chán"* (phiếu khảo sát #2) — `evidence/summary.md` |
| 5 | **Lát cắt MỘT CÂU** (1 người dùng · 1 việc · 1 quyết định AI · 1 kết quả) | Một người quản trị trang bán đồ thời trang · tải lên một file Excel / CSV gồm nhiều sản phẩm (mỗi dòng: thông tin sản phẩm + prompt) · AI quyết định với từng dòng: viết bài theo prompt từ đúng các trường có trong file, hay đánh dấu dòng thiếu / mâu thuẫn thông tin (giá, size, chất liệu) thay vì tự bịa · người quản trị nhận một bảng bài nháp Facebook, mỗi sản phẩm một bài, duyệt xong thì bài được đẩy vào lịch đăng của Fanpage |
| 6 | AI tự làm đến đâu + 1 dòng lý do: sai thì ai chịu gì | AI soạn bài nháp và đề xuất giờ đăng; **chỉ bài người quản trị đã bấm duyệt** mới được hệ thống đẩy vào lịch đăng Facebook (bài hẹn giờ, chưa đăng ngay, vẫn huỷ / sửa được trên Facebook). Dòng bị đánh dấu thiếu / mâu thuẫn không được đẩy. Lý do: bài sai giá, sai size, sai chất liệu đã lên Fanpage thì shop chịu khiếu nại, đổi trả và mất uy tín với khách |
| 7 | Phân công có tên | Trần Văn Tài (đội trưởng) — luồng AI của agent: kiểm dữ liệu từng dòng → viết bài / đánh dấu, sơ đồ `spec.md` §4, nối model, cải tiến lượt 2, slide + kịch bản demo, nộp checkpoint · Nguyễn Hoàng Huy — backend: đọc file Excel / CSV, API, lưu bài nháp, Fanpage thử + token, `schedule_post` lên lịch Facebook (Graph API); data card + file sản phẩm giả; mô phỏng chi phí · Nguyễn Thế Văn — phỏng vấn ≥3 nhân viên mysp, `evidence/`; frontend: màn tải file, bảng bài nháp, sửa / duyệt bài, nút đẩy lịch · Hồ Xuân Vũ — bộ câu thử (≥10 → 20–30 câu), `metric_spec.yaml`, `eval/report.md`, bảng impact |
| — | *(CP2)* Đã đổi gì so với CP1 | (1) Chỉ làm Facebook, thêm bước đẩy bài đã duyệt vào lịch đăng Fanpage; người dùng chính đổi thành nhân viên soạn bài của công ty (nghe từ CEO + nhân viên mysp). (2) Chốt hình dạng **workflow cố định**: thêm `check_stock` (tồn kho theo màu × size, ngừng SX) và `verify_post` (kiểm giá lệch > 2%, cụm cấm, ưu đãi không có trong file) — AI chỉ còn 1 quyết định: viết hay đánh dấu. (3) Đầu vào thêm cột Tồn kho, Ảnh, Page, Giá tệ / giá sàn; dữ liệu chạy thử là `synthetic` (`data/DATA_CARD.md`). |

---

# Track F · Soạn hàng loạt và lên lịch bài đăng sản phẩm thời trang trên Fanpage Facebook

### Lĩnh vực
Bán hàng thời trang qua Fanpage Facebook.

### Pain
Nhân viên soạn và đăng bài của công ty bán thời trang đang tự gửi mô tả + ảnh từng sản phẩm vào ChatGPT để viết bài, rồi copy sang Facebook để đăng / hẹn giờ thủ công. Mỗi lượt chỉ ra được vài bài → tốn thời gian, công sức, đăng được ít sản phẩm.

### Insight từ người dùng thật
- **Nguồn:** nghe trực tiếp từ CEO và nhóm nhân viên đang soạn, đăng bài sản phẩm lên Fanpage ở công ty mysp.
- **Đã nghe:** nhân viên gửi mô tả + ảnh từng sản phẩm vào ChatGPT, mỗi lượt chỉ ra vài bài, rồi copy sang Facebook để đăng / hẹn giờ — tốn thời gian, công sức.
- **Bước tiếp:** phỏng vấn ≥3 nhân viên, bấm giờ một lượt soạn + đăng, đếm số bài / ngày.

### Người dùng
- **Vai chính:** nhân viên soạn và đăng bài sản phẩm lên Fanpage Facebook của công ty bán thời trang.
- **Gặp ở:** nhóm nhân viên đang làm việc này tại công ty mysp.

### Data
- **Đầu vào:** file Excel / CSV, mỗi dòng một sản phẩm: các trường thông tin (vd tên, giá, size, màu, chất liệu, mô tả) + prompt của người dùng.
- **Đào bằng chứng:** review công khai của công cụ đăng bài / quản lý fanpage, bài hỏi đáp công khai trong nhóm người bán online (bỏ tên người viết).
- **Chạy thử:** file sản phẩm giả có seed, tên shop dựng; đẩy lịch vào một Fanpage thử nghiệm của nhóm.
- **Không dùng:** file sản phẩm, tin nhắn, thông tin khách của shop thật.

### Lát cắt
Một nhân viên soạn bài · tải lên một file Excel / CSV nhiều sản phẩm (thông tin sản phẩm + prompt) · AI quyết định với từng dòng: viết bài Facebook theo prompt từ đúng các trường trong file, hay đánh dấu dòng thiếu / mâu thuẫn thông tin thay vì tự bịa · nhân viên duyệt bảng bài nháp, bài đã duyệt được đẩy vào lịch đăng của Fanpage.

### Công cụ của agent

| Công cụ | Input | Output | Tác động ra ngoài |
|---|---|---|---|
| `read_products` | file Excel / CSV | danh sách sản phẩm, báo dòng lỗi định dạng | Không |
| `check_product` | một dòng sản phẩm | danh sách trường thiếu / mâu thuẫn | Không |
| `save_drafts` | các dòng, bài viết, giờ đề xuất | bảng bài nháp chờ duyệt | Không |
| `schedule_post` | bài đã duyệt, giờ đăng | bài hẹn giờ trên Fanpage (Facebook Graph API) | **Có** — chỉ chạy khi nhân viên bấm duyệt, agent không tự gọi |

### Bộ câu thử
Mỗi câu thử là một dòng sản phẩm + prompt.
- **Thường:** đủ thông tin → bài đúng giá, size, chất liệu, làm đúng yêu cầu trong prompt.
- **Khó:** thiếu giá / size, giá sai định dạng, mô tả mâu thuẫn với trường màu / chất liệu, prompt mơ hồ → phải đánh dấu, không bịa.
- **Từ chối:** prompt đòi viết "hàng chính hãng" cho hàng không rõ nguồn, nói xấu shop khác, câu tấn công chèn lệnh vào ô mô tả / ô prompt.

### Persona chi phí *(tự ước tính, cần kiểm)*
- **Ít:** 1 file ~5 sản phẩm / ngày
- **Vừa:** 1 file ~20 sản phẩm / ngày
- **Nhiều:** vài file, tổng ~50 sản phẩm / ngày

### Bẫy
- Bịa thông tin sản phẩm (giá, chất liệu, "chính hãng") nghe hay nhưng sai.
- Đẩy lịch cả dòng chưa duyệt hoặc dòng bị đánh dấu lỗi.
- Sa vào phần nối Facebook (token, quyền Page) mà bỏ bê chất lượng bài viết và bộ câu thử.

### An toàn
- AI không tự đăng / lên lịch: chỉ bài nhân viên đã duyệt mới được đẩy, và chỉ ở dạng hẹn giờ (huỷ được), không đăng ngay.
- Không tự đặt giá / khuyến mãi; không viết nội dung sai sự thật về sản phẩm.
- Không dùng ảnh người mẫu, thông tin khách hàng thật.
- Không xin mật khẩu Facebook — chỉ dùng Page access token để trong `.env`, không commit.
