/**
 * Validation Suite Generator — generates and runs a comprehensive test suite AFTER a code fix
 * to confirm the fix is complete and no regressions were introduced.
 *
 * This is Step 3 of the EZTest Agent Feedback Loop:
 *   reproduce → fix → validate
 *
 * The validation suite contains:
 *  - A positive test confirming the fixed scenario works correctly
 *  - Negative tests for related edge cases (similar bugs that might be hiding nearby)
 *  - A boundary condition test if the fix touches numeric or string boundaries
 *
 * All tests must pass for the fix to be considered complete.
 */
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { BugReport, CodeFixResult } from '../shared/types.js';
import type { AiClient } from '../shared/aiClient.js';
import { buildValidationSuitePrompt } from '../synthesizer/promptTemplates.js';
import { runPlaywrightTestFile } from './testRunner.js';
import { logInfo, logSuccess, logWarning, logDebug } from '../shared/logger.js';

/** Where EZTest writes validation test files, relative to the project root. */
const VALIDATIONS_BASE_DIRECTORY = 'tests/validations';

// ── Types ──────────────────────────────────────────────────────────────────

/** The outcome of running the validation suite after a code fix. */
export interface ValidationSuiteResult {
  bugReportId: string;
  /** Whether all tests in the validation suite passed. */
  didAllValidationTestsPass: boolean;
  /** The generated validation test code. */
  validationTestCode: string;
  /** Path where the validation test was written. */
  validationTestFilePath: string;
  /** Full output from the test run. */
  testRunOutput: string;
}

// ── File Writing ───────────────────────────────────────────────────────────

/**
 * Writes the AI-generated validation test suite to the designated validations directory.
 * Returns the absolute path of the written test file.
 */
function writeValidationTestFile(
  testCode: string,
  bugReportId: string,
  projectRoot: string,
): string {
  const validationDirectory = resolve(
    projectRoot,
    VALIDATIONS_BASE_DIRECTORY,
    bugReportId,
  );

  if (!existsSync(validationDirectory)) {
    mkdirSync(validationDirectory, { recursive: true });
  }

  const testFilePath = join(validationDirectory, 'validation.spec.ts');
  writeFileSync(testFilePath, testCode, 'utf-8');
  logDebug(`Validation test suite written to: ${testFilePath}`);

  return testFilePath;
}

// ── Public API ─────────────────────────────────────────────────────────────

/** Options for generating and running the validation suite. */
export interface ValidationSuiteOptions {
  /** Root directory of the target project (where playwright.config.ts lives). */
  projectRoot: string;
  /** URL where the target application is running. */
  targetAppUrl: string;
}

/**
 * Generates a comprehensive validation test suite from the bug fix context,
 * writes it to disk, and runs it to confirm the fix is solid.
 *
 * This should only be called AFTER the reproduction test passes (i.e., after the fix).
 * The suite includes both positive tests (fix works) and negative tests (no new bugs).
 */
export async function generateAndRunValidationSuite(
  codeFixResult: CodeFixResult,
  bugReport: BugReport,
  reproductionTestCode: string,
  aiClient: AiClient,
  options: ValidationSuiteOptions,
): Promise<ValidationSuiteResult> {
  const { projectRoot, targetAppUrl } = options;

  logInfo(`[Validate] Generating validation suite for bug ${bugReport.reportId}...`);

  const validationPromptMessages = buildValidationSuitePrompt(
    // Combine the user's expectation with the root cause for a complete bug description
    `User reported: "${bugReport.userExpectation}" — Root cause: ${codeFixResult.fixDescription}`,
    codeFixResult.fixDescription,
    reproductionTestCode,
    targetAppUrl,
  );

  const aiResponse = await aiClient.chat(
    validationPromptMessages,
    `generate validation suite for bug ${bugReport.reportId}`,
  );

  const validationTestCode = aiResponse.content;
  logDebug(`Validation suite generated (${validationTestCode.length} chars, ${aiResponse.tokensUsed} tokens)`);

  const validationTestFilePath = writeValidationTestFile(validationTestCode, bugReport.reportId, projectRoot);

  logInfo(`[Validate] Running validation suite...`);
  const testRunResult = await runPlaywrightTestFile(validationTestFilePath, {
    workingDirectory: projectRoot,
    playwrightProjectName: 'e2e',
  });

  if (testRunResult.didAllTestsPass) {
    logSuccess(`[Validate] All validation tests passed! Fix is confirmed.`);
    logInfo(`[Validate] Validation suite saved at: ${validationTestFilePath}`);
  } else {
    logWarning(
      `[Validate] Some validation tests failed (exit code ${testRunResult.exitCode}). ` +
      `The fix may be incomplete or introduced a regression. ` +
      `Review: ${validationTestFilePath}`,
    );
  }

  return {
    bugReportId: bugReport.reportId,
    didAllValidationTestsPass: testRunResult.didAllTestsPass,
    validationTestCode,
    validationTestFilePath,
    testRunOutput: testRunResult.output,
  };
}
