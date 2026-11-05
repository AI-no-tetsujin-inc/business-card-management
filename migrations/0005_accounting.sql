-- 経理機能の統合: 顧客請求管理 / 社内請求・経費精算 / 契約・サブスク管理 / 設定

-- 設定（会社情報・Drive の親フォルダ・通知の送信元など）。画面から変更できる
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
-- Environment-specific records are configured privately after migration.

-- 顧客マスタ（送付・連絡の担当と手段）
CREATE TABLE customers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,                 -- 宛名（正式名称）
  company_key TEXT NOT NULL,          -- 名刺の会社とひも付けるキー
  owner_email TEXT NOT NULL,          -- 送付・連絡の担当（ログイン前でも決められるようメールで持つ）
  delivery_to TEXT NOT NULL DEFAULT '',   -- 送付先（Box / 共有Googleドライブ など）
  contact_via TEXT NOT NULL DEFAULT '',   -- 連絡手段（LINE / Googleチャット など）
  invoice_note TEXT NOT NULL DEFAULT '',  -- 請求書の備考に追加する文（注文番号など）
  memo TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT
);
-- Environment-specific records are configured privately after migration.

-- 見積書
CREATE TABLE quotes (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(id),
  number TEXT NOT NULL,
  issue_date TEXT NOT NULL,
  valid_until TEXT,
  subject TEXT NOT NULL,
  items TEXT NOT NULL DEFAULT '[]',   -- JSON [{name, qty, unit, unit_price}]（税抜）
  subtotal INTEGER NOT NULL DEFAULT 0,
  tax INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL DEFAULT 0,
  remarks TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'sent', 'accepted', 'rejected')),
  pdf_key TEXT,
  drive_file_id TEXT,
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT
);
CREATE INDEX idx_quotes_customer ON quotes(customer_id);

-- 契約（既存）を顧客マスタ・見積書とひも付け、請求書の明細の書き方を持たせる
ALTER TABLE contracts ADD COLUMN customer_id TEXT REFERENCES customers(id);
ALTER TABLE contracts ADD COLUMN quote_id TEXT REFERENCES quotes(id);
ALTER TABLE contracts ADD COLUMN item_name TEXT NOT NULL DEFAULT '';      -- 請求書の「内容」欄
ALTER TABLE contracts ADD COLUMN period_style TEXT NOT NULL DEFAULT 'month'; -- month = 「9月分」 / range = 「9/1〜9/30」

-- 旧「月ごとの請求（入金チェック）」は顧客請求書に置き換える（入金確認は税理士側で行うため不要）
DROP TABLE IF EXISTS invoices;

-- 顧客向け請求書（顧客・月ごとに1枚。明細は契約から作る）
CREATE TABLE customer_invoices (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(id),
  period TEXT NOT NULL,               -- 対象月 YYYY-MM
  number TEXT,
  issue_date TEXT,
  due_date TEXT,
  lines TEXT NOT NULL DEFAULT '[]',   -- JSON [{period_label, name, qty, unit_price, amount}]（税込）
  subtotal INTEGER NOT NULL DEFAULT 0,  -- 税抜
  tax INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL DEFAULT 0,     -- 税込
  note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'created', 'sent', 'contacted')),
  pdf_key TEXT,
  drive_file_id TEXT,
  created_at TEXT NOT NULL,
  created_by TEXT REFERENCES users(id),
  issued_at TEXT,                     -- 請求書（PDF）を作った日時
  issued_by TEXT REFERENCES users(id),
  sent_at TEXT,
  sent_by TEXT REFERENCES users(id),
  contacted_at TEXT,
  contacted_by TEXT REFERENCES users(id),
  imported INTEGER NOT NULL DEFAULT 0,  -- 過去分の取り込み
  UNIQUE (customer_id, period)
);
CREATE INDEX idx_customer_invoices_period ON customer_invoices(period);

