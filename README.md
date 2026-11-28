> Giờ, mốc, luật, rubric: xem `README.md`, `02-guide.md`, `03-rubric.md` trong repo đề (bộ đề BTC phát).

# WorkHardToday — Soạn hàng loạt và lên lịch bài đăng Facebook cho sản phẩm thời trang

**Thành viên, lớp, track:** xem [TEAMS.md](TEAMS.md). **Điền TEAMS.md đúng format**: khi chấm và đánh giá, BTC quét file này để ghép điểm cho từng người.

*Lát cắt = phần nhỏ nhất làm xong được trong hackathon: một người dùng · một việc · một quyết định AI · một kết quả.*

---

## Chạy VPOST (giao diện mới + backend Python)

Backend Python (`codebase/server.py`) phục vụ API theo đúng hợp đồng của giao diện VPOST trong `vpost/` (bản dựa trên MYSP nhánh `dev`). Giao diện chỉ chạy phần Next.js: không Docker, không Postgres/Redis, mọi `/api/*` chuyển sang Python.

```bash
python codebase/server.py                       # backend: http://127.0.0.1:8020 (lần đầu tự nạp data/demo_products.xlsx)
cd vpost
# tạo vpost/.env.local với 4 dòng:
#   DEV_FAKE_SESSION=1
#   AUTH_URL=http://localhost:3010
#   SESSION_SECRET=<chuỗi ngẫu nhiên 64 ký tự hex>
#   VPOST_API_URL=http://127.0.0.1:8020
npx pnpm@11.21.0 install
npx pnpm@11.21.0 dev -p 3010                    # giao diện: http://localhost:3010/products
```

- **Sản phẩm** (`/products`): các dòng của file đã tải; dòng bị chặn có lý do (thiếu giá/size, mâu thuẫn, hết hàng, thiếu ảnh).
- **Chạy hàng loạt** (`/bulk`) và **Soạn bài** (`/compose?code=…`): làm theo thứ tự sau.
  - `compose`: code kiểm dòng, kiểm tồn và ảnh.
  - `captions`: AI viết bài hoặc đánh dấu dòng.
  - Người duyệt, rồi `batches`: lên lịch.
- **Bài đăng** (`/posts`): bài đã hẹn (đổi giờ, huỷ) và nhật ký.
- **Kênh** (`/channels`): nối Page Facebook thật qua OAuth.
  1. Ở app Facebook, mục *Facebook Login (for Business) → Settings → Valid OAuth Redirect URIs*, thêm `http://localhost:3010/api/channels/callback`.
  2. Điền `FB_APP_ID`, `FB_APP_SECRET` vào `.env` ở gốc repo, rồi chạy lại backend.
  3. Bấm nối kênh, tự đăng nhập Facebook và cho phép. Mỗi Page có token sẽ thành một kênh `fb-<id>`; bài hẹn giờ trên kênh đó lên Page thật.
  - Token lưu trong `data/app.db` (không commit). Cách khác: dán User Access Token vào ô nhập token (`POST /api/channels/import`).
- **Kết nối dữ liệu** (`/data-mapping`): nhập file sản phẩm .xlsx/.csv (`POST /api/vpost/catalog`), có bảng các cột cần có, file mẫu (`/api/vpost/catalog/template`) và data demo 30 mẫu váy (`/api/sample`). Dòng thiếu thông tin vẫn nhập, chỉ bị lọc lúc soạn bài.
- API nằm ở `codebase/vpost_api.py`. Test: `python -m pytest tests -q`.

## Chạy bản chạy thử (web app cũ)

```bash
python -m pip install -r requirements.txt
copy .env.example .env        # macOS/Linux: cp — điền MODEL_PROVIDER=openai, MODEL_NAME=gpt-5.6-luna, API_KEY=...
python codebase/server.py     # mở http://127.0.0.1:8020
```

1. **Tải file:** chọn page mặc định, kéo file `.xlsx`/`.csv` vào. Bấm "Tải file mẫu" để lấy `data/demo_products.xlsx` (30 dòng váy, có cài lỗi).
2. **Bảng nháp:** mỗi dòng là bài nháp hoặc dòng bị đánh dấu (kèm lý do theo từng trường). Ở đây sửa bài, thêm/xoá ảnh, duyệt (cần ≥1 ảnh), bỏ, hoặc sửa dữ liệu rồi soạn lại. Phím: ↑/↓ chuyển dòng, A duyệt.
3. **Lịch đăng:** bài đã duyệt nằm ở khung giờ trống gần nhất của page.

