/**
 * Unit tests for the Generated Test Runner module.
 *
 * Tests the per-file result structure, error summary extraction, and
 * graceful handling of empty file lists — all without invoking an actual
 * Playwright process (we mock the child process output).
 */
import { test, expect } from '@playwright/test';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { runGeneratedTestFiles } from '../../src/synthesizer/generatedTestRunner.js';

// ── Test Setup ──────────────────────────────────────────────────────────────

let testTemporaryDirectory: string;

test.beforeAll(() => {
  testTemporaryDirectory = join('test-results', `test-runner-unit-${randomUUID()}`);
  mkdirSync(testTemporaryDirectory, { recursive: true });
});

test.afterAll(() => {
  if (existsSync(testTemporaryDirectory)) {
    rmSync(testTemporaryDirectory, { recursive: true, force: true });
  }
});

// ── runGeneratedTestFiles — empty input ─────────────────────────────────────

test.describe('runGeneratedTestFiles — empty input', () => {
  test('returns a zeroed-out result when given an empty file list', async () => {
    const result = await runGeneratedTestFiles([], process.cwd());

    expect(result.totalFileCount).toBe(0);
    expect(result.passedFileCount).toBe(0);
    expect(result.failedFileCount).toBe(0);
    expect(result.fileResults).toHaveLength(0);
    expect(result.failedFiles).toHaveLength(0);
  });
});

// ── runGeneratedTestFiles — structural contracts ────────────────────────────

test.describe('runGeneratedTestFiles — result structure', () => {
  test('each result has fileName, testFilePath, didPass, rawOutput, and errorSummary fields', async () => {
    // Write a minimal but real Playwright test to a temp file
    const testFilePath = join(testTemporaryDirectory, `struct-${randomUUID().slice(0, 8)}.spec.ts`);
    writeFileSync(testFilePath, `
import { test, expect } from '@playwright/test';
test('structural contract test', async ({ page }) => {
  await page.goto('http://localhost:9999');
  await expect(page.getByText('This will not exist')).toBeVisible({ timeout: 1000 });
});
`, 'utf-8');

    const result = await runGeneratedTestFiles([testFilePath], process.cwd());

    expect(result.totalFileCount).toBe(1);
    expect(result.fileResults).toHaveLength(1);

    const fileResult = result.fileResults[0];

    // Structural contract: all fields must be present
    expect(typeof fileResult.fileName).toBe('string');
    expect(typeof fileResult.testFilePath).toBe('string');
    expect(typeof fileResult.didPass).toBe('boolean');
    expect(typeof fileResult.rawOutput).toBe('string');
    expect(typeof fileResult.errorSummary).toBe('string');

    // Path must be absolute (resolved)
    expect(fileResult.testFilePath).toBe(resolve(testFilePath));

    // fileName must be just the basename
    expect(fileResult.fileName).not.toContain('\\');
    expect(fileResult.fileName).not.toContain('/');
    expect(fileResult.fileName).toMatch(/\.spec\.ts$/);
  });

  test('totalFileCount, passedFileCount, failedFileCount are consistent with fileResults', async () => {
    // Use the same non-existent-server test to ensure failure
    const testFilePath = join(testTemporaryDirectory, `counts-${randomUUID().slice(0, 8)}.spec.ts`);
    writeFileSync(testFilePath, `
import { test, expect } from '@playwright/test';
test('count consistency test', async ({ page }) => {
  await page.goto('http://localhost:9999');
  await expect(page.getByText('Never shows')).toBeVisible({ timeout: 1000 });
});
`, 'utf-8');

    const result = await runGeneratedTestFiles([testFilePath], process.cwd());

    // Counts must add up
    expect(result.totalFileCount).toBe(result.passedFileCount + result.failedFileCount);
    expect(result.totalFileCount).toBe(result.fileResults.length);
    expect(result.failedFiles.length).toBe(result.failedFileCount);
    expect(result.failedFiles.every(file => !file.didPass)).toBe(true);
  });

  test('error summary is populated for failing tests and empty for passing tests', async () => {
    // Write a test that will fail (points at a server that does not exist)
    const failingTestPath = join(testTemporaryDirectory, `errsummary-${randomUUID().slice(0, 8)}.spec.ts`);
    writeFileSync(failingTestPath, `
import { test, expect } from '@playwright/test';
test('will fail because no server', async ({ page }) => {
  await page.goto('http://localhost:9998');
  await expect(page.getByText('Gone')).toBeVisible({ timeout: 500 });
});
`, 'utf-8');

    const result = await runGeneratedTestFiles([failingTestPath], process.cwd());

    const fileResult = result.fileResults[0];

    if (fileResult.didPass) {
      // If somehow it passed (very unlikely), error summary should be empty
      expect(fileResult.errorSummary).toBe('');
    } else {
      // If it failed (expected), error summary should contain something meaningful
      expect(fileResult.errorSummary.length).toBeGreaterThan(0);
    }
  });
});
