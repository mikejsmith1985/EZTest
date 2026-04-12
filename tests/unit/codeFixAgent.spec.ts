/**
 * Unit tests for the Code Fix Agent module.
 *
 * These tests cover the file change application logic, JSON parsing of AI responses,
 * and path normalization — without requiring a real AI provider or live application.
 */
import { test, expect } from '@playwright/test';
import { mkdirSync, existsSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { analyzeAndApplyCodeFix } from '../../src/agentLoop/codeFixAgent.js';
import type { BugReport, ReproductionAttempt } from '../../src/shared/types.js';
import type { AiClient } from '../../src/shared/aiClient.js';

// ── Test Fixtures ──────────────────────────────────────────────────────────

/** Creates a minimal BugReport for testing. */
function createMockBugReport(overrides: Partial<BugReport> = {}): BugReport {
  return {
    reportId: `test-report-${randomUUID().slice(0, 8)}`,
    reportedAt: new Date().toISOString(),
    observedAtUrl: 'http://localhost:3000/cart',
    userExpectation: 'Cart total should update when adding items',
    interactionHistory: [],
    domStateAtFlag: '<div class="cart-total">$0.00</div>',
    ...overrides,
  };
}

/** Creates a minimal ReproductionAttempt for testing. */
function createMockReproductionAttempt(bugReportId: string): ReproductionAttempt {
  return {
    bugReportId,
    reproductionTestCode: `
import { test, expect } from '@playwright/test';
test('cart total updates', async ({ page }) => {
  await page.goto('http://localhost:3000/cart');
  await page.getByRole('button', { name: 'Add Item' }).click();
  await expect(page.locator('.cart-total')).not.toHaveText('$0.00');
});`.trim(),
    wasReproductionSuccessful: true,
    testRunOutput: '1 test failed\n  ✕ cart total updates',
  };
}

/**
 * Creates a mock AI client that returns a structured code fix JSON response.
 */
function createMockCodeFixAiClient(
  searchText: string,
  replacementText: string,
  sourceFilePath: string,
): AiClient {
  const fixResponse = JSON.stringify({
    rootCause: 'The addItem function does not recalculate the total after adding an item',
    fixDescription: 'Added total recalculation in addItem by calling recalculateTotal()',
    fileChanges: [
      {
        filePath: sourceFilePath,
        searchText,
        replacementText,
      },
    ],
  });

  return {
    chat: async () => ({
      content: fixResponse,
      tokensUsed: 200,
      modelUsed: 'mock-model',
    }),
    initialize: async () => {},
    providerName: 'mock',
    modelName: 'mock-model',
  } as unknown as AiClient;
}

// ── Test Setup ─────────────────────────────────────────────────────────────

let testTemporaryDirectory: string;
let testSourceDirectory: string;

test.beforeAll(() => {
  testTemporaryDirectory = join('test-results', `fix-agent-unit-${randomUUID()}`);
  testSourceDirectory = join(testTemporaryDirectory, 'src');
  mkdirSync(testSourceDirectory, { recursive: true });

  // Create a test source file that has the "bug" in it
  const cartComponentPath = join(testSourceDirectory, 'Cart.tsx');
  writeFileSync(cartComponentPath, `
import React, { useState } from 'react';

export function Cart() {
  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);

  const addItem = (item) => {
    setItems([...items, item]);
    // BUG: total is not updated here
  };

  return (
    <div>
      <button onClick={() => addItem({ price: 10 })}>Add Item</button>
      <div className="cart-total">\${total.toFixed(2)}</div>
    </div>
  );
}
`.trim(), 'utf-8');
});

test.afterAll(() => {
  if (existsSync(testTemporaryDirectory)) {
    rmSync(testTemporaryDirectory, { recursive: true, force: true });
  }
});

// ── Tests ──────────────────────────────────────────────────────────────────

test.describe('analyzeAndApplyCodeFix — file change application', () => {
  test('applies a valid search/replace change to a source file', async () => {
    const bugReport = createMockBugReport({ sourceDirectory: testSourceDirectory });
    const reproductionAttempt = createMockReproductionAttempt(bugReport.reportId);

    // The mock AI will tell us to replace the broken addItem with a fixed version
    const searchText = `  const addItem = (item) => {
    setItems([...items, item]);
    // BUG: total is not updated here
  };`;

    const replacementText = `  const addItem = (item) => {
    setItems([...items, item]);
    setTotal(prev => prev + item.price);
  };`;

    const mockAiClient = createMockCodeFixAiClient(searchText, replacementText, 'Cart.tsx');

    // We can't run Playwright in unit tests, so the verification step will fail.
    // But we can verify the FILE was changed correctly before the test runner runs.
    try {
      await analyzeAndApplyCodeFix(reproductionAttempt, bugReport, mockAiClient, {
        projectRoot: testTemporaryDirectory,
        targetAppUrl: 'http://localhost:3000',
        sourceDirectory: testSourceDirectory,
      });
    } catch {
      // Expected — Playwright test runner won't work here
    }

    // The most important assertion: the source file should be modified
    const cartFilePath = join(testSourceDirectory, 'Cart.tsx');
    const modifiedContent = readFileSync(cartFilePath, 'utf-8');

    expect(modifiedContent).toContain('setTotal(prev => prev + item.price)');
    expect(modifiedContent).not.toContain('// BUG: total is not updated here');
  });

  test('throws an error when no sourceDirectory is available', async () => {
    const bugReport = createMockBugReport();
    // Note: no sourceDirectory on bugReport and none in options
    const reproductionAttempt = createMockReproductionAttempt(bugReport.reportId);

    const mockAiClient = createMockCodeFixAiClient('', '', 'Cart.tsx');

    await expect(
      analyzeAndApplyCodeFix(reproductionAttempt, bugReport, mockAiClient, {
        projectRoot: testTemporaryDirectory,
        targetAppUrl: 'http://localhost:3000',
        // sourceDirectory intentionally omitted
      })
    ).rejects.toThrow('no sourceDirectory provided');
  });

  test('handles AI response wrapped in markdown code fences gracefully', async () => {
    const bugReport = createMockBugReport({ sourceDirectory: testSourceDirectory });
    const reproductionAttempt = createMockReproductionAttempt(bugReport.reportId);

    // Some AI models wrap JSON in markdown fences even when told not to
    const aiClientWithFencedResponse = {
      chat: async () => ({
        content: '```json\n{"rootCause":"test","fixDescription":"test","fileChanges":[]}\n```',
        tokensUsed: 50,
        modelUsed: 'mock',
      }),
      initialize: async () => {},
      providerName: 'mock',
      modelName: 'mock',
    } as unknown as AiClient;

    // Should NOT throw — the parser strips markdown fences
    let thrownError: Error | undefined;
    try {
      await analyzeAndApplyCodeFix(reproductionAttempt, bugReport, aiClientWithFencedResponse, {
        projectRoot: testTemporaryDirectory,
        targetAppUrl: 'http://localhost:3000',
        sourceDirectory: testSourceDirectory,
      });
    } catch (caughtError) {
      thrownError = caughtError as Error;
    }

    // Only expect a Playwright runner error, NOT a JSON parse error
    if (thrownError) {
      expect(thrownError.message).not.toContain('invalid JSON');
    }
  });

  test('source file path is correctly resolved relative to sourceDirectory', async () => {
    const bugReport = createMockBugReport({ sourceDirectory: testSourceDirectory });
    const reproductionAttempt = createMockReproductionAttempt(bugReport.reportId);

    let capturedPromptMessages: unknown;
    const observingAiClient = {
      chat: async (messages: unknown) => {
        capturedPromptMessages = messages;
        return {
          content: JSON.stringify({
            rootCause: 'test',
            fixDescription: 'test',
            fileChanges: [],
          }),
          tokensUsed: 50,
          modelUsed: 'mock',
        };
      },
      initialize: async () => {},
      providerName: 'mock',
      modelName: 'mock',
    } as unknown as AiClient;

    try {
      await analyzeAndApplyCodeFix(reproductionAttempt, bugReport, observingAiClient, {
        projectRoot: testTemporaryDirectory,
        targetAppUrl: 'http://localhost:3000',
        sourceDirectory: testSourceDirectory,
      });
    } catch {
      // Expected
    }

    // The source files in the prompt should use relative paths (easier for the AI to work with)
    const messages = capturedPromptMessages as Array<{ role: string; content: string }>;
    const userMessage = messages?.find(m => m.role === 'user');

    if (userMessage) {
      // Should contain the relative path 'Cart.tsx', not an absolute Windows path
      expect(userMessage.content).toContain('Cart.tsx');
      expect(userMessage.content).not.toContain('test-results');
    }
  });
});
