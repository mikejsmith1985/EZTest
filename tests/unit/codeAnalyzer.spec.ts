/**
 * Unit tests for the Code Analyzer.
 * Creates temporary fixture files and verifies that the analyzer correctly
 * identifies interactive elements, component names, and source framework.
 */
import { test, expect } from '@playwright/test';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { analyzeSourceDirectory } from '../../src/synthesizer/codeAnalyzer.js';

// Base directory for all test fixture files — kept outside of any path named 'fixtures' to avoid
// matching the built-in glob exclude pattern for fixture directories in discoverSourceFiles.
const FIXTURE_BASE_DIRECTORY = resolve('./tests/temp/code-analyzer');

/**
 * Creates a unique temp directory for a single test to prevent parallel test workers
 * from interfering with each other's fixture files.
 */
function createTestDirectory(): string {
  const uniqueDirectory = join(FIXTURE_BASE_DIRECTORY, randomUUID());
  mkdirSync(uniqueDirectory, { recursive: true });
  return uniqueDirectory;
}

/**
 * Writes a fixture file to the given directory and returns the file path.
 */
function writeFixture(directory: string, filename: string, content: string): string {
  const filePath = join(directory, filename);
  writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

/**
 * Cleans up a test directory after the test completes.
 */
function cleanupTestDirectory(directory: string): void {
  rmSync(directory, { recursive: true, force: true });
}

test.describe('analyzeSourceDirectory', () => {
  test('finds a button with text content', async () => {
    const testDirectory = createTestDirectory();
    try {
      writeFixture(testDirectory, 'SubmitButton.tsx', `
        export function SubmitButton() {
          return <button onClick={handleSubmit}>Submit Order</button>;
        }
      `);

      const analyses = await analyzeSourceDirectory({
        sourceDirectory: testDirectory,
        excludePatterns: [],
        maxFileCount: 10,
      });

      const submitButtonComponent = analyses.find(
        analysis => analysis.componentName === 'SubmitButton'
      );

      expect(submitButtonComponent).toBeDefined();
      expect(submitButtonComponent!.interactiveElements).toHaveLength(1);

      const buttonElement = submitButtonComponent!.interactiveElements[0];
      expect(buttonElement!.elementKind).toBe('button');
      expect(buttonElement!.textContent).toBe('Submit Order');
      expect(buttonElement!.handlerName).toBe('handleSubmit');
    } finally {
      cleanupTestDirectory(testDirectory);
    }
  });

  test('finds an input with aria-label', async () => {
    const testDirectory = createTestDirectory();
    try {
      writeFixture(testDirectory, 'SearchInput.tsx', `
        export function SearchInput() {
          return (
            <input
              type="text"
              aria-label="Search products"
              onChange={handleSearchChange}
            />
          );
        }
      `);

      const analyses = await analyzeSourceDirectory({
        sourceDirectory: testDirectory,
        excludePatterns: [],
        maxFileCount: 10,
      });

      const searchComponent = analyses.find(
        analysis => analysis.componentName === 'SearchInput'
      );

      expect(searchComponent).toBeDefined();
      const inputElement = searchComponent!.interactiveElements.find(
        element => element.ariaLabel === 'Search products'
      );
      expect(inputElement).toBeDefined();
      expect(inputElement!.elementKind).toBe('input');
      expect(inputElement!.handlerName).toBe('handleSearchChange');
    } finally {
      cleanupTestDirectory(testDirectory);
    }
  });

  test('skips components with no interactive elements', async () => {
    const testDirectory = createTestDirectory();
    try {
      writeFixture(testDirectory, 'StaticContent.tsx', `
        export function StaticContent() {
          return (
            <div>
              <h1>Welcome</h1>
              <p>This is static content with no interactive elements.</p>
              <span>Just text</span>
            </div>
          );
        }
      `);

      const analyses = await analyzeSourceDirectory({
        sourceDirectory: testDirectory,
        excludePatterns: [],
        maxFileCount: 10,
      });

      const staticComponent = analyses.find(
        analysis => analysis.componentName === 'StaticContent'
      );

      // Components with no interactive elements should be excluded from analysis results
      expect(staticComponent).toBeUndefined();
    } finally {
      cleanupTestDirectory(testDirectory);
    }
  });

  test('detects data-testid on interactive elements', async () => {
    const testDirectory = createTestDirectory();
    try {
      writeFixture(testDirectory, 'DeleteButton.tsx', `
        export function DeleteButton() {
          return (
            <button data-testid="delete-account-btn" onClick={handleDelete}>
              Delete Account
            </button>
          );
        }
      `);

      const analyses = await analyzeSourceDirectory({
        sourceDirectory: testDirectory,
        excludePatterns: [],
        maxFileCount: 10,
      });

      const deleteComponent = analyses.find(
        analysis => analysis.componentName === 'DeleteButton'
      );

      expect(deleteComponent).toBeDefined();
      const deleteButton = deleteComponent!.interactiveElements[0];
      expect(deleteButton!.testId).toBe('delete-account-btn');
      expect(deleteButton!.textContent).toBe('Delete Account');
    } finally {
      cleanupTestDirectory(testDirectory);
    }
  });

  test('skips hidden input elements', async () => {
    const testDirectory = createTestDirectory();
    try {
      writeFixture(testDirectory, 'FormWithHiddenInput.tsx', `
        export function FormWithHiddenInput() {
          return (
            <form onSubmit={handleSubmit}>
              <input type="hidden" name="csrf_token" value="abc123" />
              <button type="submit">Submit</button>
            </form>
          );
        }
      `);

      const analyses = await analyzeSourceDirectory({
        sourceDirectory: testDirectory,
        excludePatterns: [],
        maxFileCount: 10,
      });

      const formComponent = analyses.find(
        analysis => analysis.componentName === 'FormWithHiddenInput'
      );

      expect(formComponent).toBeDefined();
      // Should have form + button but NOT the hidden input
      const hiddenInputElement = formComponent!.interactiveElements.find(
        element => element.tagName === 'input'
      );
      // The hidden input should not appear in the interactive elements list
      expect(hiddenInputElement).toBeUndefined();
    } finally {
      cleanupTestDirectory(testDirectory);
    }
  });

  test('excludes *.test.tsx files even when they live in a routes/ directory (high-priority dir)', async () => {
    // Regression test: server-side test files in routes/ scored 100 (high-value directory)
    // and consumed the top-N file budget with files that have no interactive UI elements.
    // ADDITIONAL_EXCLUDE_PATTERNS must filter them before scoring.
    const testDirectory = createTestDirectory();
    try {
      const routesDirectory = join(testDirectory, 'routes');
      mkdirSync(routesDirectory, { recursive: true });

      // A test file (should be excluded) in a high-scoring routes/ directory
      writeFixture(routesDirectory, 'UserRoutes.test.ts', `
        import { describe, it, expect } from 'vitest';
        describe('user routes', () => {
          it('should handle GET /users', async () => {
            const res = await request(app).get('/users');
            expect(res.status).toBe(200);
          });
        });
      `);

      // A real page component (should be included)
      writeFixture(testDirectory, 'LoginPage.tsx', `
        export function LoginPage() {
          return <button onClick={handleLogin}>Sign In</button>;
        }
      `);

      const analyses = await analyzeSourceDirectory({
        sourceDirectory: testDirectory,
        excludePatterns: [],
        maxFileCount: 10,
      });

      const fileNames = analyses.map(analysis => analysis.componentName);
      // Test file must be excluded regardless of its directory score
      expect(fileNames).not.toContain('UserRoutes.test');
      // Real component must be included
      expect(fileNames).toContain('LoginPage');
    } finally {
      cleanupTestDirectory(testDirectory);
    }
  });

  test('excludes *.spec.ts files from analysis', async () => {
    const testDirectory = createTestDirectory();
    try {
      writeFixture(testDirectory, 'CheckoutPage.spec.ts', `
        test('checkout works', async () => {
          const page = await browser.newPage();
          await page.goto('/checkout');
        });
      `);

      writeFixture(testDirectory, 'CheckoutPage.tsx', `
        export function CheckoutPage() {
          return <button onClick={handleCheckout}>Complete Purchase</button>;
        }
      `);

      const analyses = await analyzeSourceDirectory({
        sourceDirectory: testDirectory,
        excludePatterns: [],
        maxFileCount: 10,
      });

      const fileNames = analyses.map(analysis => analysis.componentName);
      expect(fileNames).not.toContain('CheckoutPage.spec');
      expect(fileNames).toContain('CheckoutPage');
    } finally {
      cleanupTestDirectory(testDirectory);
    }
  });
});

