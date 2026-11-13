-- Аудит #147: «Өгсөн» (жолооч хүлээн аваагүй) падаан — нөөцлөлт, 2 цагийн анхааруулга
CREATE INDEX IF NOT EXISTS "Handover_handed_over_idx" ON "Handover" ("handedOverAt") WHERE status = 'HANDED_OVER';
