/**
 * Test Generator — final stage of the AI Test Synthesizer pipeline.
 *
 * Takes UserFlow objects (produced by FlowMapper) and uses AI to generate
 * complete, runnable Playwright test files for each flow.
 *
 * The generated tests:
 * - Assert on user-visible DOM state, not internal function calls
 * - Use Playwright's semantic locators (getByRole, getByLabel, getByText)
 * - Are organized one-flow-per-file for clear traceability
 * - Include a human-readable summary of what is being validated
 */
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import type { UserFlow, GeneratedTestFile } from '../shared/types.js';
import type { AiClient } from '../shared/aiClient.js';
import { buildTestCodeGenerationPrompt, buildAssertionReviewPrompt } from './promptTemplates.js';
import { logDebug, logInfo, logWarning, logSuccess } from '../shared/logger.js';

// ── File Name Generation ───────────────────────────────────────────────────

/**
 * Converts a human-readable flow name into a valid test file name.
 * "User completes checkout with credit card" → "user-completes-checkout-with-credit-card.spec.ts"
 */
function generateTestFileName(flowName: string): string {
  const sanitizedName = flowName
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '') // Remove special characters
    .replace(/\s+/g, '-')          // Replace spaces with hyphens
    .replace(/-+/g, '-')           // Collapse multiple hyphens
    .slice(0, 80);                  // Limit length to avoid filesystem issues

  return `${sanitizedName}.spec.ts`;
}

// ── Code Post-Processing ───────────────────────────────────────────────────

/**
 * Cleans up AI-generated test code to ensure it's valid TypeScript.
 * The AI is very good at generating correct code but occasionally adds
 * markdown fences or explanation text that we need to strip.
 */
function sanitizeGeneratedTestCode(rawAiOutput: string): string {
  return rawAiOutput
    .replace(/^```typescript\s*/m, '')
    .replace(/^```ts\s*/m, '')
    .replace(/^```\s*/m, '')
    .replace(/\s*```\s*$/m, '')
    .trim();
}

/**
 * Extracts a summary of what assertions the test makes by scanning the code
 * for Playwright matcher calls. Used for human-readable reporting.
 *
 * Searches for `.toBeVisible()`, `.toHaveText(...)` etc. rather than trying to
 * parse the full `expect(...)` expression — avoids breaking on nested parens.
 */
function extractAssertionSummary(testCode: string): string[] {
  const matcherPattern = /\.(toBeVisible|toHaveText|toContainText|toBeEnabled|toBeDisabled|toHaveValue|toHaveURL|toBeChecked|toHaveCount)\([^)]*\)/g;
  const matches = testCode.match(matcherPattern) ?? [];
  return [...new Set(matches)].slice(0, 10); // Dedupe and limit to 10 for readability
}

// ── Single Flow Test Generation ────────────────────────────────────────────

/**
 * Generates a Playwright test file for a single user flow.
 * Returns the complete GeneratedTestFile with source code and metadata.
 *
 * When shouldReviewAssertions is true, runs a second AI pass after generation
 * to catch and replace any code-level assertions that slipped through.
 */
async function generateTestForFlow(
  userFlow: UserFlow,
  targetAppUrl: string,
  outputDirectory: string,
  aiClient: AiClient,
  appSpec: string | undefined,
  shouldReviewAssertions: boolean,
): Promise<GeneratedTestFile | null> {
  const promptMessages = buildTestCodeGenerationPrompt(userFlow, targetAppUrl, appSpec);

  let aiResponse;
  try {
    aiResponse = await aiClient.chat(promptMessages, `test generation: ${userFlow.flowName}`);
  } catch (callError) {
    logWarning(`AI call failed for flow "${userFlow.flowName}": ${String(callError)}`);
    return null;
  }

  let sanitizedTestCode = sanitizeGeneratedTestCode(aiResponse.content);

  if (!sanitizedTestCode.includes('import') || !sanitizedTestCode.includes('test(') && !sanitizedTestCode.includes('it(')) {
    logWarning(`Generated code for "${userFlow.flowName}" doesn't look like valid Playwright tests. Skipping.`);
    logDebug(`Raw output: ${aiResponse.content.slice(0, 300)}`);
    return null;
  }

  // ── Second pass: behavioral assertion review ────────────────────────────
  // Run the reviewer only when enabled — it adds one AI call per test but catches
  // the code-level assertions (toHaveBeenCalled, state checks) that slip through
  // even with a strict system prompt.
  if (shouldReviewAssertions) {
    logDebug(`  Reviewing assertions for "${userFlow.flowName}"...`);
    try {
      const reviewMessages = buildAssertionReviewPrompt(sanitizedTestCode);
      const reviewResponse = await aiClient.chat(reviewMessages, `assertion review: ${userFlow.flowName}`);
      const reviewedCode = sanitizeGeneratedTestCode(reviewResponse.content);

      // Only accept the reviewed version if it still looks like valid test code
      if (reviewedCode.includes('import') && (reviewedCode.includes('test(') || reviewedCode.includes('it('))) {
        sanitizedTestCode = reviewedCode;
        logDebug(`  Assertion review complete for "${userFlow.flowName}"`);
      } else {
        logWarning(`Assertion review returned invalid code for "${userFlow.flowName}" — keeping original`);
      }
    } catch (reviewError) {
      // Non-fatal: keep the originally generated code if review fails
      logWarning(`Assertion review failed for "${userFlow.flowName}": ${String(reviewError)}`);
    }
  }

  const testFileName = generateTestFileName(userFlow.flowName);
  const suggestedOutputPath = join(outputDirectory, testFileName);
  const assertionSummary = extractAssertionSummary(sanitizedTestCode);

  logDebug(`Generated test for "${userFlow.flowName}" with ${assertionSummary.length} assertions`);

  return {
    suggestedOutputPath,
    testSourceCode: sanitizedTestCode,
    sourceFlow: userFlow,
    assertionSummary,
  };
}

