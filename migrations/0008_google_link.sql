-- Google 連携（甲野さんのアカウントで Drive への保存と Gmail 送信を行う。サービスアカウントの鍵は使わない）
-- refresh_token は GOOGLE_CLIENT_SECRET から作った鍵で暗号化して保存する
CREATE TABLE google_link (
  id TEXT PRIMARY KEY CHECK (id = 'main'),
  email TEXT NOT NULL,
  refresh_token_enc TEXT NOT NULL,
  scopes TEXT NOT NULL DEFAULT '',
  linked_at TEXT NOT NULL,
  linked_by TEXT REFERENCES users(id),
  last_error TEXT,
  last_error_at TEXT
);
