-- Cloudflare D1: analytics events + audit log
-- Áp dụng:  npx wrangler d1 migrations apply palm-river-analytics --remote

CREATE TABLE IF NOT EXISTS events (
	id           INTEGER PRIMARY KEY AUTOINCREMENT,
	ts           INTEGER NOT NULL,              -- thời điểm event (ms, đã bù lệch đồng hồ client)
	received_at  INTEGER NOT NULL,              -- thời điểm Worker nhận (ms)
	type         TEXT    NOT NULL,              -- pageview|scroll|section_view|cta_click|form_start|lead|leave
	visitor_id   TEXT    NOT NULL,
	session_id   TEXT    NOT NULL,
	path         TEXT    NOT NULL,
	label        TEXT    NOT NULL DEFAULT '',   -- scroll: 25/50/75/100; section_view: tên section; cta_click/form_start/lead: nhãn
	channel      TEXT    NOT NULL DEFAULT 'direct',
	utm_source   TEXT,
	utm_medium   TEXT,
	utm_campaign TEXT,
	referrer     TEXT,                          -- chỉ hostname
	country      TEXT,
	-- chống trùng khi client retry / gửi lại batch
	UNIQUE (session_id, type, ts, path, label)
);

CREATE INDEX IF NOT EXISTS idx_events_ts           ON events (ts);
CREATE INDEX IF NOT EXISTS idx_events_type_ts      ON events (type, ts);
CREATE INDEX IF NOT EXISTS idx_events_channel_ts   ON events (channel, ts);
CREATE INDEX IF NOT EXISTS idx_events_session      ON events (session_id);

CREATE TABLE IF NOT EXISTS audit_log (
	id     INTEGER PRIMARY KEY AUTOINCREMENT,
	ts     INTEGER NOT NULL,
	actor  TEXT    NOT NULL,   -- email admin
	action TEXT    NOT NULL,   -- leads.export | admin.upsert | admin.update
	detail TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log (ts);