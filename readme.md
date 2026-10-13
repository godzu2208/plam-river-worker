# Lead Webhook Worker

Cloudflare Worker hiện tại nhận lead từ landing page, kiểm tra tối thiểu
`name`/`phone`, rồi chuyển tiếp payload tới Apps Script qua
`GOOGLE_SHEET_URL`. Tài liệu này ghi riêng trạng thái đang có trong code và
các phần dự kiến phát triển; các mục kế hoạch chưa được triển khai.

## Cấu trúc project

```text
lead-webhook-worker/
├─ src/
│  └─ index.js              # Worker hiện tại
├─ test/
│  └─ index.spec.js         # Test scaffold (đang không khớp với Worker)
├─ package.json             # lệnh deploy/dev/test/tail
├─ vitest.config.js         # Vitest pool cấu hình dùng wrangler.jsonc
├─ wrangler.jsonc           # cấu hình Wrangler được Vitest tham chiếu
├─ wrangler.toml            # cấu hình Wrangler cũ, còn tồn tại song song
├─ readme.md
└─ .env                     # local only; không commit/chia sẻ secrets
```

## Trạng thái hiện tại (theo source code)

### Luồng nhận và ghi lead

`src/index.js` hiện thực hiện:

1. Xây CORS headers từ `ALLOWED_ORIGIN`; nếu biến không có thì fallback thành
   `*`.
2. Trả `204` cho `OPTIONS`.
3. Chỉ chấp nhận method `POST`; method khác trả `405`.
4. Nếu `ENABLE_RATE_LIMIT === "true"`, giới hạn theo
   `CF-Connecting-IP`: tối đa 5 request trong một cửa sổ 60 giây.
5. Trả `500` nếu thiếu `GOOGLE_SHEET_URL`.
6. Parse JSON; JSON lỗi trả `400`.
7. Kiểm tra `name` và `phone` là chuỗi không rỗng; thiếu trường trả `400`.
8. Gửi nguyên payload JSON tới `GOOGLE_SHEET_URL` bằng `POST`.
9. Nếu `fetch()` Apps Script ném lỗi mạng, trả `502`; nếu không ném lỗi, trả
   `{ "success": true }`.

Luồng đang có:

```text
Landing page
  → POST Worker
  → validate name/phone
  → POST GOOGLE_SHEET_URL
  → Apps Script doPost()
  → lưu lead vào RAW_LEAD (theo cấu hình Apps Script hiện có)
```

Landing page gửi các trường lead và thông tin attribution/UTM theo
`palm-river-mkt/src/services/leadService.js`. Việc Worker forward nguyên payload
giữ tương thích với những trường hiện có; Worker không kiểm tra schema 14 cột
của Sheet.

### Giới hạn/rủi ro đã thấy trong code

- Worker không phân nhánh theo pathname. Mọi `POST` đến Worker đều đi vào
  handler lead; không có route `/collect` hoặc `/admin/api/*`.
- Payload tracking của landing page có dạng `{ v, sent_at, events }`, không có
  `name`/`phone`, nên nếu `VITE_TRACK_URL` trỏ tới Worker này thì request
  tracking sẽ bị validation lead từ chối (thường là `400`).
- Worker không kiểm tra `response.ok` hoặc status của Apps Script. Nếu Apps
  Script trả HTTP lỗi nhưng `fetch()` vẫn hoàn tất bình thường, Worker hiện
  vẫn có thể trả `{ "success": true }`.
- Rate limit dùng `Map` trong bộ nhớ isolate: trạng thái có thể mất khi isolate
  khởi động lại và không phải bộ đếm dùng chung toàn hệ thống. Giới hạn 5
  request/phút cũng có thể quá thấp cho analytics pageview/scroll nếu áp dụng
  chung.
- CORS hiện cho phép `POST, OPTIONS`, nhưng chỉ khai báo
  `Access-Control-Allow-Headers: Content-Type`; fallback `*` không nên được
  dùng cho production. CORS không thay thế xác thực hay chống request giả mạo.
