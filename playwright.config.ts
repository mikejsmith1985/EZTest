/**
 * Playwright configuration for EZTest's own test suite.
 * Tests are organized in layers: unit (fast, mocked) and integration (real filesystem/AI calls).
 */
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  timeout: 30_000,
  fullyParallel: true,
  forbidOnly: !!process.env['CI'],
  retries: process.env['CI'] ? 2 : 0,
  workers: process.env['CI'] ? 1 : undefined,
  reporter: 'html',
  use: {
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'unit',
      testDir: './tests/unit',
      timeout: 5_000,
    },
    {
      name: 'integration',
      testDir: './tests/integration',
      timeout: 60_000,
      // Integration tests share real resources (ports, filesystem) — must run serially
      workers: 1,
      fullyParallel: false,
    },
    {
      // Runs AI-generated reproduction and validation tests against a live application.
      name: 'e2e',
      testDir: './tests',
      testMatch: /\/(reproductions|validations)\/.+\.spec\.(ts|js)$/,
      timeout: 60_000,
      use: {
        headless: true,
      },
    },
  ],
});
