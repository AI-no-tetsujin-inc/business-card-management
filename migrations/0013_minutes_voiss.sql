-- 議事録: Voiss（Mac の録音アプリ）から届く文字起こし・音声の受け取り、Drive への保存、目的別の抜き出し

-- 取り込んだ議事録に、どこから来たか・誰が録ったか・Drive の保存先を持たせる
ALTER TABLE documents ADD COLUMN source TEXT NOT NULL DEFAULT 'drive';   -- drive / paste / voiss
ALTER TABLE documents ADD COLUMN recorded_by TEXT REFERENCES users(id);
ALTER TABLE documents ADD COLUMN started_at TEXT;                        -- 録音を始めた日時（ISO 8601）
ALTER TABLE documents ADD COLUMN duration_sec INTEGER;
ALTER TABLE documents ADD COLUMN client_key TEXT;                        -- Voiss の録音ごとの ID（送り直しで二重にしない）
ALTER TABLE documents ADD COLUMN model TEXT NOT NULL DEFAULT '';         -- 文字起こしのモデル
ALTER TABLE documents ADD COLUMN title_auto INTEGER NOT NULL DEFAULT 0;  -- 1 = 仮のタイトル（抜き出した会議名に置き換える）
ALTER TABLE documents ADD COLUMN audio_key TEXT;                         -- R2 に置いた音声（Drive に保存したら消す）
ALTER TABLE documents ADD COLUMN audio_type TEXT;
ALTER TABLE documents ADD COLUMN drive_folder_id TEXT;
ALTER TABLE documents ADD COLUMN drive_text_id TEXT;
ALTER TABLE documents ADD COLUMN drive_audio_id TEXT;
ALTER TABLE documents ADD COLUMN notified_at TEXT;                       -- 議事録スペースに投稿した日時
CREATE UNIQUE INDEX idx_documents_client_key ON documents(client_key) WHERE client_key IS NOT NULL;
UPDATE documents SET source = 'paste' WHERE drive_file_id LIKE 'manual:%';

-- Voiss の連携キー（プロフィールで各自が発行。生の値は持たず SHA-256 だけ）
CREATE TABLE device_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL DEFAULT '',           -- 例: 甲野の MacBook
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT
);
CREATE INDEX idx_device_tokens_user ON device_tokens(user_id);

-- 目的別の抜き出し（ネクストアクションだけ・関係者への報告用・人が読む議事録・質問への答え）
CREATE TABLE minutes_views (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id),
  kind TEXT NOT NULL CHECK (kind IN ('next_actions', 'stakeholder_report', 'readable', 'question')),
  target TEXT NOT NULL DEFAULT '',         -- 報告先の相手・質問文
  body TEXT NOT NULL,
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL
);
CREATE INDEX idx_minutes_views_doc ON minutes_views(document_id, created_at);

-- つながり・確認依頼・重複判定・議事録からの新規人物の登録は、議事録と分けてオン・オフする（初期値オフ）
INSERT OR IGNORE INTO settings (key, value) VALUES ('feature_graph', '0');
