/**
 * Unit tests for the Test Generator module.
 *
 * Tests filename generation, AI code sanitization (stripping markdown fences),
 * assertion extraction from generated code, and the overall file-writing pipeline
 * without actually calling an AI provider.
 */
import { test, expect } from '@playwright/test';
import { mkdirSync, existsSync, rmSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { generateTestsForFlows } from '../../src/synthesizer/testGenerator.js';
import type { UserFlow } from '../../src/shared/types.js';
import type { AiClient } from '../../src/shared/aiClient.js';

// ── Test Fixtures ──────────────────────────────────────────────────────────

function createMockUserFlow(overrides: Partial<UserFlow> = {}): UserFlow {
  return {
    flowName: 'User completes checkout',
    startingUrl: 'http://localhost:3000/checkout',
    steps: [
      {
        actionDescription: 'Click the Submit Order button',
        expectedOutcome: 'Order confirmation message appears',
        isNavigation: true,
      },
    ],
    involvedComponents: ['CheckoutForm'],
    flowKind: 'happy-path',
    ...overrides,
  };
}

/** A minimal but valid Playwright test file the AI might return. */
const SAMPLE_VALID_TEST_CODE = `import { test, expect } from '@playwright/test';

test('user completes checkout', async ({ page }) => {
  await page.goto('http://localhost:3000/checkout');
  await page.getByRole('button', { name: 'Submit Order' }).click();
  await expect(page.getByText('Order confirmed')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Thank you' })).toBeVisible();
});`;

function createMockAiClient(testCode: string): AiClient {
  return {
    chat: async () => ({ content: testCode, tokensUsed: 150, modelUsed: 'mock' }),
    initialize: async () => {},
    providerName: 'mock',
    modelName: 'mock',
  } as unknown as AiClient;
}

// ── Test Setup ─────────────────────────────────────────────────────────────

let testTemporaryDirectory: string;

test.beforeAll(() => {
  testTemporaryDirectory = join('test-results', `test-generator-unit-${randomUUID()}`);
  mkdirSync(testTemporaryDirectory, { recursive: true });
});

test.afterAll(() => {
  if (existsSync(testTemporaryDirectory)) {
    rmSync(testTemporaryDirectory, { recursive: true, force: true });
  }
});

// ── Tests ──────────────────────────────────────────────────────────────────

test.describe('generateTestsForFlows — file naming', () => {
  test('generates a kebab-case filename from the flow name', async () => {
    const mockAiClient = createMockAiClient(SAMPLE_VALID_TEST_CODE);
    const outputDir = join(testTemporaryDirectory, `output-${randomUUID().slice(0, 8)}`);

    const result = await generateTestsForFlows(
      [createMockUserFlow({ flowName: 'User completes checkout' })],
      mockAiClient,
      { targetAppUrl: 'http://localhost:3000', outputDirectory: outputDir, shouldWriteFilesToDisk: false },
    );

    expect(result.generatedFiles[0].suggestedOutputPath).toContain('user-completes-checkout');
    expect(result.generatedFiles[0].suggestedOutputPath).toMatch(/\.spec\.ts$/);
  });

  test('strips special characters from the flow name in the filename', async () => {
    const mockAiClient = createMockAiClient(SAMPLE_VALID_TEST_CODE);

    const result = await generateTestsForFlows(
      [createMockUserFlow({ flowName: 'User submits form with "special" chars & symbols!' })],
      mockAiClient,
      { targetAppUrl: 'http://localhost:3000', outputDirectory: testTemporaryDirectory, shouldWriteFilesToDisk: false },
    );

    const fileName = result.generatedFiles[0].suggestedOutputPath;
    expect(fileName).not.toContain('"');
    expect(fileName).not.toContain('!');
    expect(fileName).not.toContain('&');
  });
});

test.describe('generateTestsForFlows — code sanitization', () => {
  test('strips TypeScript markdown fences from AI output', async () => {
    const fencedCode = '```typescript\n' + SAMPLE_VALID_TEST_CODE + '\n```';
    const mockAiClient = createMockAiClient(fencedCode);

    const result = await generateTestsForFlows(
      [createMockUserFlow()],
      mockAiClient,
      { targetAppUrl: 'http://localhost:3000', outputDirectory: testTemporaryDirectory, shouldWriteFilesToDisk: false },
    );

    expect(result.generatedFiles[0].testSourceCode).not.toContain('```');
    expect(result.generatedFiles[0].testSourceCode).toContain("import { test, expect }");
  });

  test('skips flows where AI returns code with no import statement', async () => {
    const invalidCode = 'This is just a sentence, not TypeScript code.';
    const mockAiClient = createMockAiClient(invalidCode);

    const result = await generateTestsForFlows(
      [createMockUserFlow()],
      mockAiClient,
      { targetAppUrl: 'http://localhost:3000', outputDirectory: testTemporaryDirectory, shouldWriteFilesToDisk: false },
    );

    expect(result.generatedFiles).toHaveLength(0);
    expect(result.failedFlowCount).toBe(1);
  });
});

test.describe('generateTestsForFlows — assertion extraction', () => {
  test('extracts toBeVisible assertions from generated test code', async () => {
    const mockAiClient = createMockAiClient(SAMPLE_VALID_TEST_CODE);

    const result = await generateTestsForFlows(
      [createMockUserFlow()],
      mockAiClient,
      { targetAppUrl: 'http://localhost:3000', outputDirectory: testTemporaryDirectory, shouldWriteFilesToDisk: false },
    );

    // The sample test has two expect().toBeVisible() calls
    expect(result.generatedFiles[0].assertionSummary.length).toBeGreaterThan(0);
    expect(result.generatedFiles[0].assertionSummary.some(a => a.includes('toBeVisible'))).toBe(true);
  });

  test('totals assertion counts across multiple flows', async () => {
    const mockAiClient = createMockAiClient(SAMPLE_VALID_TEST_CODE);
    const twoFlows = [createMockUserFlow(), createMockUserFlow({ flowName: 'Another flow' })];

    const result = await generateTestsForFlows(
      twoFlows,
      mockAiClient,
      { targetAppUrl: 'http://localhost:3000', outputDirectory: testTemporaryDirectory, shouldWriteFilesToDisk: false },
    );

    expect(result.totalAssertionCount).toBeGreaterThan(0);
  });
});

test.describe('generateTestsForFlows — file writing', () => {
  test('writes test files to disk when shouldWriteFilesToDisk is true', async () => {
    const mockAiClient = createMockAiClient(SAMPLE_VALID_TEST_CODE);
    const outputDir = join(testTemporaryDirectory, `written-${randomUUID().slice(0, 8)}`);

    const result = await generateTestsForFlows(
      [createMockUserFlow()],
      mockAiClient,
      { targetAppUrl: 'http://localhost:3000', outputDirectory: outputDir, shouldWriteFilesToDisk: true },
    );

    const writtenFilePath = resolve(result.generatedFiles[0].suggestedOutputPath);
    expect(existsSync(writtenFilePath)).toBe(true);

    const writtenContent = readFileSync(writtenFilePath, 'utf-8');
    expect(writtenContent).toBe(result.generatedFiles[0].testSourceCode);
  });

  test('does NOT write files to disk when shouldWriteFilesToDisk is false', async () => {
    const mockAiClient = createMockAiClient(SAMPLE_VALID_TEST_CODE);
    const outputDir = join(testTemporaryDirectory, `dry-run-${randomUUID().slice(0, 8)}`);

    const result = await generateTestsForFlows(
      [createMockUserFlow()],
      mockAiClient,
      { targetAppUrl: 'http://localhost:3000', outputDirectory: outputDir, shouldWriteFilesToDisk: false },
    );

    expect(result.generatedFiles).toHaveLength(1);
    expect(existsSync(outputDir)).toBe(false); // Directory should not even be created
  });

  test('returns empty result with no error when given an empty flows array', async () => {
    const mockAiClient = createMockAiClient(SAMPLE_VALID_TEST_CODE);

    const result = await generateTestsForFlows(
      [],
      mockAiClient,
      { targetAppUrl: 'http://localhost:3000', outputDirectory: testTemporaryDirectory, shouldWriteFilesToDisk: false },
    );

    expect(result.generatedFiles).toHaveLength(0);
    expect(result.failedFlowCount).toBe(0);
    expect(result.totalAssertionCount).toBe(0);
  });
});
