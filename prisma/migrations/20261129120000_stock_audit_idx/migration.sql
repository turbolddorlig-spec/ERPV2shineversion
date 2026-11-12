-- Аудит #143: барааны хайлт (өнгө) ба хөдөлгөөний түүх «төрлөөр» — индекс
CREATE INDEX IF NOT EXISTS "ProductVariant_color_trgm" ON "ProductVariant" USING gin (color gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "StockMove_type_id_idx" ON "StockMove" (type, id DESC);
