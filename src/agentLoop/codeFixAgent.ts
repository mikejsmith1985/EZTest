/**
 * Code Fix Agent — analyzes a failing reproduction test alongside the application source code,
 * asks the AI to identify the root cause, and applies a targeted fix to the source files.
 *
 * This is Step 2 of the EZTest Agent Feedback Loop:
 *   reproduce → fix → validate
 *
 * The agent uses a search/replace strategy (rather than full file rewrites) to minimize
 * the risk of the AI accidentally removing or altering unrelated code.
 *
 * After applying the fix, the agent re-runs the reproduction test to confirm it now passes.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, relative, join } from 'node:path';
import { glob } from 'glob';
import type { BugReport, ReproductionAttempt, CodeFixResult } from '../shared/types.js';
import type { AiClient } from '../shared/aiClient.js';
import { buildCodeFixPrompt } from '../synthesizer/promptTemplates.js';
import { runPlaywrightTestFile } from './testRunner.js';
import { logInfo, logSuccess, logWarning, logError, logDebug } from '../shared/logger.js';

// ── Constants ──────────────────────────────────────────────────────────────

/**
 * Maximum number of source files to send to the AI.
 * Sending more files gives the AI more context but increases token cost and
 * the chance of the AI getting confused by irrelevant code.
 */
const MAX_SOURCE_FILES_FOR_ANALYSIS = 15;

/**
 * Maximum characters to include per source file.
 * Keeps individual files from dominating the context window.
 */
const MAX_CHARS_PER_SOURCE_FILE = 3_000;

/** File extensions to include in the source file scan. */
const SOURCE_FILE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.vue', '.svelte'];

// ── Types ──────────────────────────────────────────────────────────────────

/**
 * A single search/replace operation parsed from the AI's JSON response.
 * The agent applies these sequentially to produce the code fix.
 */
interface FileChangeOperation {
  filePath: string;
  searchText: string;
  replacementText: string;
}

/**
 * The structured JSON response the AI returns for a code fix.
 */
interface CodeFixAiResponse {
  rootCause: string;
  fixDescription: string;
  fileChanges: FileChangeOperation[];
}

// ── Source File Discovery ──────────────────────────────────────────────────

/**
 * Reads the most relevant source files for AI analysis.
 * Returns up to MAX_SOURCE_FILES_FOR_ANALYSIS files with content truncated to
 * MAX_CHARS_PER_SOURCE_FILE characters each.
 */
async function readSourceFilesForAnalysis(
  sourceDirectory: string,
): Promise<Array<{ filePath: string; content: string }>> {
  // Normalize to forward slashes — glob requires this on Windows
  const normalizedSourceDirectory = sourceDirectory.replace(/\\/g, '/');
  const extensionPattern = SOURCE_FILE_EXTENSIONS.join(',');
  const globPattern = `${normalizedSourceDirectory}/**/*{${extensionPattern}}`;

  const allSourceFiles = await glob(globPattern, {
    absolute: true,
    ignore: ['**/node_modules/**', '**/dist/**', '**/*.spec.*', '**/*.test.*'],
  });

  // Limit to a reasonable number to control token usage
  const selectedSourceFiles = allSourceFiles.slice(0, MAX_SOURCE_FILES_FOR_ANALYSIS);

  return selectedSourceFiles.map(absoluteFilePath => {
    const rawContent = readFileSync(absoluteFilePath, 'utf-8');
    const truncatedContent = rawContent.length > MAX_CHARS_PER_SOURCE_FILE
      ? rawContent.slice(0, MAX_CHARS_PER_SOURCE_FILE) + '\n// ... (truncated)'
      : rawContent;

    return {
      // Use relative paths in the prompt — more readable and portable
      filePath: relative(sourceDirectory, absoluteFilePath).replace(/\\/g, '/'),
      content: truncatedContent,
    };
  });
}

// ── AI Response Parsing ────────────────────────────────────────────────────

/**
 * Parses the AI's JSON response for the code fix.
 * Handles common AI output mistakes like markdown fences wrapping the JSON.
 */
function parseCodeFixAiResponse(aiResponseContent: string): CodeFixAiResponse {
  // Strip markdown code fences if the AI wrapped its JSON (a common mistake)
  const jsonContent = aiResponseContent
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim();

  try {
    return JSON.parse(jsonContent) as CodeFixAiResponse;
  } catch {
    throw new Error(
      `AI returned invalid JSON for code fix. Raw response:\n${aiResponseContent.slice(0, 500)}`
    );
  }
}

// ── File Change Application ────────────────────────────────────────────────

/**
 * Applies a single search/replace operation to a source file.
 * Returns true if the replacement was made, false if the searchText wasn't found.
 *
 * Uses exact string matching — the AI is instructed to provide unique, multi-line
 * search strings to avoid false matches on short or common code fragments.
 */
