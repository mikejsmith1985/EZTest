/**
 * Test Reproducer — generates a failing Playwright test that reproduces a reported bug,
 * then runs it to confirm the bug is reproducible before any fix is attempted.
 *
 * This is Step 1 of the EZTest Agent Feedback Loop:
 *   reproduce → fix → validate
 *
 * Why reproduce first? Because if we can't reproduce the bug automatically, there is no
 * way to verify that a code fix actually solved it. A failing test is the contract between
 * the bug report and the code fix.
 */
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { BugReport, ReproductionAttempt } from '../shared/types.js';
import type { AiClient } from '../shared/aiClient.js';
import { buildBugReproductionPrompt } from '../synthesizer/promptTemplates.js';
import { formatInteractionHistoryForPrompt } from '../recorder/bugReportBuilder.js';
import { runPlaywrightTestFile } from './testRunner.js';
import { logInfo, logSuccess, logWarning, logDebug } from '../shared/logger.js';

/** Where EZTest writes reproduction test files, relative to the project root. */
const REPRODUCTIONS_BASE_DIRECTORY = 'tests/reproductions';

// ── File Writing ───────────────────────────────────────────────────────────

/**
 * Writes the AI-generated test code to the designated reproductions directory.
 * Creates the directory tree if it doesn't exist.
 * Returns the absolute path of the written test file.
 */
function writeReproductionTestFile(
  testCode: string,
  bugReportId: string,
  projectRoot: string,
): string {
  const reproductionDirectory = resolve(
    projectRoot,
    REPRODUCTIONS_BASE_DIRECTORY,
    bugReportId,
  );

  if (!existsSync(reproductionDirectory)) {
    mkdirSync(reproductionDirectory, { recursive: true });
  }

  const testFilePath = join(reproductionDirectory, 'reproduction.spec.ts');
  writeFileSync(testFilePath, testCode, 'utf-8');
  logDebug(`Reproduction test written to: ${testFilePath}`);

  return testFilePath;
}

// ── Public API ─────────────────────────────────────────────────────────────

/** Options for generating and running a reproduction test. */
export interface ReproductionOptions {
  /** Root directory of the target project (where playwright.config.ts lives). */
  projectRoot: string;
  /** URL where the target application is running. */
  targetAppUrl: string;
}

/**
 * Generates a Playwright test that reproduces the reported bug, writes it to disk,
 * then runs it to confirm the bug is present (i.e., the test should FAIL).
 *
 * A successful reproduction means: exit code != 0 (the test failed, proving the bug exists).
 * An unsuccessful reproduction means: exit code 0 (the test passed — the AI-generated
 * test may not have captured the bug correctly).
 */
export async function generateAndRunReproductionTest(
  bugReport: BugReport,
  aiClient: AiClient,
  options: ReproductionOptions,
): Promise<ReproductionAttempt> {
  const { projectRoot, targetAppUrl } = options;

  logInfo(`[Reproduce] Generating reproduction test for bug ${bugReport.reportId}...`);

  // Format the interaction history into numbered steps the AI can reason about
  const interactionSteps = formatInteractionHistoryForPrompt(bugReport.interactionHistory);

  // Note whether a screenshot was captured — the AI can use this as additional context
  const screenshotDescription = bugReport.screenshotAtFlag
    ? 'A screenshot was captured at the moment the user flagged this issue.'
    : null;

  const reproductionPromptMessages = buildBugReproductionPrompt(
    interactionSteps,
    bugReport.userExpectation,
    bugReport.domStateAtFlag,
    screenshotDescription,
    targetAppUrl,
  );

  // Ask the AI to write a test that reproduces the exact sequence of user actions
  const aiResponse = await aiClient.chat(
    reproductionPromptMessages,
    `generate reproduction test for bug ${bugReport.reportId}`,
  );

  const reproductionTestCode = aiResponse.content;
  logDebug(`Reproduction test generated (${reproductionTestCode.length} chars, ${aiResponse.tokensUsed} tokens)`);

  // Write the test to disk so Playwright can run it
  const testFilePath = writeReproductionTestFile(reproductionTestCode, bugReport.reportId, projectRoot);

  // Run the test — it should FAIL because the bug is still present
  logInfo(`[Reproduce] Running reproduction test...`);
  const testRunResult = await runPlaywrightTestFile(testFilePath, {
    workingDirectory: projectRoot,
    playwrightProjectName: 'e2e',
  });

  // A non-zero exit code = test failed = bug confirmed as reproducible
  const wasReproductionSuccessful = !testRunResult.didAllTestsPass;

  if (wasReproductionSuccessful) {
    logSuccess(`[Reproduce] Bug confirmed. Test failed as expected — reproduction saved at: ${testFilePath}`);
  } else {
    logWarning(
      `[Reproduce] Test passed when it should have failed. ` +
      `The AI-generated test may not have captured the bug correctly. ` +
      `Review the test at: ${testFilePath}`,
    );
  }

  return {
    bugReportId: bugReport.reportId,
    reproductionTestCode,
    wasReproductionSuccessful,
    testRunOutput: testRunResult.output,
  };
}
