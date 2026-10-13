// Router cho /admin/api/*. Mọi route đều yêu cầu Supabase token hợp lệ + domain + role.
//   GET   /admin/api/me                (viewer+)
//   GET   /admin/api/dashboard         (viewer+)   ?from=YYYY-MM-DD&to=YYYY-MM-DD
//   GET   /admin/api/leads             (admin+)    ?q&from&to&form_type&utm_*&page&pageSize
//   GET   /admin/api/leads.csv         (admin+)    cùng bộ lọc
//   GET   /admin/api/admins            (owner)
//   POST  /admin/api/admins            (owner)     { email, role }
//   PATCH /admin/api/admins/:email     (owner)     { role?, is_active? }

import { HttpError, json, parseOrigins, corsFor, createRateLimiter, clientIp, readTextLimited, audit } from '../lib/http.js';
import { authenticate, requireRole, ROLE_RANK, supabaseRest, invalidateRole, bootstrapOwners } from './auth.js';
import { getDashboard } from './dashboard.js';
import { listLeads, exportLeadsCsv } from './leads.js';

const isLimited = createRateLimiter(60_000, 60);
const EMAIL_RE = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/;

async function readJson(request) {
	const { text, tooLarge } = await readTextLimited(request, 4096);
	if (tooLarge) throw new HttpError(413, 'Payload too large');
	try {
		const body = JSON.parse(text);
		if (!body || typeof body !== 'object') throw new Error();
		return body;
	} catch {
		throw new HttpError(400, 'JSON không hợp lệ');
	}
}

function checkEmail(email, env) {
	const domain = (env.ALLOWED_EMAIL_DOMAIN || 'rever.vn').toLowerCase();
	if (!EMAIL_RE.test(email) || !email.endsWith(`@${domain}`)) {
		throw new HttpError(400, `Email phải thuộc @${domain}`);
	}
}

async function adminsRoute(request, env, admin, parts) {
	requireRole(admin, 'owner');
	if (!env.SUPABASE_SERVICE_ROLE_KEY) throw new HttpError(500, 'Server misconfigured');

	// GET /admins
	if (request.method === 'GET' && parts.length === 0) {
		const res = await supabaseRest(env, 'admins?select=email,role,is_active,created_by,created_at&order=created_at.asc');
		if (!res.ok) throw new HttpError(502, 'Không đọc được danh sách admin');
		return { admins: await res.json(), bootstrap_owners: bootstrapOwners(env) };
	}

	// POST /admins (thêm hoặc kích hoạt lại)
	if (request.method === 'POST' && parts.length === 0) {
		const body = await readJson(request);
		const email = String(body.email || '')
			.trim()
			.toLowerCase();
		const role = String(body.role || 'viewer');
		checkEmail(email, env);
		if (!ROLE_RANK[role]) throw new HttpError(400, 'Role không hợp lệ');
		if (email === admin.email) throw new HttpError(400, 'Không thể tự sửa quyền của chính mình');

		const res = await supabaseRest(env, 'admins?on_conflict=email', {
			method: 'POST',
			headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
			body: JSON.stringify({ email, role, is_active: true, created_by: admin.email, updated_at: new Date().toISOString() }),
		});
		if (!res.ok) throw new HttpError(502, 'Không lưu được admin');
		invalidateRole(email);
		await audit(env, admin.email, 'admin.upsert', `${email} -> ${role}`);
		return { admin: (await res.json())[0] };
	}

	// PATCH /admins/:email
	if (request.method === 'PATCH' && parts.length === 1) {
		const email = decodeURIComponent(parts[0]).trim().toLowerCase();
		checkEmail(email, env);
		if (email === admin.email) throw new HttpError(400, 'Không thể tự sửa quyền của chính mình');
		if (bootstrapOwners(env).includes(email)) throw new HttpError(400, 'Owner khởi tạo chỉ đổi được qua cấu hình Worker');

		const body = await readJson(request);
		const patch = { updated_at: new Date().toISOString() };
		if (body.role !== undefined) {
			if (!ROLE_RANK[body.role]) throw new HttpError(400, 'Role không hợp lệ');
			patch.role = body.role;
		}
		if (body.is_active !== undefined) {
			if (typeof body.is_active !== 'boolean') throw new HttpError(400, 'is_active phải là boolean');
			patch.is_active = body.is_active;
		}
		if (Object.keys(patch).length === 1) throw new HttpError(400, 'Không có trường nào để cập nhật');

		const res = await supabaseRest(env, `admins?email=eq.${encodeURIComponent(email)}`, {
			method: 'PATCH',
			headers: { Prefer: 'return=representation' },
			body: JSON.stringify(patch),
		});
		if (!res.ok) throw new HttpError(502, 'Không cập nhật được admin');
		const rows = await res.json();
		if (!rows.length) throw new HttpError(404, 'Không tìm thấy admin');
		invalidateRole(email);
		await audit(env, admin.email, 'admin.update', `${email} ${JSON.stringify(body)}`);
		return { admin: rows[0] };
	}

	throw new HttpError(405, 'Method Not Allowed');
}

export async function handleAdmin(request, env, path) {
	const allowed = parseOrigins(env.ADMIN_ALLOWED_ORIGINS);
	const cors = corsFor(request, allowed, { methods: 'GET, POST, PATCH, OPTIONS', headers: 'Content-Type, Authorization' });

	if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

	const origin = request.headers.get('Origin');
	if (origin && !allowed.includes(origin)) return json({ success: false, error: 'Forbidden' }, 403, cors);
	if (isLimited(clientIp(request))) return json({ success: false, error: 'Too many requests' }, 429, cors);

	try {
		const admin = await authenticate(request, env);
		const url = new URL(request.url);
		const route = path.slice('/admin/api'.length) || '/';
		const parts = route.split('/').filter(Boolean);
		const [head, ...rest] = parts;

		if (request.method === 'GET' && route === '/me') {
			requireRole(admin, 'viewer');
			return json({ success: true, data: admin }, 200, cors);
		}

		if (request.method === 'GET' && route === '/dashboard') {
			requireRole(admin, 'viewer');
			return json({ success: true, data: await getDashboard(env, url.searchParams) }, 200, cors);
		}

		if (request.method === 'GET' && route === '/leads') {
			requireRole(admin, 'admin');
			return json({ success: true, data: await listLeads(env, url.searchParams) }, 200, cors);
		}

		if (request.method === 'GET' && route === '/leads.csv') {
			requireRole(admin, 'admin');
			const { csv, count } = await exportLeadsCsv(env, url.searchParams);
			await audit(env, admin.email, 'leads.export', `${count} rows`);
			const stamp = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10).replace(/-/g, '');
			return new Response(csv, {
				status: 200,
				headers: {
					'Content-Type': 'text/csv; charset=utf-8',
					'Content-Disposition': `attachment; filename="leads-${stamp}.csv"`,
					'Cache-Control': 'no-store',
					...cors,
				},
			});
		}

		if (head === 'admins') {
			return json({ success: true, data: await adminsRoute(request, env, admin, rest) }, 200, cors);
		}

		throw new HttpError(404, 'Not Found');
	} catch (err) {
		if (err instanceof HttpError) return json({ success: false, error: err.message }, err.status, cors);
		console.error('admin api error', err);
		return json({ success: false, error: 'Internal error' }, 500, cors);
	}
}