function applyFileChangeOperation(
  fileChange: FileChangeOperation,
  sourceDirectory: string,
): boolean {
  const absoluteFilePath = resolve(sourceDirectory, fileChange.filePath);

  let fileContent: string;
  try {
    fileContent = readFileSync(absoluteFilePath, 'utf-8');
  } catch {
    logWarning(`[Fix] Could not read file: ${absoluteFilePath}`);
    return false;
  }

  if (!fileContent.includes(fileChange.searchText)) {
    logWarning(
      `[Fix] Search text not found in ${fileChange.filePath}. ` +
      `The AI may have hallucinated or the file has changed. ` +
      `Skipping this change.`,
    );
    logDebug(`[Fix] Searched for:\n${fileChange.searchText}`);
    return false;
  }

  // Apply only the first occurrence — the searchText should be unique enough
  const updatedContent = fileContent.replace(fileChange.searchText, fileChange.replacementText);
  writeFileSync(absoluteFilePath, updatedContent, 'utf-8');

  logSuccess(`[Fix] Applied change to: ${fileChange.filePath}`);
  return true;
}

// ── Public API ─────────────────────────────────────────────────────────────

/** Options for running the code fix agent. */
export interface CodeFixOptions {
  /** Root directory of the target project (where playwright.config.ts lives). */
  projectRoot: string;
  /** URL where the target application is running. */
  targetAppUrl: string;
  /**
   * Source code directory to scan for relevant files.
   * Defaults to bugReport.sourceDirectory if not provided.
   */
  sourceDirectory?: string;
}

/**
 * Analyzes a failing reproduction test alongside the application source code,
 * applies an AI-generated fix, then verifies the fix by re-running the reproduction test.
 *
 * Returns a CodeFixResult describing what was changed and whether the fix was verified.
 *
 * IMPORTANT: This function modifies source files in-place. It should only be used
 * in a workflow where changes can be reviewed and reverted (e.g., a git working tree).
 */
export async function analyzeAndApplyCodeFix(
  reproductionAttempt: ReproductionAttempt,
  bugReport: BugReport,
  aiClient: AiClient,
  options: CodeFixOptions,
): Promise<CodeFixResult> {
  const { projectRoot, targetAppUrl } = options;
  const sourceDirectory = options.sourceDirectory ?? bugReport.sourceDirectory;

  if (!sourceDirectory) {
    throw new Error(
      'Cannot analyze code fix: no sourceDirectory provided in options or bug report. ' +
      'Pass sourceDirectory in CodeFixOptions or include it in the BugReport.'
    );
  }

  logInfo(`[Fix] Analyzing bug ${bugReport.reportId} for a code fix...`);

  // Read the application source files to give the AI context
  const sourceFileContents = await readSourceFilesForAnalysis(sourceDirectory);
  logInfo(`[Fix] Loaded ${sourceFileContents.length} source files for analysis`);

  // Build the fix prompt with the failing test + source code context
  const codeFixPromptMessages = buildCodeFixPrompt(
    reproductionAttempt.reproductionTestCode,
    sourceFileContents,
    bugReport.userExpectation,
    targetAppUrl,
  );

  const aiResponse = await aiClient.chat(
    codeFixPromptMessages,
    `analyze and fix bug ${bugReport.reportId}`,
  );

  // Parse the structured JSON response
  const fixResponse = parseCodeFixAiResponse(aiResponse.content);
  logInfo(`[Fix] Root cause identified: ${fixResponse.rootCause}`);
  logInfo(`[Fix] Proposed fix: ${fixResponse.fixDescription}`);
  logInfo(`[Fix] Files to change: ${fixResponse.fileChanges.length}`);

  // Apply all file changes
  const changedFiles = new Map<string, string>();
  for (const fileChange of fixResponse.fileChanges) {
    const wasChangeApplied = applyFileChangeOperation(fileChange, sourceDirectory);
    if (wasChangeApplied) {
      changedFiles.set(
        join(sourceDirectory, fileChange.filePath),
        readFileSync(resolve(sourceDirectory, fileChange.filePath), 'utf-8'),
      );
    }
  }

  if (changedFiles.size === 0) {
    logWarning(`[Fix] No file changes were successfully applied. The fix may need manual review.`);
  }

  // Re-run the reproduction test to verify the fix
  logInfo(`[Fix] Verifying fix by re-running reproduction test...`);
  const reproductionTestFilePath = `tests/reproductions/${bugReport.reportId}/reproduction.spec.ts`;

  const verificationRunResult = await runPlaywrightTestFile(reproductionTestFilePath, {
    workingDirectory: projectRoot,
    playwrightProjectName: 'e2e',
  });

  const doesReproductionTestPass = verificationRunResult.didAllTestsPass;

  if (doesReproductionTestPass) {
    logSuccess(`[Fix] Reproduction test now PASSES. Bug is fixed.`);
  } else {
    logWarning(
      `[Fix] Reproduction test still FAILS after applying the fix. ` +
      `The fix may be incomplete. Review the changes and re-run.`,
    );
    logError(`[Fix] Test output:\n${verificationRunResult.output}`);
  }

  return {
    bugReportId: bugReport.reportId,
    fixDescription: `${fixResponse.rootCause} — ${fixResponse.fixDescription}`,
    changedFiles,
    doesReproductionTestPass,
    // Validation suite hasn't run yet — will be set by validationSuite module
    doesValidationSuitePass: false,
  };
}
