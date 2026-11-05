-- 人物像（ステークホルダー情報）: 立場・温度感・今の状況・性格・関心・気をつけること・人間関係
-- Claude のスキルで文字起こしなどから振り分けた情報を取り込む。人がはっきりしないもの・自信が低いものは確認待ちにする
CREATE TABLE person_insights (
  id TEXT PRIMARY KEY,
  card_id TEXT REFERENCES cards(id),            -- NULL = まだ人が決まっていない（確認待ち）
  suggested_card_id TEXT REFERENCES cards(id),  -- 確認待ちのときの「この人かもしれない」
  category TEXT NOT NULL CHECK (category IN ('role', 'attitude', 'status', 'personality', 'interest', 'caution', 'relation', 'other')),
  body TEXT NOT NULL,
  evidence TEXT NOT NULL DEFAULT '',            -- 根拠となる発言の引用
  happened_on TEXT,                             -- いつの情報か（会議の日付など）
  source_title TEXT NOT NULL DEFAULT '',        -- どの会議・資料から
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'skill', 'ai')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'pending', 'dismissed')),
  suggested_name TEXT NOT NULL DEFAULT '',
  suggested_company TEXT NOT NULL DEFAULT '',
  confidence REAL NOT NULL DEFAULT 1,
  import_id TEXT,
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL
);
CREATE INDEX idx_person_insights_card ON person_insights(card_id, category);
CREATE INDEX idx_person_insights_status ON person_insights(status);
