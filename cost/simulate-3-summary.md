# Tóm tắt mô phỏng simulate-3@20261128-225022

Do `python run.py simulate` sinh ra — không sửa tay. Chép bảng sang `cost/cost-estimate.md`.

| Persona | Số phiên mô phỏng | Lượt hỏi / phiên | Token vào / phiên | Token ra / phiên | Gọi model / phiên | Gọi công cụ / phiên |
|---|---:|---:|---:|---:|---:|---:|
| dung_it | 10 | 1 | 558 | 58 | 0.4 | 2.0 |
| dung_vua | 12 | 3 | 2768 | 272 | 2.0 | 7.1 |
| dung_nhieu | 28 | 5 | 4820 | 483 | 3.5 | 12.0 |

Tỉ lệ đạt dùng để tính: 12/30 (40%) — lượt run-3@20261128-143901

- Tỉ lệ đạt lấy từ lượt nhóm chọn: eval/run-3.csv (--rate-from).

| Model (giá) | Chi phí / phiên | Chi phí / task thành công | Chi phí / câu hỏi đạt | Chi phí / tháng — thấp (6 người) | Chi phí / tháng — cơ sở (30 người) | Chi phí / tháng — cao (100 người) | Chi phí / người / tháng (cơ sở) |
|---|---:|---:|---:|---:|---:|---:|---:|
| gpt-4o-mini (vào 0.15 · ra 0.6 $/1M) | $0.00073 | $0.0018 | $0.00049 | $0.0179 | $0.0897 | $0.2989 | $0.0030 |
| gpt-6.2-sol (vào 2.0 · ra 10.0 $/1M) | $0.0104 | $0.0261 | $0.0070 | $0.2562 | $1.28 | $4.27 | $0.0427 |

- Chi phí / task thành công = chi phí / phiên ÷ tỉ lệ đạt. Chi phí / câu hỏi đạt = chi phí / phiên ÷ số lượt hỏi trung bình mỗi phiên (3.7) ÷ tỉ lệ đạt — tỉ lệ đạt đo theo từng câu thử.
- Token đo trên model: gpt-4o-mini. Giá tính theo từng model trong bảng — model khác bộ tách token thì số token thật có thể lệch; ghi rõ "đo trên model X, tính giá model Y" trong cost/cost-estimate.md.
- Phiên lỗi (không tính vào trung bình): 0/50.
