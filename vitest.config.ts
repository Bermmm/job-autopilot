import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // Fetchers and LLM calls are always stubbed in tests; nothing here should
    // touch the network or a real API key.
    env: { NODE_ENV: 'test' },
  },
});
