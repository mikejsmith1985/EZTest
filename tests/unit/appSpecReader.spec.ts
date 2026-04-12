/**
 * Unit tests for the App Spec Reader module.
 *
 * Verifies file detection order, content truncation to the character limit,
 * parent-directory search, short-file skipping, and graceful handling of
 * missing or unreadable files.
 */
import { test, expect } from '@playwright/test';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readAppSpecFromFile, detectAndReadAppSpec } from '../../src/synthesizer/appSpecReader.js';

// ── Test Setup ──────────────────────────────────────────────────────────────

// Each test gets its own isolated directory so no test can pollute another.
let testTemporaryDirectory: string;

test.beforeAll(() => {
  testTemporaryDirectory = join('test-results', `appspec-unit-${randomUUID()}`);
  mkdirSync(testTemporaryDirectory, { recursive: true });
});

test.afterAll(() => {
  if (existsSync(testTemporaryDirectory)) {
    rmSync(testTemporaryDirectory, { recursive: true, force: true });
  }
});

// ── readAppSpecFromFile ─────────────────────────────────────────────────────

test.describe('readAppSpecFromFile', () => {
  test('returns the file content when the file exists and is readable', () => {
    const specDir = join(testTemporaryDirectory, `read-${randomUUID().slice(0, 8)}`);
    mkdirSync(specDir, { recursive: true });
    const specContent = 'This app manages customer invoices. Users can create, edit, and delete invoices.';
    writeFileSync(join(specDir, 'eztest-spec.md'), specContent, 'utf-8');

    const result = readAppSpecFromFile(join(specDir, 'eztest-spec.md'));

    expect(result).not.toBeNull();
    expect(result!.specContent).toBe(specContent);
    expect(result!.wasTruncated).toBe(false);
  });

  test('returns null and does not throw when the file does not exist', () => {
    const result = readAppSpecFromFile('/nonexistent-path/definitely-not-a-real-file.md');

    expect(result).toBeNull();
  });

  test('truncates content when the file exceeds the character limit', () => {
    // Build a string that is definitely longer than MAX_SPEC_CHARS (5000)
    const longContent = 'A'.repeat(6000);
    const specDir = join(testTemporaryDirectory, `trunc-${randomUUID().slice(0, 8)}`);
    mkdirSync(specDir, { recursive: true });
    writeFileSync(join(specDir, 'README.md'), longContent, 'utf-8');

    const result = readAppSpecFromFile(join(specDir, 'README.md'));

    expect(result).not.toBeNull();
    expect(result!.wasTruncated).toBe(true);
    // Content must be shorter than the original
    expect(result!.specContent.length).toBeLessThan(longContent.length);
    // But must not be empty
    expect(result!.specContent.length).toBeGreaterThan(0);
  });

  test('does not truncate content that is within the character limit', () => {
    const shortContent = 'A shopping cart application. Users can add items and checkout.';
    const specDir = join(testTemporaryDirectory, `ntrunc-${randomUUID().slice(0, 8)}`);
    mkdirSync(specDir, { recursive: true });
    writeFileSync(join(specDir, 'eztest-spec.md'), shortContent, 'utf-8');

    const result = readAppSpecFromFile(join(specDir, 'eztest-spec.md'));

    expect(result!.wasTruncated).toBe(false);
    expect(result!.specContent).toBe(shortContent);
  });

  test('reports the resolved absolute path in sourceFilePath', () => {
    const specDir = join(testTemporaryDirectory, `path-${randomUUID().slice(0, 8)}`);
    mkdirSync(specDir, { recursive: true });
    writeFileSync(join(specDir, 'README.md'), 'A real application with real features.', 'utf-8');

    const result = readAppSpecFromFile(join(specDir, 'README.md'));

    expect(result!.sourceFilePath).toMatch(/README\.md$/);
  });
});

// ── detectAndReadAppSpec ────────────────────────────────────────────────────

