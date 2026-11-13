import { defineConfig } from 'vitest/config';
import path from 'node:path';

/** Том сценарийн тест (#156): бүтэн ажлын өдөр, бүх модулийн уялдаа — `npm run test:sim` (тусдаа database) */
export default defineConfig({
  test: { include: ['tests/sim/**/*.test.ts'], environment: 'node', fileParallelism: false, setupFiles: ['tests/setup.ts'], testTimeout: 900_000, hookTimeout: 120_000 },
  resolve: { alias: { '@': path.resolve(__dirname) } },
});
