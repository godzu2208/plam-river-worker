// Tiện ích HTTP dùng chung cho các route MỚI (/collect, /admin/api/*).
// Luồng lead cũ (src/index.js -> handleLead) KHÔNG dùng file này.

export class HttpError extends Error {
	constructor(status, message) {
		super(message);
		this.status = status;
	}
}

export function json(body, status = 200, headers = {}) {
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			'Content-Type': 'application/json; charset=utf-8',
			'Cache-Control': 'no-store',
			...headers,
		},
	});
}

// "https://a.com/, https://b.com" -> ["https://a.com", "https://b.com"]
export function parseOrigins(str) {
	return (str || '')
		.split(',')
		.map((s) => s.trim().replace(/\/+$/, ''))
		.filter(Boolean);
}

// CORS chặt: chỉ echo lại origin nằm trong allowlist, không bao giờ dùng '*'.
export function corsFor(request, allowedOrigins, { methods, headers }) {
	const out = { Vary: 'Origin' };
	const origin = request.headers.get('Origin');
	if (origin && allowedOrigins.includes(origin)) {
		out['Access-Control-Allow-Origin'] = origin;
		out['Access-Control-Allow-Methods'] = methods;
		out['Access-Control-Allow-Headers'] = headers;
		out['Access-Control-Max-Age'] = '86400';
	}
	return out;
}

// Đọc body có giới hạn kích thước (không tin Content-Length).
export async function readTextLimited(request, maxBytes) {
	const declared = Number(request.headers.get('Content-Length') || 0);
	if (declared > maxBytes) return { tooLarge: true };
	if (!request.body) return { text: '' };

	const reader = request.body.getReader();
	const chunks = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > maxBytes) {
			await reader.cancel();
			return { tooLarge: true };
		}
		chunks.push(value);
	}
	const buf = new Uint8Array(total);
	let offset = 0;
	for (const c of chunks) {
		buf.set(c, offset);
		offset += c.byteLength;
	}
	return { text: new TextDecoder().decode(buf) };
}

// Rate limit cửa sổ cố định trong bộ nhớ isolate (best-effort, không chia sẻ giữa isolate).
// Cần chặt hơn thì dùng Cloudflare Rate Limiting rules ở tầng edge.
export function createRateLimiter(windowMs, max) {
	const map = new Map();
	return function isLimited(key) {
		const now = Date.now();
		if (map.size > 5000) {
			for (const [k, v] of map) if (now - v.start > windowMs) map.delete(k);
		}
		const entry = map.get(key);
		if (!entry || now - entry.start > windowMs) {
			map.set(key, { start: now, count: 1 });
			return false;
		}
		entry.count += 1;
		return entry.count > max;
	};
}

export function clientIp(request) {
	return request.headers.get('CF-Connecting-IP') || 'unknown';
}

export async function audit(env, actor, action, detail) {
	try {
		if (!env.DB) return;
		await env.DB.prepare('INSERT INTO audit_log (ts, actor, action, detail) VALUES (?, ?, ?, ?)')
			.bind(Date.now(), actor, action, detail ? String(detail).slice(0, 500) : null)
			.run();
	} catch (err) {
		console.error('audit failed', err);
	}
}
