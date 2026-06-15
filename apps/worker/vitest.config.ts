import { defineConfig } from 'vitest/config';

// Pure-logic unit tests (SPEC §18.1) — plain node environment, no Workers
// runtime. Anything that needs bindings is exercised against the real
// deployment, not mocked here.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