-- 社内請求の提出者（請求書に載せる名前・振込先・番号の末尾）
CREATE TABLE internal_members (
  email TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  number_suffix TEXT NOT NULL,        -- 請求書番号の末尾（丙野 1、甲野 2）
  bank_text TEXT NOT NULL DEFAULT '',
  default_item TEXT NOT NULL DEFAULT '',
  default_unit_price INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);
-- Environment-specific records are configured privately after migration.

-- 社内請求（1人・1か月・種類ごと。work = 稼働分 / expense = 立替経費）
CREATE TABLE internal_claims (
  id TEXT PRIMARY KEY,
  member_email TEXT NOT NULL REFERENCES internal_members(email),
  period TEXT NOT NULL,               -- 稼働月 YYYY-MM（月末締め）
  kind TEXT NOT NULL CHECK (kind IN ('work', 'expense')),
  number TEXT NOT NULL,
  issue_date TEXT NOT NULL,
  due_date TEXT NOT NULL,             -- 翌月5日払い
  lines TEXT NOT NULL DEFAULT '[]',   -- work: [{name, qty, unit_price, amount}] / expense: [{date, purpose, amount}]
  subtotal INTEGER NOT NULL DEFAULT 0,
  tax INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted', 'paid')),
  pdf_key TEXT,
  drive_file_id TEXT,
  submitted_at TEXT NOT NULL,
  submitted_by TEXT REFERENCES users(id),
  paid_at TEXT,
  paid_by TEXT REFERENCES users(id),
  UNIQUE (member_email, period, kind)
);

-- 領収書（写真・PDF・JPG）。原本は後日手渡し
CREATE TABLE receipts (
  id TEXT PRIMARY KEY,
  member_email TEXT NOT NULL REFERENCES internal_members(email),
  file_key TEXT NOT NULL,
  file_name TEXT NOT NULL,
  mime TEXT NOT NULL,
  amount INTEGER NOT NULL,            -- 領収書の金額（原本と1円単位で一致させる）
  paid_on TEXT NOT NULL,              -- 領収書の日付
  vendor TEXT NOT NULL DEFAULT '',
  drive_file_id TEXT,
  original_submitted_at TEXT,         -- 原本提出済み
  original_checked_by TEXT REFERENCES users(id),
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL
);
CREATE INDEX idx_receipts_member ON receipts(member_email);

-- 立替経費の明細（日付・用途・金額）。請求に含めたら claim_id が入る
CREATE TABLE expense_items (
  id TEXT PRIMARY KEY,
  member_email TEXT NOT NULL REFERENCES internal_members(email),
  spent_on TEXT NOT NULL,
  purpose TEXT NOT NULL,
  amount INTEGER NOT NULL,
  receipt_id TEXT REFERENCES receipts(id),
  claim_id TEXT REFERENCES internal_claims(id),
  note TEXT NOT NULL DEFAULT '',
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL
);
CREATE INDEX idx_expense_items_member ON expense_items(member_email, claim_id);

-- 会社で契約しているサブスク・契約
CREATE TABLE subscriptions (
  id TEXT PRIMARY KEY,
  service_name TEXT NOT NULL,
  holder TEXT NOT NULL CHECK (holder IN ('company', 'personal')),           -- 契約名義
  payment_method TEXT NOT NULL CHECK (payment_method IN ('corporate_card', 'personal')), -- 支払い方法
  amount INTEGER,                     -- 金額（円）
  cycle TEXT NOT NULL CHECK (cycle IN ('monthly', 'yearly')),
  renewal_date TEXT,                  -- 次回更新日
  accounts TEXT NOT NULL DEFAULT '',  -- 利用アカウント・利用者
  admin_email TEXT NOT NULL DEFAULT '',
  migration_status TEXT NOT NULL DEFAULT 'none' CHECK (migration_status IN ('none', 'planned', 'done')),
  migration_month TEXT,               -- 名義移行の予定月 YYYY-MM
  note TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT
);
-- Environment-specific records are configured privately after migration.

-- Drive のフォルダ ID のキャッシュ（パス → ID）
CREATE TABLE drive_folders (
  path TEXT PRIMARY KEY,
  folder_id TEXT NOT NULL
);
