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
import type { UserFlow, GeneratedTestFile, ForgeAppContext, ComponentAnalysis } from '../shared/types.js';
import type { AiClient } from '../shared/aiClient.js';
import {
  buildTestCodeGenerationPrompt,
  buildAssertionReviewPrompt,
  buildTestRegenerationPrompt,
} from './promptTemplates.js';
import { logDebug, logInfo, logWarning, logSuccess } from '../shared/logger.js';
import {
  runGeneratedTestFiles,
  type GeneratedTestSuiteResult,
} from './generatedTestRunner.js';
import { auditGeneratedTests } from './testQualityAuditor.js';

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
  feedbackContext?: string,
  forgeAppContext?: ForgeAppContext,
  involvedComponentAnalyses?: ComponentAnalysis[],
): Promise<GeneratedTestFile | null> {
  const promptMessages = buildTestCodeGenerationPrompt(userFlow, targetAppUrl, appSpec, feedbackContext, forgeAppContext, involvedComponentAnalyses);

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
   * Optional project-specific learnings from eztest-feedback.json.
   * Contains selector fix history, confirmed expectations, and false-positive
   * flags from previous runs — injected into prompts so EZTest improves over time.
   */
  feedbackContext?: string;
  /**
   * Whether to run a second AI pass to review and fix any code-level assertions
   * that slipped through the initial generation. Default: true.
   * Disable with --no-review to reduce API calls for large test suites.
   */
  shouldReviewAssertions: boolean;
  /**
   * Whether to run a fourth AI pass auditing all generated tests for behavioral
   * quality (flags tests that assert on implementation details). Default: false.
   * Opt-in because it costs an additional AI call across all generated files.
   */
  shouldAuditQuality?: boolean;
  /**
   * When present, the target app is a Jira Forge Custom UI app rendered in an iframe.
   * Injected into test generation prompts to produce iframe-aware test code.
   */
  forgeAppContext?: ForgeAppContext;
  /**
   * Component analysis results from the CodeAnalyzer stage. When provided, the test
   * generation prompt includes real element metadata (aria-labels, testIds, handler names)
   * so the AI writes precise selectors and meaningful assertions instead of falling back
   * to trivial smoke tests.
   */
  componentAnalyses?: ComponentAnalysis[];
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
  const { targetAppUrl, outputDirectory, shouldWriteFilesToDisk, appSpec, feedbackContext, shouldReviewAssertions, shouldAuditQuality, forgeAppContext, componentAnalyses } = options;

  if (userFlows.length === 0) {
    logWarning('No user flows provided to test generator. Nothing to generate.');
    return { generatedFiles: [], failedFlowCount: 0, totalAssertionCount: 0 };
  }

  // Build a lookup map from component name → analysis for fast per-flow element resolution.
  // This lets us pass real element metadata (aria-labels, testIds, handlers) to the test
  // generation prompt, eliminating the information gap that causes shallow smoke tests.
  const componentAnalysisLookup = new Map<string, ComponentAnalysis>();
  if (componentAnalyses) {
    for (const analysis of componentAnalyses) {
      componentAnalysisLookup.set(analysis.componentName, analysis);
    }
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

  for (let flowIndex = 0; flowIndex < userFlows.length; flowIndex++) {
    const userFlow = userFlows[flowIndex];
    // logInfo intentionally (not logDebug) — the "Writing test N/M" pattern is parsed
    // by the UI progress bar to show per-test progress during generation.
    logInfo(`  Writing test ${flowIndex + 1}/${userFlows.length}: ${userFlow.flowName}`);

    // Resolve the component analyses for THIS flow's involved components so the
    // test generation prompt has real element metadata instead of text-only descriptions.
    const involvedAnalyses = userFlow.involvedComponents
      .map(componentName => componentAnalysisLookup.get(componentName))
      .filter((analysis): analysis is ComponentAnalysis => analysis !== undefined);

    const generatedFile = await generateTestForFlow(
      userFlow,
      targetAppUrl,
      outputDirectory,
      aiClient,
      appSpec,
      shouldReviewAssertions,
      feedbackContext,
      forgeAppContext,
      involvedAnalyses,
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

  // ── Quality Audit (optional fourth pass) ──────────────────────────────
  // Opt-in via shouldAuditQuality — adds one extra AI call but catches the
  // rare code-level assertion that slips through all three prior passes.
  if (shouldAuditQuality && generatedFiles.length > 0) {
    logInfo('\n── Quality Audit pass ────────────────────────────────────────────');
    const auditableFiles = generatedFiles.map(generatedFile => ({
      fileName: generatedFile.suggestedOutputPath.split('/').pop() ?? generatedFile.suggestedOutputPath,
      testCode: generatedFile.testSourceCode,
      filePath: generatedFile.suggestedOutputPath,
    }));

    try {
      const auditResult = await auditGeneratedTests({
        generatedTestFiles: auditableFiles,
        appSpecContent: appSpec ?? null,
        aiClient,
      });

      const criticalFindingCount = auditResult.flaggedTests.filter(
        finding => finding.severity === 'critical',
      ).length;
      const warningFindingCount = auditResult.flaggedTests.filter(
        finding => finding.severity === 'warning',
      ).length;

      if (criticalFindingCount > 0) {
        logWarning(
          `Quality audit flagged ${criticalFindingCount} critical test(s) — review the suggestions above before committing.`,
        );
      }
      if (warningFindingCount > 0) {
        logWarning(`Quality audit issued ${warningFindingCount} warning(s).`);
      }
    } catch (auditError) {
      // Non-fatal: quality audit failure should never block test generation output
      logWarning(`Quality audit step failed unexpectedly: ${String(auditError)}`);
    }
  }

  return {
    generatedFiles,
    failedFlowCount,
    totalAssertionCount,
  };
}

// ── Run-and-Fix Feedback Loop ──────────────────────────────────────────────

/**
 * Maximum number of regeneration attempts per failing test file.
 * Two passes is enough for selector issues without risking infinite loops.
 * If a test still fails after two regeneration attempts, it likely reveals
 * a genuine bug or missing feature — leave it as-is.
 */
const MAX_REGENERATION_ATTEMPTS = 2;

/** Options for the run-and-fix pass. */
export interface RunAndFixOptions {
  targetAppUrl: string;
  outputDirectory: string;
  aiClient: AiClient;
  appSpec?: string;
  /**
   * Working directory to run Playwright from.
   * Should be the root of the user's project (where their playwright.config.ts lives).
   * Defaults to process.cwd().
   */
  workingDirectory?: string;
}

/** The outcome of the run-and-fix pass for a single test file. */
export interface TestFileFixResult {
  testFilePath: string;
  fileName: string;
  /** How the file ended up: passed on first run, fixed after regen, or still failing. */
  outcome: 'passed' | 'fixed' | 'still-failing' | 'likely-genuine-bug';
  /** Number of regeneration attempts made (0 if passed on first try). */
  regenerationAttemptCount: number;
}

/** Summary of the entire run-and-fix pass. */
export interface RunAndFixResult {
  suiteResult: GeneratedTestSuiteResult;
  fileOutcomes: TestFileFixResult[];
  /** Files that passed on the first run (no fixing needed). */
  passedOnFirstRunCount: number;
  /** Files that were fixed by regeneration. */
  fixedByRegenerationCount: number;
  /** Files that still fail after max regeneration attempts. */
  stillFailingCount: number;
}

/**
 * Attempts to regenerate a single failing test by sending the error back to AI.
 *
 * The AI diagnoses whether the failure is a locator/selector mismatch (fixable)
 * or a genuine behavioral mismatch (a real bug — leave failing as documentation).
 * Returns null if regeneration produces invalid code.
 */
async function regenerateFailingTestFile(
  generatedFile: GeneratedTestFile,
  errorOutput: string,
  targetAppUrl: string,
  aiClient: AiClient,
  appSpec: string | undefined,
): Promise<GeneratedTestFile | null> {
  logDebug(`  Regenerating test for "${generatedFile.sourceFlow.flowName}"...`);

  const regenMessages = buildTestRegenerationPrompt(
    generatedFile.sourceFlow,
    generatedFile.testSourceCode,
    errorOutput,
    targetAppUrl,
    appSpec,
  );

  let aiResponse;
  try {
    aiResponse = await aiClient.chat(regenMessages, `regenerate: ${generatedFile.sourceFlow.flowName}`);
  } catch (callError) {
    logWarning(`AI regeneration call failed for "${generatedFile.sourceFlow.flowName}": ${String(callError)}`);
    return null;
  }

  const regenCode = sanitizeGeneratedTestCode(aiResponse.content);

  // Only accept the regenerated version if it's still valid Playwright test code
  if (!regenCode.includes('import') || (!regenCode.includes('test(') && !regenCode.includes('it('))) {
    logWarning(`Regenerated code for "${generatedFile.sourceFlow.flowName}" is not valid Playwright tests — keeping original`);
    return null;
  }

  return {
    ...generatedFile,
    testSourceCode: regenCode,
    assertionSummary: extractAssertionSummary(regenCode),
  };
}

/**
 * Runs all generated test files, then attempts to fix any that fail by sending
 * the Playwright error back to AI for diagnosis and regeneration.
 *
 * This is the key feedback loop that closes the gap between "AI-generated tests"
 * and "tests that actually run". Most first-pass failures are selector mismatches
 * (the AI guessed `getByRole('button', { name: 'Submit' })` but the actual button
 * says 'Save Changes'). The AI can fix these trivially when it sees the error.
 *
 * Tests that still fail after MAX_REGENERATION_ATTEMPTS likely reveal genuine
 * behavioral bugs — they are left as-is (red tests) which is the correct outcome.
 *
 * @param generatedFiles - The files to run and fix (must already be written to disk)
 * @param options - Configuration for running and AI regeneration
 */
export async function runAndFixGeneratedTests(
  generatedFiles: GeneratedTestFile[],
  options: RunAndFixOptions,
): Promise<RunAndFixResult> {
  const {
    targetAppUrl,
    outputDirectory,
    aiClient,
    appSpec,
    workingDirectory = process.cwd(),
  } = options;

  if (generatedFiles.length === 0) {
    return {
      suiteResult: {
        passedFileCount: 0,
        failedFileCount: 0,
        totalFileCount: 0,
        fileResults: [],
        failedFiles: [],
      },
      fileOutcomes: [],
      passedOnFirstRunCount: 0,
      fixedByRegenerationCount: 0,
      stillFailingCount: 0,
    };
  }

  const absoluteTestPaths = generatedFiles.map(file => resolve(file.suggestedOutputPath));

  // ── First run: establish baseline pass/fail ────────────────────────────
  const initialSuiteResult = await runGeneratedTestFiles(absoluteTestPaths, workingDirectory);

  const fileOutcomes: TestFileFixResult[] = [];
  let fixedByRegenerationCount = 0;
  let stillFailingCount = 0;

  // ── Regeneration loop for failed files ────────────────────────────────
  for (const failedFileResult of initialSuiteResult.failedFiles) {
    // Find the corresponding GeneratedTestFile object to pass to the AI
    const originalGeneratedFile = generatedFiles.find(
      file => resolve(file.suggestedOutputPath) === failedFileResult.testFilePath,
    );

    if (!originalGeneratedFile) {
      logWarning(`Could not find generated file record for ${failedFileResult.fileName} — skipping regeneration`);
      fileOutcomes.push({
        testFilePath: failedFileResult.testFilePath,
        fileName: failedFileResult.fileName,
        outcome: 'still-failing',
        regenerationAttemptCount: 0,
      });
      stillFailingCount++;
      continue;
    }

    logInfo(`\nAttempting to fix: ${failedFileResult.fileName}`);

    let currentTestFile = originalGeneratedFile;
    let currentErrorOutput = failedFileResult.errorSummary;
    let wasFixed = false;
    let attemptCount = 0;

    // Regeneration loop — try up to MAX_REGENERATION_ATTEMPTS times
    for (let attemptNumber = 1; attemptNumber <= MAX_REGENERATION_ATTEMPTS; attemptNumber++) {
      attemptCount = attemptNumber;

      const regeneratedFile = await regenerateFailingTestFile(
        currentTestFile,
        currentErrorOutput,
        targetAppUrl,
        aiClient,
        appSpec,
      );

      if (!regeneratedFile) {
        logWarning(`  Attempt ${attemptNumber}: Regeneration produced no valid code`);
        break;
      }

      // Write the regenerated code to disk and re-run to see if it passes now
      writeFileSync(resolve(regeneratedFile.suggestedOutputPath), regeneratedFile.testSourceCode, 'utf-8');
      logDebug(`  Attempt ${attemptNumber}: Wrote regenerated test, re-running...`);

      const rerunResult = await runGeneratedTestFiles([regeneratedFile.suggestedOutputPath], workingDirectory);

      if (rerunResult.passedFileCount === 1) {
        logSuccess(`  ✓ Fixed after ${attemptNumber} attempt${attemptNumber > 1 ? 's' : ''}: ${failedFileResult.fileName}`);
        currentTestFile = regeneratedFile;
        wasFixed = true;
        break;
      }

      // Still failing — update for next attempt with fresh error output
      logDebug(`  Attempt ${attemptNumber}: Still failing, trying again...`);
      const rerunFailedResult = rerunResult.failedFiles[0];
      currentErrorOutput = rerunFailedResult?.errorSummary ?? currentErrorOutput;
      currentTestFile = regeneratedFile;
    }

    if (wasFixed) {
      fixedByRegenerationCount++;
      fileOutcomes.push({
        testFilePath: failedFileResult.testFilePath,
        fileName: failedFileResult.fileName,
        outcome: 'fixed',
        regenerationAttemptCount: attemptCount,
      });
    } else {
      stillFailingCount++;
      // A test that survives MAX_REGENERATION_ATTEMPTS likely reveals a real behavioral gap
      const isLikelyGenuineBug = attemptCount >= MAX_REGENERATION_ATTEMPTS;
      const outcome = isLikelyGenuineBug ? 'likely-genuine-bug' : 'still-failing';

      if (isLikelyGenuineBug) {
        logWarning(`  ⚑ ${failedFileResult.fileName} — may reveal a real behavioral bug. Keeping as a red test.`);
      }

      fileOutcomes.push({
        testFilePath: failedFileResult.testFilePath,
        fileName: failedFileResult.fileName,
        outcome,
        regenerationAttemptCount: attemptCount,
      });
    }
  }

  // Add outcomes for files that passed on the first run
  for (const passedFile of initialSuiteResult.fileResults.filter(result => result.didPass)) {
    fileOutcomes.push({
      testFilePath: passedFile.testFilePath,
      fileName: passedFile.fileName,
      outcome: 'passed',
      regenerationAttemptCount: 0,
    });
  }

  return {
    suiteResult: initialSuiteResult,
    fileOutcomes,
    passedOnFirstRunCount: initialSuiteResult.passedFileCount,
    fixedByRegenerationCount,
    stillFailingCount,
  };
}
