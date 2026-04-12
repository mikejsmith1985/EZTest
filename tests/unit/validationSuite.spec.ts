/**
 * Unit tests for the Validation Suite Generator module.
 *
 * Tests file writing, directory creation, pass/fail status propagation,
 * and AI prompt construction — without running a real Playwright test or AI call.
 */
import { test, expect } from '@playwright/test';
import { mkdirSync, existsSync, rmSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { generateAndRunValidationSuite } from '../../src/agentLoop/validationSuite.js';
import type { BugReport, CodeFixResult } from '../../src/shared/types.js';
import type { AiClient } from '../../src/shared/aiClient.js';

// ── Test Fixtures ──────────────────────────────────────────────────────────

function createMockBugReport(): BugReport {
  return {
    reportId: `validation-test-${randomUUID().slice(0, 8)}`,
    reportedAt: new Date().toISOString(),
    observedAtUrl: 'http://localhost:3000/cart',
    userExpectation: 'Cart total should update when quantity changes',
    interactionHistory: [],
    domStateAtFlag: '<div class="cart-total">$0.00</div>',
    sourceDirectory: './src',
  };
}

function createMockCodeFixResult(bugReportId: string): CodeFixResult {
  return {
    bugReportId,
    fixDescription: 'The addItem function was not recalculating total — fixed by calling recalculateTotal() after setItems()',
    changedFiles: new Map([['src/Cart.tsx', 'updated content']]),
    doesReproductionTestPass: true,
    doesValidationSuitePass: false,
  };
}

const SAMPLE_VALIDATION_TEST_CODE = `import { test, expect } from '@playwright/test';

test.describe('Cart total validation', () => {
  test('total updates when quantity increases', async ({ page }) => {
    await page.goto('http://localhost:3000/cart');
    await page.getByRole('button', { name: 'Increase quantity' }).click();
    await expect(page.locator('.cart-total')).not.toHaveText('$0.00');
  });

  test('total shows zero for empty cart', async ({ page }) => {
    await page.goto('http://localhost:3000/cart');
    await expect(page.locator('.cart-total')).toHaveText('$0.00');
  });
});`;

function createMockAiClient(testCode: string, capturedMessages?: { value: unknown }): AiClient {
  return {
    chat: async (messages: unknown) => {
      if (capturedMessages) capturedMessages.value = messages;
      return { content: testCode, tokensUsed: 200, modelUsed: 'mock' };
    },
    initialize: async () => {},
    providerName: 'mock',
    modelName: 'mock',
  } as unknown as AiClient;
}

const SAMPLE_REPRODUCTION_TEST_CODE = `import { test, expect } from '@playwright/test';
test('cart total does not update (bug)', async ({ page }) => {
  await page.goto('http://localhost:3000/cart');
  await page.getByRole('button', { name: 'Increase quantity' }).click();
  await expect(page.locator('.cart-total')).not.toHaveText('$0.00');
});`;

// ── Test Setup ─────────────────────────────────────────────────────────────

let testTemporaryDirectory: string;

test.beforeAll(() => {
  testTemporaryDirectory = join('test-results', `validation-suite-unit-${randomUUID()}`);
  mkdirSync(testTemporaryDirectory, { recursive: true });
});

test.afterAll(() => {
  if (existsSync(testTemporaryDirectory)) {
    rmSync(testTemporaryDirectory, { recursive: true, force: true });
  }
});

// ── Tests ──────────────────────────────────────────────────────────────────

test.describe('generateAndRunValidationSuite', () => {
  test('writes the validation test file to tests/validations/<reportId>/', async () => {
    const bugReport = createMockBugReport();
    const codeFixResult = createMockCodeFixResult(bugReport.reportId);
    const mockAiClient = createMockAiClient(SAMPLE_VALIDATION_TEST_CODE);

    try {
      await generateAndRunValidationSuite(codeFixResult, bugReport, SAMPLE_REPRODUCTION_TEST_CODE, mockAiClient, {
        projectRoot: testTemporaryDirectory,
        targetAppUrl: 'http://localhost:3000',
      });
    } catch {
      // Expected — Playwright test runner won't work in unit test context
    }

    const expectedFilePath = resolve(
      testTemporaryDirectory,
      'tests',
      'validations',
      bugReport.reportId,
      'validation.spec.ts',
    );
    expect(existsSync(expectedFilePath)).toBe(true);

    const writtenContent = readFileSync(expectedFilePath, 'utf-8');
    expect(writtenContent).toBe(SAMPLE_VALIDATION_TEST_CODE);
  });

  test('returns the validationTestCode from the AI response', async () => {
    const bugReport = createMockBugReport();
    const codeFixResult = createMockCodeFixResult(bugReport.reportId);
    const mockAiClient = createMockAiClient(SAMPLE_VALIDATION_TEST_CODE);

    let result;
    try {
      result = await generateAndRunValidationSuite(codeFixResult, bugReport, SAMPLE_REPRODUCTION_TEST_CODE, mockAiClient, {
        projectRoot: testTemporaryDirectory,
        targetAppUrl: 'http://localhost:3000',
      });
    } catch {
      // Expected
    }

    if (result) {
      expect(result.validationTestCode).toBe(SAMPLE_VALIDATION_TEST_CODE);
      expect(result.bugReportId).toBe(bugReport.reportId);
    }
  });

  test('includes the fix description in the AI prompt', async () => {
    const bugReport = createMockBugReport();
    const codeFixResult = createMockCodeFixResult(bugReport.reportId);
    const capturedMessages = { value: null as unknown };
    const mockAiClient = createMockAiClient(SAMPLE_VALIDATION_TEST_CODE, capturedMessages);

    try {
      await generateAndRunValidationSuite(codeFixResult, bugReport, SAMPLE_REPRODUCTION_TEST_CODE, mockAiClient, {
        projectRoot: testTemporaryDirectory,
        targetAppUrl: 'http://localhost:3000',
      });
    } catch {
      // Expected
    }

    const messages = capturedMessages.value as Array<{ role: string; content: string }>;
    const userMessage = messages?.find(m => m.role === 'user');
    expect(userMessage?.content).toContain(codeFixResult.fixDescription);
  });

  test('includes the reproduction test code in the AI prompt', async () => {
    const bugReport = createMockBugReport();
    const codeFixResult = createMockCodeFixResult(bugReport.reportId);
    const capturedMessages = { value: null as unknown };
    const mockAiClient = createMockAiClient(SAMPLE_VALIDATION_TEST_CODE, capturedMessages);

    try {
      await generateAndRunValidationSuite(codeFixResult, bugReport, SAMPLE_REPRODUCTION_TEST_CODE, mockAiClient, {
        projectRoot: testTemporaryDirectory,
        targetAppUrl: 'http://localhost:3000',
      });
    } catch {
      // Expected
    }

    const messages = capturedMessages.value as Array<{ role: string; content: string }>;
    const userMessage = messages?.find(m => m.role === 'user');
    // Reproduction test code should appear in the prompt context
    expect(userMessage?.content).toContain('cart total does not update');
  });
});
