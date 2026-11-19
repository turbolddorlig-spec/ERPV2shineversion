-- #183: database-ийн цагийн бүс заавал UTC. Огноонууд "timestamp" (бүсгүй, UTC) хэлбэрээр хадгалагддаг тул сесс өөр бүстэй
-- (docker-compose TZ=Asia/Ulaanbaatar) бол raw SQL-ийн харьцуулалт 8 цагаар зөрдөг байв («Өнөөдөр: 0», хянах самбар 0).
-- Шинэ холболт бүрт үйлчилнэ (апп дахин асахад).
DO $$ BEGIN EXECUTE format('ALTER DATABASE %I SET timezone TO %L', current_database(), 'UTC'); END $$;
