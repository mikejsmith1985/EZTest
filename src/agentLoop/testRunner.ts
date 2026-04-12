/**
 * Shared utility for running Playwright test files from within EZTest's agent loop.
 *
 * Reproduction and validation tests need to be executed programmatically so the agent
 * can inspect their pass/fail status and captured output. This module handles the
 * cross-platform child process mechanics so other modules can stay focused on logic.
 */
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

/** The result of a programmatic Playwright test run. */
export interface TestRunResult {
  /** Process exit code: 0 = all tests passed, non-zero = at least one test failed */
  exitCode: number;
  /** Combined stdout + stderr output from the test run */
  output: string;
  /** Whether all tests in the file passed */
  didAllTestsPass: boolean;
}

/** Options for running a test file. */
export interface TestRunOptions {
  /**
   * The working directory to run the test from.
   * Should be the root of the target project (where node_modules lives).
   */
  workingDirectory: string;
  /**
   * The Playwright project to use. Defaults to 'e2e'.
   * Use 'e2e' for reproduction/validation tests against a live app.
   */
  playwrightProjectName?: string;
  /**
   * Maximum time to wait for the test run in milliseconds.
   * Defaults to 90 seconds.
   */
  timeoutMs?: number;
}

/** Default test run timeout: 90 seconds is generous for UI tests. */
const DEFAULT_RUN_TIMEOUT_MS = 90_000;

/**
 * Runs a single Playwright test file and returns the result.
 *
 * Uses `npx playwright test <file> --project=<project>` so the command works
 * regardless of how Playwright is installed (local or global).
 *
 * The `shell: true` option is required on Windows where `npx` is a `.cmd` script.
 */
export async function runPlaywrightTestFile(
  testFilePath: string,
  options: TestRunOptions,
): Promise<TestRunResult> {
  const {
    workingDirectory,
    playwrightProjectName = 'e2e',
    timeoutMs = DEFAULT_RUN_TIMEOUT_MS,
  } = options;

  // Resolve to an absolute path so Playwright can find it regardless of cwd
  const absoluteTestFilePath = resolve(workingDirectory, testFilePath);

  return new Promise(resolvePromise => {
    const playwrightArgs = [
      'playwright',
      'test',
      absoluteTestFilePath,
      `--project=${playwrightProjectName}`,
      '--reporter=line',
    ];

    const playwrightProcess = spawn('npx', playwrightArgs, {
      cwd: workingDirectory,
      shell: true, // Required on Windows for npx to resolve correctly
    });

    let combinedOutput = '';
    playwrightProcess.stdout.on('data', chunk => { combinedOutput += chunk.toString(); });
    playwrightProcess.stderr.on('data', chunk => { combinedOutput += chunk.toString(); });

    // Safety timeout: kill the process if it runs too long
    const killTimer = setTimeout(() => {
      playwrightProcess.kill();
      combinedOutput += `\n[EZTest] Test run timed out after ${timeoutMs}ms`;
    }, timeoutMs);

    playwrightProcess.on('close', exitCode => {
      clearTimeout(killTimer);
      const resolvedExitCode = exitCode ?? 1;
      resolvePromise({
        exitCode: resolvedExitCode,
        output: combinedOutput,
        didAllTestsPass: resolvedExitCode === 0,
      });
    });
  });
}
