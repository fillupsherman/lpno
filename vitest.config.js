import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    passWithNoTests: true,
    include: ['js/**/*.test.js', 'worker/**/*.test.js', 'fb-sync/**/*.test.js'],
    coverage: {
      provider: 'v8',
      include: ['js/**/*.js', 'worker/index.js'],
      exclude: ['**/*.test.js']
    }
  }
});
