// POST /collect - nhận batch event analytics từ tracker.js của landing page.
// Payload: { v: 1, sent_at, events: [...] } gửi bằng sendBeacon/fetch (text/plain).
// Hoàn toàn tách khỏi luồng lead (không validate name/phone, không đụng GOOGLE_SHEET_URL).

import { json, readTextLimited, parseOrigins, corsFor, createRateLimiter, clientIp } from './lib/http.js';

const MAX_BODY_BYTES = 16 * 1024;
const MAX_EVENTS = 20;
const DAY_MS = 86_400_000;
const MAX_AGE_MS = 7 * DAY_MS;
const MAX_FUTURE_MS = 10 * 60_000;

// Analytics phát sinh nhiều event/phiên, và nhiều khách có thể chung IP (NAT nhà mạng)
// nên giới hạn rộng hơn endpoint lead.
const isLimited = createRateLimiter(60_000, 300);

const ALLOWED_TYPES = new Set(['pageview', 'scroll', 'section_view', 'cta_click', 'form_start', 'lead', 'leave']);
const CHANNELS = new Set([
	'direct',
	'zns',
	'zalo',
	'google_ads',
	'facebook',
	'tiktok',
	'youtube',
	'paid_other',
	'campaign',
	'organic',
	'referral',
]);
const SCROLL_MARKS = new Set(['25', '50', '75', '100']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HOST_RE = /^[a-z0-9.-]{1,100}$/;
// Phòng thủ phía server: nếu label lỡ chứa SĐT/email thì bỏ hẳn (không lưu PII).
const PII_RE = /\+?\d[\d\s.\-()]{6,}\d|\S+@\S+/;

const INSERT_SQL = `INSERT OR IGNORE INTO events
	(ts, received_at, type, visitor_id, session_id, path, label, channel, utm_source, utm_medium, utm_campaign, referrer, country)
	VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

function str(v, max) {
	if (typeof v !== 'string') return '';
	let out = '';
	for (let i = 0; i < v.length && out.length < max * 2; i++) {
		const c = v.charCodeAt(i);
		if (c > 31 && c !== 127) out += v[i];
	}
	return out.trim().slice(0, max);
}

function normalizeEvent(e, skew, now, country) {
	if (!e || typeof e !== 'object') return null;
	if (!ALLOWED_TYPES.has(e.type)) return null;

	const visitorId = str(e.visitor_id, 40);
	const sessionId = str(e.session_id, 40);
	if (!UUID_RE.test(visitorId) || !UUID_RE.test(sessionId)) return null;

	const rawTs = Number(e.ts);
	if (!Number.isFinite(rawTs)) return null;
	// Bù lệch đồng hồ client dựa trên sent_at; loại event quá cũ / ở tương lai.
	const ts = Math.round(rawTs + skew);
	if (ts < now - MAX_AGE_MS || ts > now + MAX_FUTURE_MS) return null;

	const path = str(e.path, 200);
	if (!path.startsWith('/')) return null;

	let label = str(e.label, 60);
	if (PII_RE.test(label)) label = '';
	if (e.type === 'scroll' && !SCROLL_MARKS.has(label)) return null;

	const channel = CHANNELS.has(e.channel) ? e.channel : 'direct';
	const lower = (v) => str(v, 100).toLowerCase() || null;
	const referrer = str(e.referrer, 100).toLowerCase();

	return [
		ts,
		now,
		e.type,
		visitorId,
		sessionId,
		path,
		label,
		channel,
		lower(e.utm_source),
		lower(e.utm_medium),
		lower(e.utm_campaign),
		HOST_RE.test(referrer) ? referrer : null,
		country,
	];
}

export async function handleCollect(request, env) {
	const allowed = parseOrigins(env.TRACK_ALLOWED_ORIGINS || env.ALLOWED_ORIGIN);
	const cors = corsFor(request, allowed, { methods: 'POST, OPTIONS', headers: 'Content-Type' });

	if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
	if (request.method !== 'POST') return json({ success: false, error: 'Method Not Allowed' }, 405, cors);

	// Origin có mặt mà không nằm trong allowlist -> từ chối. (Không phải xác thực: curl có thể giả header.)
	const origin = request.headers.get('Origin');
	if (origin && !allowed.includes(origin)) return json({ success: false, error: 'Forbidden' }, 403, cors);

	if (!env.DB) return json({ success: false, error: 'Server misconfigured' }, 500, cors);
	if (isLimited(clientIp(request))) return json({ success: false, error: 'Too many requests' }, 429, cors);

	const { text, tooLarge } = await readTextLimited(request, MAX_BODY_BYTES);
	if (tooLarge) return json({ success: false, error: 'Payload too large' }, 413, cors);

	let payload;
	try {
		payload = JSON.parse(text);
	} catch {
		return json({ success: false, error: 'JSON không hợp lệ' }, 400, cors);
	}
	if (!payload || payload.v !== 1 || !Array.isArray(payload.events)) {
		return json({ success: false, error: 'Payload không hợp lệ' }, 400, cors);
	}
	if (payload.events.length === 0 || payload.events.length > MAX_EVENTS) {
		return json({ success: false, error: 'Số event không hợp lệ' }, 400, cors);
	}

	const now = Date.now();
	const sentAt = Number(payload.sent_at);
	const skew = Number.isFinite(sentAt) && Math.abs(now - sentAt) < DAY_MS ? now - sentAt : 0;
	const country = typeof request.cf?.country === 'string' ? request.cf.country : null;

	const rows = [];
	for (const e of payload.events) {
		const row = normalizeEvent(e, skew, now, country);
		if (row) rows.push(row);
	}
	if (rows.length === 0) return json({ success: false, error: 'Không có event hợp lệ' }, 400, cors);

	try {
		const stmt = env.DB.prepare(INSERT_SQL);
		await env.DB.batch(rows.map((r) => stmt.bind(...r)));
	} catch (err) {
		// Lỗi analytics không được ảnh hưởng luồng lead; chỉ log.
		console.error('collect: D1 insert failed', err);
		return json({ success: false, error: 'Internal error' }, 500, cors);
	}

	return new Response(null, { status: 204, headers: cors });
}

// Cron: xoá event quá hạn lưu trữ (EVENT_RETENTION_DAYS, mặc định 180 ngày).
export async function purgeOldEvents(env) {
	if (!env.DB) return;
	const days = Math.max(30, Number(env.EVENT_RETENTION_DAYS) || 180);
	const cutoff = Date.now() - days * DAY_MS;
	try {
		await env.DB.prepare('DELETE FROM events WHERE ts < ?').bind(cutoff).run();
	} catch (err) {
		console.error('purgeOldEvents failed', err);
	}
}