- Luồng mỗi dòng (sơ đồ ở `spec.md` §4): kiểm dòng (code) → kiểm tồn kho (code) → 1 lần gọi AI (viết hay đánh dấu) → soát bài (code) → viết lại ≤1 lần.
- Cột của file sản phẩm: `ma_sp, ten_sp, loai, gia_ban, gia_te, size, mau, chat_lieu, mo_ta, anh, page, prompt`. Tên cột quen của shop (`Mã`, `Giá bán (theo ẢNH)`, `Màu 1..5`, `Link ảnh info`…) cũng đọc được.
- Cột `anh` nhận link ảnh, link Google Drive, `=IMAGE("…")` và JSON ảnh Drive.
- Test: `python -m pytest tests -q`. Dựng lại data từ file Excel gốc (để ngoài repo): `python scripts/build_data.py --raw ..`.

## Nhóm làm gì, khung làm gì

| Nhóm quyết định và viết | Khung làm sẵn (không cần sửa) |
|---|---|
| Người dùng, pain, bằng chứng, impact (`evidence/`, `spec.md` §1–§2) | — |
| Hình dạng giải pháp, công cụ, prompt, luồng (`spec.md` §4, `codebase/agent.py`, `tools.py`, `ai.py`) | Ghi mọi lần gọi model / công cụ vào trace, cộng token (`codebase/tracing.py`) |
| Bộ câu thử, metric, chuẩn "đạt" (`eval/benchmark.csv`, `eval/metric_spec.yaml`, `spec.md` §7) | Kiểm đủ cột, đủ câu `kho` / `tu_choi`, đủ ≥1/3 câu từ người dùng / data thật (`run.py check`) |
| Chấm cột `pass` theo metric spec | Chạy cả bộ một lệnh, có run ID, model, token từng câu (`run.py eval`) · tính % đạt (`run.py score`) |
| Persona, số người dùng thật, giá model (`cost/personas.yaml`) | Sinh ~50 phiên, chạy thật qua bản chạy thử, tính chi phí / phiên, / task thành công, / tháng 3 kịch bản (`run.py simulate`) |

*Ví dụ track A (ví dụ cỡ, không phải lời giải):* nhóm viết công cụ `search_lesson` tra bài pre-class đã đánh mã đoạn, luồng "tra đoạn → model trả lời kèm mã đoạn, không có thì nói không có", metric "mọi khẳng định có mã đoạn đúng", persona "ôn dồn trước kiểm tra". Khung chạy 25 câu thử ra `run-1.csv`, nhóm chấm `pass`, `score` in % đạt; `simulate` chạy 50 phiên ra chi phí / task thành công cho hai model.

## Chạy trong 3 phút

Bộ khung cần **Python 3.10 trở lên** (Python 3.9 có sẵn trên macOS vẫn chạy được, chỉ in một dòng nhắc). **Không cần `pip install`.**

**Bước 1 — Mở cửa sổ lệnh ngay trong thư mục repo**

| Windows (PowerShell) | macOS |
|---|---|
| Mở thư mục repo bằng File Explorer → bấm vào thanh địa chỉ → gõ `powershell` → Enter | Mở **Terminal** (Cmd + Space, gõ "Terminal") → gõ `cd ` (có dấu cách) → kéo thả thư mục repo vào → Enter |

Gõ `dir` (Windows) hoặc `ls` (macOS / Linux): thấy `run.py` và `README.md` là đang đứng đúng chỗ.

**Bước 2 — Kiểm Python và chạy thử**

| Việc | Windows (PowerShell) | macOS / Linux |
|---|---|---|
| Kiểm Python | `python --version` (không được thì `py --version`) | `python3 --version` |
| Chạy bản chạy thử (chế độ giả, chưa gọi model) | `python run.py` | `python3 run.py` |
| Kiểm bộ câu thử | `python run.py check` | `python3 run.py check` |
| Tạo file `.env` để nối model | `copy .env.example .env` | `cp .env.example .env` |

- Windows: gõ `python` mà mở Microsoft Store hoặc báo không có lệnh → dùng `py`. Chưa có Python: cài từ python.org, **tick "Add python.exe to PATH"**, mở lại PowerShell.
- macOS: báo `command not found: python` là bình thường → dùng `python3`.
- `python run.py` in ra "[câu trả lời giả — chưa nối model] …" là khung chạy đúng. Nối model thật: [docs/connect-model.md](docs/connect-model.md).

Trong README này lệnh viết là `python …`; máy nhóm cần `python3` hay `py` thì gõ thay.

## Lệnh

