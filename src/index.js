// Cloudflare Worker - lớp trung gian giữa frontend và Google Sheet (Apps Script webhook)
// Mục đích: giấu URL Google Sheet thật, kiểm soát origin, chống spam cơ bản.
//
// Route:
//   POST /collect        -> analytics (D1)            [MỚI]  src/collect.js
//   /admin/api/*         -> Admin API (Supabase auth) [MỚI]  src/admin/router.js
//   GET  /health         -> health check              [MỚI]
//   còn lại              -> luồng lead cũ (handleLead) - GIỮ NGUYÊN, không thay đổi hành vi

import { handleCollect, purgeOldEvents } from './collect.js';
import { handleAdmin } from './admin/router.js';

// ─────────────────────────────────────────────────────────────────────────────
// LUỒNG LEAD CŨ - giữ nguyên logic (chỉ đổi export default.fetch thành handleLead)
// ─────────────────────────────────────────────────────────────────────────────

// Rate limit đơn giản theo IP, lưu trong bộ nhớ Worker (reset khi Worker restart - không bền,
// chỉ chặn spam nhanh liên tục; nếu cần chuẩn hơn dùng Cloudflare Rate Limiting rule hoặc KV/Durable Object).
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW_MS = 60_000; // 1 phút
const RATE_LIMIT_MAX_REQUESTS = 5; // tối đa 5 request/phút/IP

function isRateLimited(ip) {
	const now = Date.now();
	const entry = rateLimitMap.get(ip);

	if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
		rateLimitMap.set(ip, { windowStart: now, count: 1 });
		return false;
	}

	entry.count += 1;
	if (entry.count > RATE_LIMIT_MAX_REQUESTS) {
		return true;
	}
	return false;
}

function buildCorsHeaders(env) {
	return {
		'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
		'Access-Control-Allow-Methods': 'POST, OPTIONS',
		'Access-Control-Allow-Headers': 'Content-Type',
	};
}

// Validate dữ liệu tối thiểu trước khi forward đi, tránh gửi rác vào Google Sheet
function validatePayload(data) {
	if (!data || typeof data !== 'object') return 'Payload không hợp lệ';
	if (!data.name || typeof data.name !== 'string' || !data.name.trim()) {
		return 'Thiếu họ và tên';
	}
	if (!data.phone || typeof data.phone !== 'string' || !data.phone.trim()) {
		return 'Thiếu số điện thoại';
	}
	return null;
}

async function handleLead(request, env) {
	const corsHeaders = buildCorsHeaders(env);

	// Preflight request
	if (request.method === 'OPTIONS') {
		return new Response(null, { status: 204, headers: corsHeaders });
	}

	if (request.method !== 'POST') {
		return new Response(JSON.stringify({ success: false, error: 'Method Not Allowed' }), {
			status: 405,
			headers: { 'Content-Type': 'application/json', ...corsHeaders },
		});
	}

	// Rate limit theo IP
	if (env.ENABLE_RATE_LIMIT === 'true') {
		const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
		if (isRateLimited(ip)) {
			return new Response(JSON.stringify({ success: false, error: 'Quá nhiều yêu cầu, vui lòng thử lại sau' }), {
				status: 429,
				headers: { 'Content-Type': 'application/json', ...corsHeaders },
			});
		}
	}

	if (!env.GOOGLE_SHEET_URL) {
		return new Response(JSON.stringify({ success: false, error: 'Server misconfigured' }), {
			status: 500,
			headers: { 'Content-Type': 'application/json', ...corsHeaders },
		});
	}

	let data;
	try {
		data = await request.json();
	} catch {
		return new Response(JSON.stringify({ success: false, error: 'JSON không hợp lệ' }), {
			status: 400,
			headers: { 'Content-Type': 'application/json', ...corsHeaders },
		});
	}

	const validationError = validatePayload(data);
	if (validationError) {
		return new Response(JSON.stringify({ success: false, error: validationError }), {
			status: 400,
			headers: { 'Content-Type': 'application/json', ...corsHeaders },
		});
	}

	try {
		// Forward sang Google Sheet (Apps Script webhook) - URL lấy từ secret, không lộ ra ngoài
		await fetch(env.GOOGLE_SHEET_URL, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(data),
		});

		return new Response(JSON.stringify({ success: true }), {
			status: 200,
			headers: { 'Content-Type': 'application/json', ...corsHeaders },
		});
	} catch (err) {
		return new Response(JSON.stringify({ success: false, error: 'Không gửi được dữ liệu, thử lại sau' }), {
			status: 502,
			headers: { 'Content-Type': 'application/json', ...corsHeaders },
		});
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// ROUTER
// ─────────────────────────────────────────────────────────────────────────────

export default {
	async fetch(request, env) {
		const { pathname } = new URL(request.url);
		const path = pathname.replace(/\/+$/, '') || '/';

		if (path === '/collect') return handleCollect(request, env);

		if (path === '/admin/api' || path.startsWith('/admin/api/')) return handleAdmin(request, env, path);

		if (path === '/health' && request.method === 'GET') {
			return new Response(JSON.stringify({ ok: true }), {
				status: 200,
				headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
			});
		}

		// Mọi request còn lại giữ nguyên hành vi cũ: coi như lead.
		return handleLead(request, env);
	},

	// Cron hằng ngày: dọn event analytics quá hạn lưu trữ.
	async scheduled(_event, env, ctx) {
		ctx.waitUntil(purgeOldEvents(env));
	},
};
