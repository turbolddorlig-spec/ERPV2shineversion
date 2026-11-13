-- Аудит #148: банкны хайлт (утга — trigram, утас — урд хэсгээр), 24 цагийн автомат тааруулалт
CREATE INDEX IF NOT EXISTS "BankTransaction_description_trgm" ON "BankTransaction" USING gin (description gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "BankTransaction_phone_pattern" ON "BankTransaction" (phone text_pattern_ops);
CREATE INDEX IF NOT EXISTS "BankTransaction_unmatched_phone" ON "BankTransaction" (phone, "txDate") WHERE status = 'UNMATCHED' AND "isDuplicate" = false AND refunded = false;
