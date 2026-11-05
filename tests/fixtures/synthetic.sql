INSERT OR IGNORE INTO users(id,email,name,registered,created_at,role) VALUES
('staff-a','staff-a@example.com','甲野一郎',0,'2026-10-16','admin'),
('staff-b','staff-b@example.com','乙野二郎',0,'2026-10-16','member'),
('staff-c','staff-c@example.com','丙野三郎',0,'2026-10-16','member');
INSERT OR REPLACE INTO settings(key,value) VALUES ('drive_parent_id','test-drive-folder'),('feature_minutes','0');
INSERT INTO customers(id,name,company_key,owner_email,created_at) VALUES ('customer-a','テスト顧客A','テスト顧客A','staff-b@example.com','2026-10-16'),('customer-b','テスト顧客B','テスト顧客B','staff-b@example.com','2026-10-16'),('customer-c','テスト顧客C','テスト顧客C','staff-c@example.com','2026-10-16');
INSERT INTO internal_members(email,display_name,number_suffix,bank_text,default_item,default_unit_price) VALUES ('staff-a@example.com','甲野一郎','2','テスト口座','テスト稼働{M}月',100),('staff-c@example.com','丙野三郎','1','','テスト稼働{M}月',0);

INSERT INTO contracts(id,customer_id,company_name,company_key,title,item_name,amount,cycle,start_month,status,created_by,created_at) VALUES ('test-contract-a','customer-a','テスト顧客A','テスト顧客A','テスト契約A','テスト支援',100,'monthly','2026-01','active','staff-a','2026-01-01'),('test-contract-b','customer-b','テスト顧客B','テスト顧客B','テスト契約B','テスト支援',200,'monthly','2026-01','active','staff-a','2026-01-01');

INSERT OR REPLACE INTO settings(key,value) VALUES ('billing_admin_email','staff-a@example.com'),('claim_payer_email','staff-b@example.com'),('app_url','https://meishi.example');