- `wrangler.toml` hiện đặt `ALLOWED_ORIGIN` thành
  `https://palm-river.vercel.app/` (có dấu `/` cuối). Origin trình duyệt thông
  thường không có dấu `/` cuối; phải xác nhận/cập nhật giá trị theo origin
  production thật.
- `wrangler.toml` và `wrangler.jsonc` cùng tồn tại, có ngày tương thích khác
  nhau và cấu hình khác nhau. `vitest.config.js` chỉ rõ dùng `wrangler.jsonc`,
  còn `npm run dev/deploy` gọi Wrangler không chỉ rõ config. Cần chọn một file
  canonical và xác nhận hành vi CLI trước khi thay đổi/deploy.
- Test hiện tại vẫn kỳ vọng `"Hello World!"`, không phản ánh handler lead trong
  `src/index.js`; test cần được viết lại trước khi coi là kiểm tra hồi quy.

## Cấu hình và lệnh

`wrangler.toml` mô tả các biến thường:

- `ALLOWED_ORIGIN`: origin frontend được phép.
- `ENABLE_RATE_LIMIT`: bật/tắt limiter bộ nhớ đơn giản khi giá trị là chuỗi
  `"true"`.

`GOOGLE_SHEET_URL` là thông tin nhạy cảm, phải cấu hình dưới dạng secret trong
Cloudflare Workers, không khai báo trong file config có commit:

```powershell
npx wrangler secret put GOOGLE_SHEET_URL
```

Các lệnh khai báo trong `package.json`:

```bash
npm run dev       # wrangler dev
npm run deploy    # wrangler deploy
npm run test      # vitest
npm run tail      # wrangler tail
```

Không deploy cho tới khi kiểm tra đúng Wrangler config, secrets và origin của
môi trường đích. File `.env` chỉ dành cho local; không đưa secrets thật vào Git
hoặc frontend.

## Trạng thái tích hợp tracking `/collect`

Landing page `palm-river-mkt` hiện cấu hình:

```env
VITE_TRACK_URL=https://t.canho-palmriver.vn/collect
```

URL cấu hình ở frontend **không tự tạo endpoint**. Trong Worker source hiện
tại chưa có xử lý route `/collect`, schema event `{ v, sent_at, events }`, hoặc
binding D1. README/code hiện có cũng không xác minh domain này đang trỏ tới
Worker nào trong production.

### Kế hoạch nếu mở rộng chính Worker nhận lead

Giữ nguyên POST lead hiện tại và thêm route riêng:

```text
POST /                 → validate lead → GOOGLE_SHEET_URL (Apps Script doPost)
POST /collect          → validate analytics batch → ghi Cloudflare D1
GET /health (optional) → health response không chứa cấu hình/secret
other paths            → 404
```

Các yêu cầu cần thiết trước khi bật `/collect`:

1. Xác nhận route/domain `t.canho-palmriver.vn` được gắn tới đúng Worker.
2. Tạo D1 database, migration/schema cho event và cấu hình binding trong một
   Wrangler config canonical.
3. Chỉ nhận event type đã cho phép; validate kích thước body, số event mỗi
   batch, kiểu/độ dài field và timestamp. Không chấp nhận PII trong event.
4. Xác định chính sách IP/origin, CORS, rate limiting riêng cho analytics và
   cách xử lý duplicate/retry. Tracker dùng `sendBeacon` hoặc `fetch` với
   `text/plain`, gửi JSON body theo batch.
5. Ghi batch vào D1; lỗi analytics phải được tách khỏi luồng submit lead.
6. Thêm test riêng cho lead, tracking, CORS, validation, rate limit và lỗi D1.
7. Deploy lên staging, kiểm tra event thực sự xuất hiện trong D1, sau đó mới
   cấu hình URL production/build landing page.

Không nên áp nguyên giới hạn 5 request/IP/phút của endpoint lead cho tracking:
analytics phát sinh nhiều loại event theo phiên. Cần chọn limiter và retention
phù hợp với lượng traffic/privacy policy thực tế.

## Trạng thái tích hợp Admin

