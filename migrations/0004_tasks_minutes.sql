-- 段階3〜5: タスク、議事録の取り込み、抽出した知識（関係性・決定事項・案件・やり取り）、確認キュー

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  assignee_user_id TEXT REFERENCES users(id),
  assignee_name TEXT NOT NULL DEFAULT '',   -- 社員に当てはまらない担当者名（議事録の表記のまま）
  due_on TEXT,                              -- YYYY-MM-DD
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done')),
  done_at TEXT,
  done_by TEXT REFERENCES users(id),
  card_id TEXT REFERENCES cards(id),        -- 関係する人物
  company_name TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'web',       -- web / ai:Claude / minutes
  document_id TEXT,
  confidence REAL,
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  reminded_on TEXT
);
CREATE INDEX idx_tasks_status ON tasks(status, due_on);
CREATE INDEX idx_tasks_assignee ON tasks(assignee_user_id);

-- 取り込んだ議事録（Drive のファイル）
CREATE TABLE documents (
  id TEXT PRIMARY KEY,
  drive_file_id TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  modified_time TEXT NOT NULL,              -- Drive の更新日時（変わったら取り込み直す）
  meeting_date TEXT,
  summary TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'done', 'failed', 'skipped')),
  error TEXT,
  stats TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  processed_at TEXT
);

-- 案件
CREATE TABLE deals (
  id TEXT PRIMARY KEY,
  company_name TEXT NOT NULL,
  company_key TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT '',
  amount TEXT NOT NULL DEFAULT '',
  document_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT
);
CREATE UNIQUE INDEX idx_deals_key ON deals(company_key, name);

-- 決定事項
CREATE TABLE decisions (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  text TEXT NOT NULL,
  company_name TEXT NOT NULL DEFAULT '',
  company_key TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

-- 過去のやり取り（会議に出た、名刺を交換した など）
CREATE TABLE interactions (
  id TEXT PRIMARY KEY,
  card_id TEXT NOT NULL REFERENCES cards(id),
  happened_on TEXT,
  kind TEXT NOT NULL,                       -- meeting / email / other
  summary TEXT NOT NULL,
  document_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_interactions_card ON interactions(card_id);

-- つながり（関係性マップの線）。node = person:<card_id> / company:<company_key> / deal:<deal_id>
CREATE TABLE relations (
  id TEXT PRIMARY KEY,
  from_node TEXT NOT NULL,
  to_node TEXT NOT NULL,
  kind TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  document_id TEXT,
  confidence REAL NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_relations_from ON relations(from_node);
CREATE INDEX idx_relations_to ON relations(to_node);

-- 人に確認してほしいもの（統合候補、新しい人物の候補、データの誤りの疑い）
CREATE TABLE review_items (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('merge', 'new_person', 'fix')),
  card_id TEXT REFERENCES cards(id),
  other_card_id TEXT REFERENCES cards(id),
  document_id TEXT,
  reason TEXT NOT NULL,
  confidence REAL,
  suggestion TEXT NOT NULL DEFAULT '{}',    -- JSON（修正案・新しい人物の項目など）
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'approved', 'rejected')),
  created_at TEXT NOT NULL,
  resolved_by TEXT REFERENCES users(id),
  resolved_at TEXT
);
CREATE INDEX idx_review_items_status ON review_items(status);

-- AI による重複判定の記録（同じ組み合わせを何度も判定しない）
CREATE TABLE merge_judgements (
  pair_key TEXT PRIMARY KEY,                -- 小さい ID + ':' + 大きい ID
  verdict TEXT NOT NULL,                    -- same / different / unsure
  confidence REAL NOT NULL,
  reason TEXT NOT NULL,
  decided_at TEXT NOT NULL
);

-- 統合された名刺の行き先、AI 検証済みの印
ALTER TABLE cards ADD COLUMN merged_into TEXT;
ALTER TABLE cards ADD COLUMN verified_at TEXT;

-- 議事録の自動取り込みで作られたデータの「登録者」（ログイン不可のシステム用ユーザー）
INSERT OR IGNORE INTO users (id, google_sub, email, name, registered, created_at, role, active)
  VALUES ('system', NULL, 'system@meishi.internal', '自動取り込み', 0, '2026-10-15T00:00:00.000Z', 'viewer', 0);
