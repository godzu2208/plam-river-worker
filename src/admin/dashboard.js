// Truy vấn dashboard từ D1 (bảng events). Múi giờ hiển thị: Việt Nam (UTC+7).

import { HttpError } from '../lib/http.js';

const DAY_MS = 86_400_000;
const VN_OFFSET_SEC = 7 * 3600;
const MAX_RANGE_DAYS = 90;

function vnDate(ms) {
	return new Date(ms + VN_OFFSET_SEC * 1000).toISOString().slice(0, 10);
}

function parseRange(params) {
	const re = /^\d{4}-\d{2}-\d{2}$/;
	const today = vnDate(Date.now());
	let to = params.get('to') || today;
	let from = params.get('from') || vnDate(Date.now() - 6 * DAY_MS);
	if (!re.test(from) || !re.test(to)) throw new HttpError(400, 'from/to phải có dạng YYYY-MM-DD');

	const start = Date.parse(`${from}T00:00:00+07:00`);
	const end = Date.parse(`${to}T00:00:00+07:00`) + DAY_MS;
	if (Number.isNaN(start) || Number.isNaN(end) || end <= start) throw new HttpError(400, 'Khoảng ngày không hợp lệ');
	if (end - start > MAX_RANGE_DAYS * DAY_MS) throw new HttpError(400, `Tối đa ${MAX_RANGE_DAYS} ngày`);
	return { from, to, start, end };
}

export async function getDashboard(env, params) {
	if (!env.DB) throw new HttpError(500, 'Server misconfigured');
	const { from, to, start, end } = parseRange(params);
	const W = 'WHERE ts >= ?1 AND ts < ?2';
	const q = (sql) => env.DB.prepare(sql).bind(start, end);

	const results = await env.DB.batch([
		q(`SELECT
				COALESCE(SUM(type = 'pageview'), 0) AS pageviews,
				COUNT(DISTINCT visitor_id) AS visitors,
				COUNT(DISTINCT session_id) AS sessions,
				COALESCE(SUM(type = 'lead'), 0) AS leads,
				COUNT(DISTINCT CASE WHEN type = 'lead' THEN session_id END) AS converted_sessions,
				COUNT(DISTINCT CASE WHEN type = 'form_start' THEN session_id END) AS form_start_sessions,
				COALESCE(SUM(type = 'cta_click'), 0) AS cta_clicks
			FROM events ${W}`),
		q(`SELECT date(ts / 1000 + ${VN_OFFSET_SEC}, 'unixepoch') AS day,
				COALESCE(SUM(type = 'pageview'), 0) AS pageviews,
				COUNT(DISTINCT session_id) AS sessions,
				COALESCE(SUM(type = 'lead'), 0) AS leads
			FROM events ${W} GROUP BY day ORDER BY day`),
		q(`SELECT channel,
				COUNT(DISTINCT session_id) AS sessions,
				COUNT(DISTINCT visitor_id) AS visitors,
				COALESCE(SUM(type = 'lead'), 0) AS leads
			FROM events ${W} GROUP BY channel ORDER BY sessions DESC`),
		q(`SELECT COALESCE(utm_source, '') AS utm_source, COALESCE(utm_medium, '') AS utm_medium, utm_campaign,
				COUNT(DISTINCT session_id) AS sessions,
				COALESCE(SUM(type = 'lead'), 0) AS leads
			FROM events ${W} AND utm_campaign IS NOT NULL AND utm_campaign <> ''
			GROUP BY utm_source, utm_medium, utm_campaign ORDER BY sessions DESC LIMIT 20`),
		q(`SELECT label, COUNT(DISTINCT session_id) AS sessions
			FROM events ${W} AND type = 'section_view' GROUP BY label ORDER BY sessions DESC`),
		q(`SELECT label, COUNT(DISTINCT session_id) AS sessions
			FROM events ${W} AND type = 'scroll' GROUP BY label ORDER BY CAST(label AS INTEGER)`),
		q(`SELECT label, COUNT(*) AS clicks, COUNT(DISTINCT session_id) AS sessions
			FROM events ${W} AND type = 'cta_click' GROUP BY label ORDER BY clicks DESC LIMIT 20`),
		q(`SELECT label,
				COUNT(DISTINCT CASE WHEN type = 'form_start' THEN session_id END) AS starts,
				COUNT(DISTINCT CASE WHEN type = 'lead' THEN session_id END) AS leads
			FROM events ${W} AND type IN ('form_start', 'lead') GROUP BY label ORDER BY starts DESC`),
		q(`SELECT path, COUNT(*) AS pageviews, COUNT(DISTINCT session_id) AS sessions
			FROM events ${W} AND type = 'pageview' GROUP BY path ORDER BY pageviews DESC LIMIT 10`),
	]);

	const [totals, daily, channels, campaigns, sections, scroll, cta, forms, paths] = results.map((r) => r.results);
	const t = totals[0] || {};
	const conversionRate = t.sessions ? Number(((t.converted_sessions / t.sessions) * 100).toFixed(2)) : 0;

	return {
		range: { from, to, timezone: 'Asia/Ho_Chi_Minh' },
		totals: { ...t, conversion_rate_pct: conversionRate },
		daily,
		channels,
		campaigns,
		sections,
		scroll,
		cta,
		forms,
		paths,
	};
}
