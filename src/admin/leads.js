// Đọc lead (chỉ đọc) từ Apps Script Admin endpoint -> lọc/phân trang/CSV trong Worker.
// Apps Script chỉ đọc RAW_LEAD; không sửa lead. Xem apps-script/AdminApi.gs.

import { HttpError } from '../lib/http.js';

const CACHE_TTL_MS = 30_000;
const MAX_EXPORT_ROWS = 50_000;
const TIME_KEYS = ['submitted_at', 'created_at', 'timestamp', 'time', 'thời gian'];
const FILTER_KEYS = ['form_type', 'utm_source', 'utm_medium', 'utm_campaign'];

let cache = null; // { exp, rows }

async function fetchAllLeads(env) {
	if (cache && cache.exp > Date.now()) return cache.rows;
	if (!env.GOOGLE_ADMIN_URL || !env.GOOGLE_ADMIN_SECRET) throw new HttpError(500, 'Server misconfigured');

	const url = new URL(env.GOOGLE_ADMIN_URL);
	url.searchParams.set('action', 'leads');
	url.searchParams.set('secret', env.GOOGLE_ADMIN_SECRET);

	let res;
	try {
		res = await fetch(url.toString(), { redirect: 'follow', signal: AbortSignal.timeout(20_000) });
	} catch {
		throw new HttpError(502, 'Không kết nối được nguồn dữ liệu lead');
	}
	if (!res.ok) throw new HttpError(502, 'Nguồn dữ liệu lead trả lỗi');

	let data;
	try {
		data = await res.json();
	} catch {
		throw new HttpError(502, 'Nguồn dữ liệu lead trả dữ liệu không hợp lệ');
	}
	if (!data || data.ok !== true || !Array.isArray(data.rows)) {
		throw new HttpError(502, 'Nguồn dữ liệu lead từ chối yêu cầu');
	}

	cache = { exp: Date.now() + CACHE_TTL_MS, rows: data.rows };
	return data.rows;
}

function findKey(row, candidates) {
	const keys = Object.keys(row || {});
	for (const c of candidates) {
		const k = keys.find((x) => x.trim().toLowerCase() === c);
		if (k) return k;
	}
	return null;
}

const VN_OFFSET = '+07:00';
function dayStart(s) {
	return /^\d{4}-\d{2}-\d{2}$/.test(s || '') ? Date.parse(`${s}T00:00:00${VN_OFFSET}`) : NaN;
}

function filterRows(rows, params) {
	const timeKey = rows.length ? findKey(rows[0], TIME_KEYS) : null;
	const from = dayStart(params.get('from'));
	const toRaw = dayStart(params.get('to'));
	const to = Number.isNaN(toRaw) ? NaN : toRaw + 86_400_000;
	const q = (params.get('q') || '').trim().toLowerCase();

	const exact = [];
	for (const name of FILTER_KEYS) {
		const want = (params.get(name) || '').trim().toLowerCase();
		if (want) exact.push([name, want]);
	}

	let out = rows.filter((row) => {
		if (timeKey && (!Number.isNaN(from) || !Number.isNaN(to))) {
			const t = Date.parse(row[timeKey]);
			if (Number.isNaN(t)) return false;
			if (!Number.isNaN(from) && t < from) return false;
			if (!Number.isNaN(to) && t >= to) return false;
		}
		for (const [name, want] of exact) {
			const k = findKey(row, [name]);
			if (
				!k ||
				String(row[k] ?? '')
					.trim()
					.toLowerCase() !== want
			)
				return false;
		}
		if (
			q &&
			!Object.values(row).some((v) =>
				String(v ?? '')
					.toLowerCase()
					.includes(q),
			)
		)
			return false;
		return true;
	});

	// Mới nhất trước: theo cột thời gian nếu có, nếu không thì đảo thứ tự dòng trong sheet.
	if (timeKey) out = out.sort((a, b) => (Date.parse(b[timeKey]) || 0) - (Date.parse(a[timeKey]) || 0));
	else out = out.slice().reverse();
	return out;
}

export async function listLeads(env, params) {
	const rows = filterRows(await fetchAllLeads(env), params);
	const pageSize = Math.min(100, Math.max(1, Number(params.get('pageSize')) || 25));
	const total = rows.length;
	const pages = Math.max(1, Math.ceil(total / pageSize));
	const page = Math.min(pages, Math.max(1, Number(params.get('page')) || 1));
	return { total, page, pageSize, pages, rows: rows.slice((page - 1) * pageSize, page * pageSize) };
}

// Chống CSV/Excel formula injection: ô bắt đầu bằng = + - @ (hoặc tab/CR) thì thêm dấu nháy.
function csvCell(v) {
	let s = v == null ? '' : String(v);
	if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
	return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export async function exportLeadsCsv(env, params) {
	const rows = filterRows(await fetchAllLeads(env), params).slice(0, MAX_EXPORT_ROWS);
	const headers = [];
	const seen = new Set();
	for (const r of rows) {
		for (const k of Object.keys(r)) {
			if (!seen.has(k)) {
				seen.add(k);
				headers.push(k);
			}
		}
	}
	const lines = [headers.map(csvCell).join(',')];
	for (const r of rows) lines.push(headers.map((h) => csvCell(r[h])).join(','));
	// BOM để Excel đọc đúng tiếng Việt.
	return { csv: `﻿${lines.join('\r\n')}\r\n`, count: rows.length };
}
