-- Google カレンダー連携: 各自が自分のカレンダーを連携すると、その人に関係する期限を終日の予定として入れる

CREATE TABLE calendar_links (
  user_email TEXT PRIMARY KEY,
  refresh_token_enc TEXT NOT NULL,       -- 暗号化した refresh_token（google_link と同じ方式）
  scopes TEXT NOT NULL,
  app_url TEXT NOT NULL DEFAULT '',      -- 予定の説明に載せるアプリの URL
  linked_at TEXT NOT NULL,
  last_sync_at TEXT,
  last_error TEXT,
  last_error_at TEXT
);

-- アプリが入れた予定（変わったものだけ更新し、要らなくなったものを消すため）
CREATE TABLE calendar_events (
  user_email TEXT NOT NULL,
  key TEXT NOT NULL,                     -- 予定の種類＋対象（例: claim-deadline:2026-10）
  event_id TEXT NOT NULL,
  hash TEXT NOT NULL,                    -- 内容が変わったかを見る
  date TEXT NOT NULL,
  PRIMARY KEY (user_email, key)
);
