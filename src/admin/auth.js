// Xác thực Admin: Supabase access token (Google OAuth) -> kiểm tra domain -> role trong Supabase.
// Worker không tự parse JWT: hỏi Supabase /auth/v1/user (cách được Supabase hỗ trợ), cache ngắn hạn.

import { HttpError } from '../lib/http.js';

export const ROLE_RANK = { viewer: 1, admin: 2, owner: 3 };

const USER_TTL_MS = 60_000;
const ROLE_TTL_MS = 30_000;
const userCache = new Map();
const roleCache = new Map();

function bearer(request) {
	const m = /^Bearer\s+(.+)$/i.exec(request.headers.get('Authorization') || '');
	return m ? m[1].trim() : null;
}

async function sha256Hex(s) {
	const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
	return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function prune(map) {
	if (map.size < 500) return;
	const now = Date.now();
	for (const [k, v] of map) if (v.exp < now) map.delete(k);
}

async function verifyToken(token, env) {
	if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) throw new HttpError(500, 'Server misconfigured');

	const key = await sha256Hex(token);
	const hit = userCache.get(key);
	if (hit && hit.exp > Date.now()) return hit.user;

	let res;
	try {
		res = await fetch(`${env.SUPABASE_URL.replace(/\/+$/, '')}/auth/v1/user`, {
			headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` },
			signal: AbortSignal.timeout(8000),
		});
	} catch {
		throw new HttpError(503, 'Không kết nối được dịch vụ xác thực');
	}
	if (res.status === 401 || res.status === 403) throw new HttpError(401, 'Token không hợp lệ hoặc đã hết hạn');
	if (!res.ok) throw new HttpError(503, 'Dịch vụ xác thực đang lỗi');

	const user = await res.json();
	prune(userCache);
	userCache.set(key, { exp: Date.now() + USER_TTL_MS, user });
	return user;
}

export function supabaseRest(env, path, init = {}) {
	return fetch(`${env.SUPABASE_URL.replace(/\/+$/, '')}/rest/v1/${path}`, {
		...init,
		headers: {
			apikey: env.SUPABASE_SERVICE_ROLE_KEY,
			Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
			'Content-Type': 'application/json',
			...(init.headers || {}),
		},
		signal: AbortSignal.timeout(8000),
	});
}

export function bootstrapOwners(env) {
	return (env.BOOTSTRAP_OWNER_EMAILS || '')
		.split(',')
		.map((s) => s.trim().toLowerCase())
		.filter(Boolean);
}

async function lookupRole(email, env) {
	// Owner khởi tạo (env) luôn là owner, để tránh bị khoá ngoài khi bảng admins còn trống.
	if (bootstrapOwners(env).includes(email)) return 'owner';

	if (!env.SUPABASE_SERVICE_ROLE_KEY) throw new HttpError(500, 'Server misconfigured');

	const hit = roleCache.get(email);
	if (hit && hit.exp > Date.now()) return hit.role;

	let res;
	try {
		res = await supabaseRest(env, `admins?email=eq.${encodeURIComponent(email)}&select=role,is_active&limit=1`);
	} catch {
		throw new HttpError(503, 'Không đọc được danh sách admin');
	}
	if (!res.ok) {
		console.error('lookupRole failed', res.status);
		throw new HttpError(503, 'Không đọc được danh sách admin');
	}
	const rows = await res.json();
	const row = rows[0];
	const role = row && row.is_active && ROLE_RANK[row.role] ? row.role : null;

	prune(roleCache);
	roleCache.set(email, { exp: Date.now() + ROLE_TTL_MS, role });
	return role;
}

export function invalidateRole(email) {
	roleCache.delete(email);
}

/** Trả { email, name, role } hoặc ném HttpError(401/403/5xx). */
export async function authenticate(request, env) {
	const token = bearer(request);
	if (!token) throw new HttpError(401, 'Thiếu access token');

	const user = await verifyToken(token, env);
	const email = String(user?.email || '').toLowerCase();
	const domain = (env.ALLOWED_EMAIL_DOMAIN || 'rever.vn').toLowerCase();

	if (!email || !email.endsWith(`@${domain}`)) throw new HttpError(403, 'Tài khoản không thuộc domain được phép');
	if (!user.email_confirmed_at) throw new HttpError(403, 'Email chưa được xác minh');

	const providers = user.app_metadata?.providers || [user.app_metadata?.provider];
	if (!providers.includes('google')) throw new HttpError(403, 'Chỉ chấp nhận đăng nhập bằng Google');

	const role = await lookupRole(email, env);
	if (!role) throw new HttpError(403, 'Tài khoản chưa được cấp quyền admin');

	return { email, name: user.user_metadata?.full_name || user.user_metadata?.name || '', role };
}

export function requireRole(admin, minRole) {
	if (ROLE_RANK[admin.role] < ROLE_RANK[minRole]) throw new HttpError(403, 'Không đủ quyền');
}
