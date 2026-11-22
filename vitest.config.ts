import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // GreenMail container start-up and image pull can take a while on first run.
    hookTimeout: 180_000,
    testTimeout: 30_000,
  },
});
