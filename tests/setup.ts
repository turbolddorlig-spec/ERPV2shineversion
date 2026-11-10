// Тестийг ЗӨВХӨН тусдаа тест database дээр ажиллуулна
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? 'postgresql://app:app_password@localhost:5432/erp_v2_test?schema=public';
if (!/test/.test(process.env.DATABASE_URL)) throw new Error('Тест зөвхөн *test* database дээр ажиллана');
