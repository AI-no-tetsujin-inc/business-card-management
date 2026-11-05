-- 確認待ちの連続撮影・あとで確認・下書き保存・重複防止
ALTER TABLE drafts ADD COLUMN client_key TEXT;            -- 端末が撮影ごとに振る ID（再送・連打で同じ名刺を二重に作らない）
ALTER TABLE drafts ADD COLUMN processing_started_at TEXT; -- 読み取りを始めた時刻（止まったものを拾い直す・二重に読み取らない）
ALTER TABLE drafts ADD COLUMN locked_at TEXT;             -- 登録処理中（連打・一括登録の重複を防ぐ）
ALTER TABLE drafts ADD COLUMN deferred_at TEXT;           -- 「あとで確認」にした時刻
ALTER TABLE drafts ADD COLUMN edited TEXT;                -- 確認画面で直している途中の内容（JSON。画面を離れても失わない）
ALTER TABLE drafts ADD COLUMN edited_at TEXT;
CREATE UNIQUE INDEX idx_drafts_client_key ON drafts(client_key) WHERE client_key IS NOT NULL;