// ── Public API ─────────────────────────────────────────────────────────────

/** Options for the test generator. */
export interface TestGeneratorOptions {
  targetAppUrl: string;
  outputDirectory: string;
  /** Whether to write the files to disk immediately (default: true) */
  shouldWriteFilesToDisk: boolean;
  /**
   * Optional plain-English description of what the application does.
   * Injected into test generation prompts to improve behavioral accuracy.
   */
  appSpec?: string;
  /**
   * Whether to run a second AI pass to review and fix any code-level assertions
   * that slipped through the initial generation. Default: true.
   * Disable with --no-review to reduce API calls for large test suites.
   */
  shouldReviewAssertions: boolean;
}

/** The result of a complete test generation run. */
export interface TestGenerationResult {
  generatedFiles: GeneratedTestFile[];
  /** Number of flows that the AI failed to generate tests for */
  failedFlowCount: number;
  /** Total number of assertion checks across all generated tests */
  totalAssertionCount: number;
}

/**
 * Generates Playwright test files for a set of user flows.
 *
 * This is the final stage of the Phase 1 synthesis pipeline.
 * After this runs, you have a complete set of behavioral test files
 * ready to run with `playwright test`.
 */
export async function generateTestsForFlows(
  userFlows: UserFlow[],
  aiClient: AiClient,
  options: TestGeneratorOptions,
): Promise<TestGenerationResult> {
  const { targetAppUrl, outputDirectory, shouldWriteFilesToDisk, appSpec, shouldReviewAssertions } = options;

  if (userFlows.length === 0) {
    logWarning('No user flows provided to test generator. Nothing to generate.');
    return { generatedFiles: [], failedFlowCount: 0, totalAssertionCount: 0 };
  }

  // Ensure output directory exists before we start writing files
  if (shouldWriteFilesToDisk) {
    const resolvedOutputDirectory = resolve(outputDirectory);
    if (!existsSync(resolvedOutputDirectory)) {
      mkdirSync(resolvedOutputDirectory, { recursive: true });
      logDebug(`Created output directory: ${resolvedOutputDirectory}`);
    }
  }

  if (shouldReviewAssertions) {
    logInfo(`Generating Playwright tests for ${userFlows.length} user flows (with behavioral assertion review)...`);
  } else {
    logInfo(`Generating Playwright tests for ${userFlows.length} user flows...`);
  }

  const generatedFiles: GeneratedTestFile[] = [];
  let failedFlowCount = 0;

  for (const userFlow of userFlows) {
    logDebug(`  Generating: ${userFlow.flowName} (${userFlow.flowKind})`);

    const generatedFile = await generateTestForFlow(
      userFlow,
      targetAppUrl,
      outputDirectory,
      aiClient,
      appSpec,
      shouldReviewAssertions,
    );

    if (!generatedFile) {
      failedFlowCount++;
      continue;
    }

    generatedFiles.push(generatedFile);

    if (shouldWriteFilesToDisk) {
      const resolvedOutputPath = resolve(generatedFile.suggestedOutputPath);
      const outputFileDirectory = dirname(resolvedOutputPath);

      if (!existsSync(outputFileDirectory)) {
        mkdirSync(outputFileDirectory, { recursive: true });
      }

      writeFileSync(resolvedOutputPath, generatedFile.testSourceCode, 'utf-8');
      logSuccess(`Written: ${generatedFile.suggestedOutputPath}`);
    }
  }

  const totalAssertionCount = generatedFiles.reduce(
    (total, file) => total + file.assertionSummary.length,
    0,
  );

  return {
    generatedFiles,
    failedFlowCount,
    totalAssertionCount,
  };
}
