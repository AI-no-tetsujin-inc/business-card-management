-- 取引先の組織図: 会社の中の本部・部・課・店舗・支社などのまとまりと、人がどこに属し誰の下にいるか
CREATE TABLE org_units (
  id TEXT PRIMARY KEY,
  company_key TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'dept' CHECK (kind IN ('hq', 'dept', 'store', 'branch', 'team', 'other')), -- 本部 / 部署 / 店舗 / 支社・支店 / チーム / その他
  parent_id TEXT REFERENCES org_units(id),   -- NULL = 会社の直下
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT
);
CREATE INDEX idx_org_units_company ON org_units(company_key, parent_id);

-- 人がどのまとまりにいるか・誰の下か（NULL = まだ決まっていない）
ALTER TABLE cards ADD COLUMN org_unit_id TEXT REFERENCES org_units(id);
ALTER TABLE cards ADD COLUMN reports_to TEXT REFERENCES cards(id);
CREATE INDEX idx_cards_org_unit ON cards(org_unit_id);
