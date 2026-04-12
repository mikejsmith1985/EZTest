/**
 * Generated Test Runner — runs freshly generated Playwright test files against a live app
 * and returns per-file pass/fail results with captured error output for the regeneration loop.
 *
 * This module is the execution half of the run-and-fix feedback loop. It runs each
 * generated test file individually so that failures in one test don't block others,
 * and captures the Playwright error output per file so the AI can diagnose and fix.
 */
import { spawn } from 'node:child_process';
import { resolve, basename } from 'node:path';
import { logDebug, logInfo, logSuccess, logWarning } from '../shared/logger.js';

// ── Constants ──────────────────────────────────────────────────────────────

/**
 * Maximum milliseconds to wait for a single test file to complete.
 * 120 seconds is generous enough for slow network conditions while
 * preventing the process from hanging forever if the app goes down mid-run.
 */
const TEST_FILE_RUN_TIMEOUT_MS = 120_000;

/**
 * Maximum characters of Playwright error output to capture per file.
 * Keeps memory bounded while preserving the stack trace and assertion message
 * that the regeneration AI needs to diagnose the failure.
 */
const MAX_ERROR_OUTPUT_CHARS = 4000;

// ── Types ──────────────────────────────────────────────────────────────────

/** The result of running a single generated test file. */
export interface SingleTestFileResult {
  /** Absolute path to the test file. */
  testFilePath: string;
  /** Short filename for display (no path). */
  fileName: string;
  /** Whether all tests in this file passed. */
  didPass: boolean;
  /** The captured Playwright output (stdout + stderr). Truncated if very long. */
  rawOutput: string;
  /** The relevant failure message extracted from the output. Empty if passed. */
  errorSummary: string;
}

/** Summary of running all generated tests in a directory. */
export interface GeneratedTestSuiteResult {
  /** Number of test files that passed. */
  passedFileCount: number;
  /** Number of test files that failed. */
  failedFileCount: number;
  /** Total files attempted. */
  totalFileCount: number;
  /** Per-file results for all files. */
  fileResults: SingleTestFileResult[];
  /** Only the files that failed (subset of fileResults). */
  failedFiles: SingleTestFileResult[];
}

// ── Core Runner ────────────────────────────────────────────────────────────

/**
 * Runs a single Playwright test file and captures its output.
 *
 * Runs `npx playwright test <file> --reporter=line` from the given working directory.
 * The `--reporter=line` format gives compact output with full error messages, which is
 * ideal for the regeneration AI (not too much noise, enough context to diagnose failures).
 *
 * Does NOT use `--project=<name>` so it works whether or not the user's project
 * has named Playwright projects configured.
 */
async function runSingleTestFile(
  absoluteTestFilePath: string,
  workingDirectory: string,
): Promise<SingleTestFileResult> {
  const fileName = basename(absoluteTestFilePath);

  return new Promise(resolveResult => {
    const playwrightArgs = [
      'playwright',
      'test',
      absoluteTestFilePath,
      '--reporter=line',
    ];

    const playwrightProcess = spawn('npx', playwrightArgs, {
      cwd: workingDirectory,
      shell: true, // Required on Windows where npx is a .cmd script
    });

    let combinedOutput = '';
    playwrightProcess.stdout.on('data', (chunk: Buffer) => {
      combinedOutput += chunk.toString();
    });
    playwrightProcess.stderr.on('data', (chunk: Buffer) => {
      combinedOutput += chunk.toString();
    });

    // Kill the process if it exceeds the timeout — prevents hanging if the app goes down
    const killTimer = setTimeout(() => {
      playwrightProcess.kill();
      combinedOutput += `\n[EZTest] Test run timed out after ${TEST_FILE_RUN_TIMEOUT_MS}ms`;
    }, TEST_FILE_RUN_TIMEOUT_MS);

    playwrightProcess.on('close', (exitCode: number | null) => {
      clearTimeout(killTimer);
      const resolvedExitCode = exitCode ?? 1;
      const didPass = resolvedExitCode === 0;

      const truncatedOutput = combinedOutput.slice(0, MAX_ERROR_OUTPUT_CHARS);
      const errorSummary = didPass ? '' : extractErrorSummary(combinedOutput);

      resolveResult({
        testFilePath: absoluteTestFilePath,
        fileName,
        didPass,
        rawOutput: truncatedOutput,
        errorSummary,
      });
    });
  });
}

/**
 * Extracts the most relevant portion of Playwright's error output for AI diagnosis.
 * Playwright output contains a lot of progress logging — we only need the actual
 * failure message, which typically appears after "Error:" or between markers.
 */
function extractErrorSummary(rawOutput: string): string {
  // Playwright error messages typically start with "Error:" or contain "●"
  const errorLinePattern = /(?:Error:|●|expect\(|TimeoutError|locator\.)/m;
  const firstErrorIndex = rawOutput.search(errorLinePattern);

  if (firstErrorIndex === -1) {
    // No recognizable error pattern — return the last 1000 chars which usually has the summary
    return rawOutput.slice(-1000);
  }

  // Return from the first error up to the character limit
  return rawOutput.slice(firstErrorIndex, firstErrorIndex + 2000);
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Runs a list of generated test files against the live app and returns per-file results.
 *
 * Tests run SEQUENTIALLY (not in parallel) because:
 * 1. They all hit the same live app — parallel runs can cause race conditions
 * 2. Output from parallel runs gets interleaved and is hard for AI to diagnose
 * 3. The failure feedback is per-file, so sequential gives clean isolated results
 *
 * @param testFilePaths - Absolute paths to the test files to run
 * @param workingDirectory - Directory to run playwright from (user's project root)
 */
export async function runGeneratedTestFiles(
  testFilePaths: string[],
  workingDirectory: string,
): Promise<GeneratedTestSuiteResult> {
  if (testFilePaths.length === 0) {
    return {
      passedFileCount: 0,
      failedFileCount: 0,
      totalFileCount: 0,
      fileResults: [],
      failedFiles: [],
    };
  }

  logInfo(`\nRunning ${testFilePaths.length} generated test files to validate...`);

  const fileResults: SingleTestFileResult[] = [];

  for (const testFilePath of testFilePaths) {
    const absolutePath = resolve(testFilePath);
    logDebug(`  Running: ${basename(absolutePath)}`);

    const result = await runSingleTestFile(absolutePath, workingDirectory);

    if (result.didPass) {
      logSuccess(`  ✓ ${result.fileName}`);
    } else {
      logWarning(`  ✗ ${result.fileName}`);
      logDebug(`    Error: ${result.errorSummary.slice(0, 200)}`);
    }

    fileResults.push(result);
  }

  const passedFiles = fileResults.filter(result => result.didPass);
  const failedFiles = fileResults.filter(result => !result.didPass);

  logInfo(`\nTest run complete: ${passedFiles.length}/${testFilePaths.length} files passed`);

  return {
    passedFileCount: passedFiles.length,
    failedFileCount: failedFiles.length,
    totalFileCount: testFilePaths.length,
    fileResults,
    failedFiles,
  };
}
