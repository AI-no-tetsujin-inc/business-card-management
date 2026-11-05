-- 同じ人が別の会社にも所属している（転職・兼務・グループ会社）場合、会社ごとの名刺は分けたまま「同じ人」としてまとめる
ALTER TABLE cards ADD COLUMN person_group TEXT;
CREATE INDEX idx_cards_person_group ON cards(person_group) WHERE person_group IS NOT NULL;
