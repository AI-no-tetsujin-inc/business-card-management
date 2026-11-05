-- 段階2: 契約・請求・入金

CREATE TABLE contracts (
  id TEXT PRIMARY KEY,
  company_name TEXT NOT NULL,
  company_key TEXT NOT NULL,
  title TEXT NOT NULL,                 -- 契約内容（例: 月額保守、研修 全5回）
  amount INTEGER NOT NULL,             -- 1回あたりの請求額（円）
  cycle TEXT NOT NULL CHECK (cycle IN ('monthly', 'count', 'once')),
  count_total INTEGER,                 -- 回数契約の総回数
  start_month TEXT NOT NULL,           -- YYYY-MM（最初の請求月）
  end_month TEXT,                      -- YYYY-MM（月額契約の最終月。空なら継続中）
  owner_user_id TEXT REFERENCES users(id),
  memo TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'ended')),
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_by TEXT REFERENCES users(id),
  updated_at TEXT
);
CREATE INDEX idx_contracts_company ON contracts(company_key);

-- 月ごとの請求（契約から自動で作る）
CREATE TABLE invoices (
  id TEXT PRIMARY KEY,
  contract_id TEXT NOT NULL REFERENCES contracts(id),
  period TEXT NOT NULL,                -- YYYY-MM
  amount INTEGER NOT NULL,
  issued_on TEXT,                      -- 請求書を出した日
  issued_by TEXT REFERENCES users(id),
  paid_on TEXT,                        -- 入金日
  paid_by TEXT REFERENCES users(id),
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  UNIQUE (contract_id, period)
);
CREATE INDEX idx_invoices_period ON invoices(period);

-- 定期処理の実行記録（同じ通知を二重に送らないため）
CREATE TABLE job_runs (
  key TEXT PRIMARY KEY,                -- 例: billing-reminder:2026-10
  ran_at TEXT NOT NULL
);