test.describe('detectAndReadAppSpec', () => {
  test('finds eztest-spec.md before README.md in the same directory', () => {
    const specDir = join(testTemporaryDirectory, `priority-${randomUUID().slice(0, 8)}`);
    mkdirSync(specDir, { recursive: true });
    writeFileSync(join(specDir, 'README.md'), 'README content — this should not be selected because eztest-spec.md takes priority.', 'utf-8');
    writeFileSync(join(specDir, 'eztest-spec.md'), 'EZTest spec — this should be selected first because it has the highest priority in the search order.', 'utf-8');

    const result = detectAndReadAppSpec(specDir);

    expect(result).not.toBeNull();
    expect(result).toContain('EZTest spec');
  });

  test('falls back to README.md when no eztest-spec.md is present', () => {
    const specDir = join(testTemporaryDirectory, `fallback-${randomUUID().slice(0, 8)}`);
    mkdirSync(specDir, { recursive: true });
    writeFileSync(join(specDir, 'README.md'), 'README fallback — the app does invoicing and expense tracking for small businesses.', 'utf-8');

    const result = detectAndReadAppSpec(specDir);

    expect(result).toContain('README fallback');
  });

  test('searches the parent directory when source directory has no spec file', () => {
    // Simulate src/ layout where README.md lives at project root (parent)
    const projectRoot = join(testTemporaryDirectory, `parent-search-${randomUUID().slice(0, 8)}`);
    const srcDirectory = join(projectRoot, 'src');
    mkdirSync(srcDirectory, { recursive: true });
    writeFileSync(join(projectRoot, 'README.md'), 'Project root README — user management app with login, profile editing, and role-based access control.', 'utf-8');

    const result = detectAndReadAppSpec(srcDirectory);

    expect(result).toContain('Project root README');
  });

  test('skips files whose content is shorter than 50 characters', () => {
    const specDir = join(testTemporaryDirectory, `short-${randomUUID().slice(0, 8)}`);
    mkdirSync(specDir, { recursive: true });
    // Short content (below the 50-char threshold) — should be skipped
    writeFileSync(join(specDir, 'eztest-spec.md'), 'Too short.', 'utf-8');
    // The README has enough content and should be picked up instead
    writeFileSync(join(specDir, 'README.md'), 'A comprehensive description of this application that is long enough to be useful.', 'utf-8');

    const result = detectAndReadAppSpec(specDir);

    expect(result).toContain('comprehensive description');
  });

  test('returns null when no spec file is found anywhere', () => {
    // An empty directory with no spec files
    const emptyDir = join(testTemporaryDirectory, `empty-${randomUUID().slice(0, 8)}`);
    mkdirSync(emptyDir, { recursive: true });

    const result = detectAndReadAppSpec(emptyDir);

    expect(result).toBeNull();
  });
});

// ── Integration: new options flow through to generateTestsForFlows ──────────

test.describe('generateTestsForFlows — app spec and review options', () => {
  test('appSpec and shouldReviewAssertions are accepted without error (smoke test)', async () => {
    // Import here to avoid polluting the top of the file with unrelated imports
    const { generateTestsForFlows } = await import('../../src/synthesizer/testGenerator.js');
    const mockCode = `import { test, expect } from '@playwright/test';
test('app works', async ({ page }) => {
  await page.goto('http://localhost:3000');
  await expect(page.getByText('Welcome')).toBeVisible();
});`;
    const mockAiClient = {
      chat: async () => ({ content: mockCode, tokensUsed: 100, modelUsed: 'mock' }),
      initialize: async () => {},
      providerName: 'mock',
      modelName: 'mock',
    } as any;

    const outputDir = join(testTemporaryDirectory, `smoke-${randomUUID().slice(0, 8)}`);

    const result = await generateTestsForFlows(
      [{
        flowName: 'User views homepage',
        startingUrl: 'http://localhost:3000',
        steps: [{ actionDescription: 'Navigate to root', expectedOutcome: 'Welcome message visible', isNavigation: true }],
        involvedComponents: ['App'],
        flowKind: 'happy-path',
      }],
      mockAiClient,
      {
        targetAppUrl: 'http://localhost:3000',
        outputDirectory: outputDir,
        shouldWriteFilesToDisk: false,
        appSpec: 'This is a demo application that greets users on the homepage.',
        shouldReviewAssertions: false, // Avoid a second AI call in this smoke test
      },
    );

    expect(result.generatedFiles).toHaveLength(1);
    expect(result.failedFlowCount).toBe(0);
  });
});
