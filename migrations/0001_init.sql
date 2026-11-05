-- 社員（Google Workspace アカウント）
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  google_sub TEXT UNIQUE,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL DEFAULT '',
  registered INTEGER NOT NULL DEFAULT 0, -- 初回の名前確認（アカウント登録）が済んだら 1
  created_at TEXT NOT NULL,
  last_login_at TEXT
);

-- ログイン状態（Cookie のトークンは SHA-256 で保存し、生の値は持たない）
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  expires_at INTEGER NOT NULL, -- epoch ms
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_sessions_user ON sessions(user_id);

-- 名刺（1人 = 1行。同じ人の名刺を別の社員が登録したら card_events に履歴が増える）
CREATE TABLE cards (
  id TEXT PRIMARY KEY,
  company_name TEXT NOT NULL DEFAULT '',
  company_key TEXT NOT NULL DEFAULT '',  -- 会社名の表記ゆれを吸収した並び替え・グループ用キー
  department TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  person_name TEXT NOT NULL DEFAULT '',
  person_key TEXT NOT NULL DEFAULT '',   -- 重複判定用（空白などを除いた氏名）
  person_name_kana TEXT NOT NULL DEFAULT '',
  person_name_en TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  mobile TEXT NOT NULL DEFAULT '',
  fax TEXT NOT NULL DEFAULT '',
  postal_code TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL DEFAULT '',
  other TEXT NOT NULL DEFAULT '',
  exchange_place TEXT NOT NULL DEFAULT '', -- 直近の交換場所・イベント名
  exchanged_on TEXT NOT NULL DEFAULT '',   -- 直近の交換日 YYYY-MM-DD
  tags TEXT NOT NULL DEFAULT '[]',         -- JSON 配列
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_by TEXT REFERENCES users(id),
  updated_at TEXT,
  deleted_by TEXT REFERENCES users(id),
  deleted_at TEXT
);
CREATE INDEX idx_cards_company ON cards(company_key);
CREATE INDEX idx_cards_email ON cards(email);
CREATE INDEX idx_cards_person ON cards(person_key);
CREATE INDEX idx_cards_deleted ON cards(deleted_at);

-- 名刺画像（交換のたびに追加。表示は side ごとの最新）
CREATE TABLE card_images (
  id TEXT PRIMARY KEY,
  card_id TEXT NOT NULL REFERENCES cards(id),
  side TEXT NOT NULL CHECK (side IN ('front', 'back')),
  full_key TEXT NOT NULL,     -- 元の解像度（位置情報などのメタデータは除去済み）
  display_key TEXT NOT NULL,  -- 表示・OCR 用の縮小版
  uploaded_by TEXT NOT NULL REFERENCES users(id),
  uploaded_at TEXT NOT NULL
);
CREATE INDEX idx_card_images_card ON card_images(card_id);

-- 履歴（新規登録 / 別の人が登録 / 情報更新 / 削除 / 復元）
CREATE TABLE card_events (
  id TEXT PRIMARY KEY,
  card_id TEXT NOT NULL REFERENCES cards(id),
  type TEXT NOT NULL CHECK (type IN ('created', 'exchanged', 'updated', 'deleted', 'restored')),
  user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '{}'  -- JSON: exchanged_on, exchange_place, updated_fields
);
CREATE INDEX idx_card_events_card ON card_events(card_id);

-- メモ（誰でも追加できる）
CREATE TABLE card_notes (
  id TEXT PRIMARY KEY,
  card_id TEXT NOT NULL REFERENCES cards(id),
  body TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);
CREATE INDEX idx_card_notes_card ON card_notes(card_id);

-- 確認待ち（OCR 済み・未登録）
CREATE TABLE drafts (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'discarded')),
  front_full_key TEXT NOT NULL,
  front_display_key TEXT NOT NULL,
  back_full_key TEXT,
  back_display_key TEXT,
  exchanged_on TEXT NOT NULL DEFAULT '',
  ocr TEXT,    -- JSON: { fields, review, comment, is_business_card }
  error TEXT,
  card_id TEXT REFERENCES cards(id),
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);
CREATE INDEX idx_drafts_status ON drafts(status);
