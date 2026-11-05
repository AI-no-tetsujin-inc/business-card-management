-- 段階1: MCP 連携・統合ルール・操作ログ・AI 利用ログ

-- 権限（admin / member / viewer）と有効・無効
ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'member';
ALTER TABLE users ADD COLUMN active INTEGER NOT NULL DEFAULT 1;
-- 既存ユーザーのうち最初に登録した人を管理者にする
UPDATE users SET role = 'admin' WHERE id = (SELECT id FROM users ORDER BY created_at LIMIT 1);

-- メモの経路（web / ai:Claude / ai:ChatGPT など）
ALTER TABLE card_notes ADD COLUMN source TEXT NOT NULL DEFAULT 'web';

-- 統合ルール用の連絡先（正規化したメール・電話番号）
CREATE TABLE contact_points (
  card_id TEXT NOT NULL REFERENCES cards(id),
  kind TEXT NOT NULL CHECK (kind IN ('email', 'phone')),
  value_key TEXT NOT NULL,
  PRIMARY KEY (card_id, kind, value_key)
);
CREATE INDEX idx_contact_points_value ON contact_points(kind, value_key);

INSERT OR IGNORE INTO contact_points (card_id, kind, value_key)
  SELECT id, 'email', lower(trim(email)) FROM cards WHERE trim(email) != '';
INSERT OR IGNORE INTO contact_points (card_id, kind, value_key)
  SELECT id, 'phone', replace(replace(replace(replace(replace(phone, '-', ''), ' ', ''), '(', ''), ')', ''), '+', '')
    FROM cards WHERE trim(phone) != '';
INSERT OR IGNORE INTO contact_points (card_id, kind, value_key)
  SELECT id, 'phone', replace(replace(replace(replace(replace(mobile, '-', ''), ' ', ''), '(', ''), ')', ''), '+', '')
    FROM cards WHERE trim(mobile) != '';

-- 操作ログ（誰が・いつ・どこから・何を）
CREATE TABLE audit_logs (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id),
  via TEXT NOT NULL,          -- web / ai:Claude / ai:ChatGPT / cron
  action TEXT NOT NULL,       -- view / search / create / update / delete / restore / export / note / login / connect
  target_type TEXT,
  target_id TEXT,
  detail TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX idx_audit_logs_created ON audit_logs(created_at);
CREATE INDEX idx_audit_logs_user ON audit_logs(user_id);

-- AI 利用ログ（Claude API の呼び出しごと）
CREATE TABLE ai_usage (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  purpose TEXT NOT NULL,      -- ocr / minutes / dedupe / verify
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  user_id TEXT REFERENCES users(id)
);
CREATE INDEX idx_ai_usage_created ON ai_usage(created_at);

-- AI 経由で登録した名刺に、あとから画像を付けるための使い捨てリンク
CREATE TABLE upload_links (
  token_hash TEXT PRIMARY KEY,
  card_id TEXT NOT NULL REFERENCES cards(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  expires_at INTEGER NOT NULL,  -- epoch ms
  used_at TEXT
);