| Lệnh | Làm gì |
|---|---|
| `python run.py` | Chạy bản chạy thử (gõ đầu vào, nhận kết quả, kèm số lần gọi model / token) |
| `python run.py check` | Kiểm `eval/benchmark.csv` (6 cột, số câu, `kho` / `tu_choi`, mã `source`, ô trống, dòng mẫu) `eval/metric_spec.yaml` (≥3 metric điền đủ) và `TEAMS.md` (đúng format để BTC quét). Chỉ cảnh báo, không sửa file |
| `python run.py eval --try` | **Thử nối model:** chạy 3 câu đầu (`--try 5` = 5 câu) → `eval/run-try.csv`. Thấy "Nối model được" là xong. Không tính là một lượt |
| `python run.py eval` | Chạy cả bộ qua `codebase/agent.py` → `eval/run-1.csv` (lần sau `run-2.csv`…) + `traces/run-1.jsonl`. Mỗi dòng có run ID, model, số lần gọi model / công cụ, token. Model còn giả → chỉ ghi `run-mock.csv`; mọi câu lỗi → `run-error.csv`; Ctrl+C → `run-stopped.csv` — đều **không** được đánh số |
| `python run.py eval --fake` | Thử riêng bộ chạy, không gọi agent → `eval/run-fake.csv` |
| `python run.py score eval/run-1.csv` | Sau khi điền cột `pass` (1 / 0): in % đạt tổng và theo `type`. Còn ô trống → "CHƯA CHẤM XONG", không in % |
| `python run.py simulate --try` | Thử mô phỏng chi phí 10 phiên (làm trước CP3) → `cost/simulate-try.csv` |
| `python run.py simulate` | Mô phỏng chi phí khi dùng thật theo `cost/personas.yaml` (≥50 phiên) → `cost/simulate-N.csv` + `cost/simulate-N-summary.md` |
| `python run.py simulate --rate-from eval/run-2.csv` | Như trên, lấy tỉ lệ đạt từ đúng lượt chỉ định. Không ghi thì khung lấy lượt `run-N` mới nhất đã chấm, cùng model, và ghi rõ đã lấy lượt nào trong bản tóm tắt |

Gói miễn phí báo hết lượt: thêm `--wait 4` sau `eval` hoặc `simulate` (nghỉ 4 giây giữa hai lượt gọi). Sửa CSV bằng Excel: *File → Save As → CSV UTF-8*; Google Sheets: *Tệp → Tải xuống → CSV*.

**Lượt có lỗi kỹ thuật** (cột `error` có chữ): không sửa tay file đó, chạy lại thành lượt mới và ghi vào bảng các lượt ở `eval/README.md`. Không xoá file lượt nào.

Nhóm dùng stack khác (Node, Streamlit, notebook…): sửa hàm `run_app()` trong `run.py` để `python run.py` vẫn chạy được bản chạy thử, và giữ `answer()` trong `codebase/agent.py` để `eval`, `simulate` chạy được.

## Bản chạy thử — viết ở đâu

| File | Viết gì | Bước guide |
|---|---|---|
| `codebase/agent.py` | `answer(text)` — luồng chính, đúng hình dạng ở `spec.md` §4. Khung có sẵn một workflow 2 bước *ví dụ* | 3.2 |
| `codebase/tools.py` | Công cụ của bài toán, mỗi công cụ một hàm có `@tool` | 2.2, 3.2 |
| `codebase/ai.py` | `call_model(system, user)` — chỗ duy nhất gọi model. Chưa điền `.env` thì chạy **chế độ giả** | 3.3 |

- **Trước CP2:** để chế độ giả, công cụ trả dữ liệu giả — `python run.py` đi hết luồng là đủ.
- **Trước CP3:** nối model thật theo [docs/connect-model.md](docs/connect-model.md), `eval --try` thấy token > 0 rồi mới `eval`.
- Bộ chạy gửi **nguyên ô `input`** của câu thử vào `answer(text)`. Dữ liệu nền (bài học, thông báo, lịch…) để trong `data/`, đọc qua công cụ.

## Phần nào thật, phần nào giả

| Thành phần | Thật / Giả | Ghi chú |
|---|---|---|
| Lời gọi AI ở quyết định trung tâm | **Thật** (bắt buộc từ CP3) | Model: 3 lượt eval đo trên `gpt-4o-mini` (OpenAI, cột `model` trong `eval/run-*.csv`); `.env` máy demo đặt `gpt-5.6-luna`. 1 lần gọi / dòng, viết lại ≤1 lần |
| Dữ liệu sản phẩm demo (`data/demo_products.xlsx`) | **Thật**, có sửa | 30 dòng váy lấy từ catalog hàng order của shop (mã, giá, size, màu, chất liệu, ảnh thật). ~1/2 số dòng được sửa có chủ đích để cài lỗi — xem `data/demo_products_answer_key.csv` |
| Ảnh sản phẩm | **Thật** | Link ảnh công khai của shop (Google Drive). Ảnh không tải được bị bỏ khi dựng data và khi xử lý từng dòng |
| Tồn kho (`data/inventory.csv`) | **Giả** (dựng, seed 42) | Thay POS thật; người dùng tải file tồn mới được trong app |
| Giọng page, giá sàn, khung giờ (`data/pages.json`) | Dựng từ quy định thật | Tên page đã đổi; giá sàn, khung giờ giữ đúng mức của page gốc |
| Lên lịch đăng | Lịch trong app | Facebook Graph API (bài hẹn giờ, chưa đăng) chạy khi kênh là Page nối qua OAuth (màn Kênh) hoặc `.env` có token Fanpage thử. OAuth mới thử bằng test giả lập, chưa nối Page thật |

