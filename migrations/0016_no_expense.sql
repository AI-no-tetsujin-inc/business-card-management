-- 社内請求: 「今月は立替経費なし」の申告（1人・1か月ごと）。経費の請求書を出さない月も「済み」にできるようにする
CREATE TABLE internal_no_expense (
  member_email TEXT NOT NULL REFERENCES internal_members(email),
  period TEXT NOT NULL,               -- 稼働月 YYYY-MM
  declared_at TEXT NOT NULL,
  declared_by TEXT REFERENCES users(id),
  PRIMARY KEY (member_email, period)
);
