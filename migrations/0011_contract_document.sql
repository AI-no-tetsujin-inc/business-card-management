-- 契約書（PDF）を契約にひも付けて保存する（アプリ内の控え＋ Google Drive の 契約書/顧客名）
ALTER TABLE contracts ADD COLUMN document_key TEXT;
ALTER TABLE contracts ADD COLUMN document_name TEXT;
ALTER TABLE contracts ADD COLUMN document_drive_id TEXT;