## Dùng AI vào việc gì

2–3 dòng (bắt buộc): nhóm dùng công cụ AI nào để làm gì, người kiểm lại phần nào. Chi tiết: [docs/ai-usage.md](docs/ai-usage.md). Coding agent đọc [AGENTS.md](AGENTS.md).

- **Viết code:** Claude Code (Claude Opus 5.5) viết phần lớn backend Python, giao diện VPOST, test và CI/CD (56/94 commit không phải merge có dòng đồng tác giả Claude). Mọi thay đổi đi qua PR; CI chạy pytest, vitest, typecheck, build trước khi merge.
- **Trong sản phẩm:** `gpt-4o-mini` (OpenAI) viết bài nháp, 1 lần gọi / dòng, viết lại tối đa 1 lần. Giá, tồn kho, luật đăng bài do code kiểm; người duyệt mọi bài trước khi lên lịch.
- **Không dùng AI** để tạo người phỏng vấn, trích dẫn, câu trả lời khảo sát, hay chấm cột `pass`.

## File mẫu — điền ở bước nào

| File | Điền ở bước guide | Mốc |
|---|---|---|
| `TEAMS.md` | 1.0 | CP1 · **đúng format**, BTC quét khi chấm |
| `canvas.md` | 1.4 | CP1, cập nhật CP2 |
| `evidence/hypothesis.md` | 1.1 | trước khi tìm bằng chứng |
| `evidence/data-mining.md` · `evidence/interviews/TEMPLATE.md` → `P1.md`… · `evidence/survey/TEMPLATE.md` | 1.2 | bắt đầu sau Zoom, xong CP3 |
| `evidence/summary.md` | 1.2 | CP3 |
| `spec.md` | §0–§2: 1.1–1.3 · §3–§5: 2.1–2.3 · §7: 2.4 · §8: 4.2 · §10: suốt | §7 chốt CP2 · §0–§7 CP3 · đủ CP4 |
| `data/DATA_CARD.md` | 2.4 | bản đầu CP2 |
| `eval/benchmark.csv` · `eval/metric_spec.yaml` | 2.4 | ≥10 câu + metric chốt CP2 · 20–30 câu CP3 |
| `codebase/` | 3.2, 3.3 | khung CP2 · AI thật CP3 |
| `eval/report.md` · `eval/README.md` | 4.1 (README mục 1–4 từ 2.4) | CP4 |
| `cost/personas.yaml` · `cost/cost-estimate.md` | 4.2 | thử 10 phiên CP3 · đủ CP4 |
| `validation/log.md` *(bonus)* | 4.3 | CP4 |
| `slides/outline.md` → `demo-slides.pdf` | 5.1 | CP4 |
| `reflection/TEMPLATE.md` → `reflection/<ten>.md` | 5.3 | 23:59 Thứ Bảy 28/11 |
| `AGENTS.md` · `docs/ai-usage.md` | khi dùng coding agent / AI | suốt |

## Bảy hạng mục bắt buộc — nằm ở file nào

| # | Hạng mục | File |
|---|---|---|
| 1 | Bằng chứng pain | `evidence/` (tổng hợp ở `evidence/summary.md`) |
| 2 | Impact có số | `spec.md` §2 |
| 3 | Thiết kế giải pháp | `spec.md` §4 |
| 4 | Bản chạy thử làm trọn lát cắt | `codebase/` · lệnh ở mục "Lệnh" |
| 5 | Định nghĩa "tốt" + bộ câu thử | `data/DATA_CARD.md` · `eval/` |
| 6 | Mô phỏng chi phí khi dùng thật | `cost/` |
| 7 | Slide + demo + video dự phòng | slide trong repo (PDF, PPTX, HTML…) hoặc link slide ở form CP4 · link video: https://drive.google.com/file/d/1bTSnd8KoYQg3TI0iX4NzLPjZLVlMVJDs/view?usp=drive_link |
| + | *Bonus:* người dùng thử | `validation/log.md` |
