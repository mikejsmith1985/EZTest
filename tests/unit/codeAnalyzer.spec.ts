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

  test('respects maxFileCount limit', async () => {
    const testDirectory = createTestDirectory();
    try {
      // Write multiple files to ensure the limit is enforced
      for (let fileIndex = 0; fileIndex < 5; fileIndex++) {
        writeFixture(testDirectory, `Button${fileIndex}.tsx`, `
          export function Button${fileIndex}() {
            return <button onClick={handleClick}>Click me</button>;
          }
        `);
      }

      const analyses = await analyzeSourceDirectory({
        sourceDirectory: testDirectory,
        excludePatterns: [],
        maxFileCount: 2, // Limit to 2 files
      });

      expect(analyses.length).toBeLessThanOrEqual(2);
    } finally {
      cleanupTestDirectory(testDirectory);
    }
  });
});