Project Admin mục tiêu dùng Supabase Auth cho Google OAuth và gọi Worker API
với access token. Worker hiện tại **chưa có**:

- xác minh Supabase JWT;
- kiểm tra allowlist/role admin;
- route `/admin/api/*`;
- API đọc leads/dashboard/CSV;
- API quản lý admin trong Supabase.

Kiến trúc mục tiêu đã thống nhất:

```text
Admin frontend
  → Supabase Auth
  → Worker Admin API: verify token + authorize role từ Supabase
  ├─ đọc/ghi dữ liệu admin trong Supabase
  └─ gọi Apps Script Admin API đã xác thực, chỉ đọc RAW_LEAD

Landing page → Worker POST lead hiện tại → Apps Script doPost() → RAW_LEAD
```

Apps Script API phục vụ Admin chỉ đọc `RAW_LEAD`; không sửa lead và không quản
lý danh sách admin. Admin chỉ xem/xuất lead. Dữ liệu admin/role lưu ở Supabase.
Các endpoint Admin phải được tách khỏi route ghi lead công khai; không dùng
CORS hay `VITE_*` làm cơ chế xác thực.

## Danh sách phát triển theo thứ tự

### A. Ổn định luồng lead hiện tại

- [ ] Chọn một Wrangler config canonical và đồng bộ ngày tương thích/vars.
- [ ] Sửa origin production (không có dấu `/` cuối), bỏ fallback wildcard ở
      production và kiểm thử preflight/origin.
- [ ] Kiểm tra status/body lỗi trả về từ Apps Script; không báo thành công khi
      Apps Script trả lỗi.
- [ ] Thêm giới hạn kích thước payload, method/path rõ ràng và test hồi quy cho
      validation, 405, 429, lỗi cấu hình, lỗi upstream.
- [ ] Thay test scaffold `"Hello World!"` bằng test đúng luồng lead hiện tại.

### B. Thêm analytics `/collect` vào cùng Worker

- [ ] Tạo D1 schema/binding/migration.
- [ ] Định tuyến `/collect` riêng, không chạy validation `name`/`phone`.
- [ ] Validate và ghi event batches vào D1; giữ nguyên endpoint lead.
- [ ] Đặt limiter riêng; xử lý privacy/consent, retention, DNT và ID theo chính
      sách sản phẩm.
- [ ] Thêm test và staging acceptance cho tracking.

### C. Thêm API cho Admin

- [ ] Thiết kế schema Supabase cho admin email/role, owner và quy trình cấp/
      thu hồi quyền; cấu hình RLS phù hợp.
- [ ] Xác minh access token Supabase ở Worker theo cách được Supabase hỗ trợ;
      trả `401` cho token sai/thiếu và `403` cho user không đủ quyền.
- [ ] Đọc/ghi admin records trong Supabase phía server; không đưa service-role
      key ra frontend.
- [ ] Xây Apps Script Admin endpoint chỉ đọc `RAW_LEAD`, xác thực riêng request
      từ Worker bằng secret lưu ở server.
- [ ] Bổ sung API đọc lead, dashboard/CSV và các nguồn dữ liệu khác đã được
      xác nhận; không bật màn hình chưa có backend contract.
- [ ] Cấu hình CORS chỉ cho Admin origin và test role enforcement cho mọi route.

## Production checklist

- [ ] Xác nhận Cloudflare route/domain và Wrangler config canonical.
- [ ] Secret `GOOGLE_SHEET_URL` có trong môi trường Worker; không xuất hiện
      trong repo/build/frontend.
- [ ] Lead hiện tại vẫn được ghi vào `RAW_LEAD` như trước.
- [ ] `/collect` chỉ bật sau khi D1 binding/schema/route đã deploy và test.
- [ ] Admin API chỉ bật sau khi xác minh Supabase token/role và Apps Script
      read-only endpoint đã sẵn sàng.
- [ ] Không coi URL trong `.env`, README hay test local là bằng chứng Worker đã
      deploy hoặc production domain đã trỏ đúng.
