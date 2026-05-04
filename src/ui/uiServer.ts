/**
 * UI Server — local Express + Socket.io server that powers the EZTest application.
 * Serves the main app page and provides the API + real-time log streaming
 * that lets users run EZTest workflows without touching the terminal.
 */
import { createServer } from 'node:http';
import { get as httpsGet } from 'node:https';
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, isAbsolute } from 'node:path';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import express from 'express';
import { Server as SocketIoServer, type Socket as SocketIoSocket } from 'socket.io';
import {
  isVersionNewer,
  PORTABLE_RELEASE_ASSET_NAME,
  selectPortableReleaseAsset,
  type GithubReleaseSummary,
} from '../shared/portableRelease.js';
import { buildWizardPageHtml } from './wizardPage.js';

// ── GitHub auto-update constants ───────────────────────────────────────────────

/** GitHub repo owner and name for the EZTest releases API. */
const GITHUB_RELEASES_OWNER = 'mikejsmith1985';
const GITHUB_RELEASES_REPO  = 'EZTest';

/** Directory names used by the staged portable updater. */
const PORTABLE_UPDATES_DIRECTORY_NAME = 'updates';
const STAGED_PORTABLE_UPDATE_DIRECTORY_NAME = 'pending-portable-update';

/**
 * Describes the result of checking GitHub releases for a newer version.
 * Used by the /api/update/check endpoint.
 */
interface UpdateCheckResult {
  hasUpdate:      boolean;
  currentVersion: string;
  latestVersion:  string;
  releaseUrl:     string;
  canInstallInApp: boolean;
}

/**
 * Fetches the latest release from the EZTest GitHub repo and returns its tag name
 * and HTML URL. Rejects with an error if the request fails or the response is
 * malformed. Uses Node's built-in https module — no external dependencies needed.
 */
function fetchLatestGithubRelease(): Promise<GithubReleaseSummary> {
  return new Promise((resolvePromise, rejectPromise) => {
    const requestOptions = {
      hostname: 'api.github.com',
      path:     '/repos/' + GITHUB_RELEASES_OWNER + '/' + GITHUB_RELEASES_REPO + '/releases/latest',
      headers:  {
        // GitHub API requires a User-Agent header to accept requests from scripts.
        'User-Agent': 'EZTest-auto-update/1.0',
        'Accept':     'application/vnd.github+json',
      },
    };

    const request = httpsGet(requestOptions, (response) => {
      let rawBody = '';
      response.on('data', (chunk: Buffer) => { rawBody += chunk.toString(); });
      response.on('end', () => {
        try {
          const parsed = JSON.parse(rawBody) as {
            tag_name?: string;
            html_url?: string;
            assets?: Array<{ name?: string; browser_download_url?: string }>;
          };
          if (!parsed.tag_name) {
            rejectPromise(new Error('GitHub API response missing tag_name'));
            return;
          }
          resolvePromise({
            tagName: parsed.tag_name,
            htmlUrl: parsed.html_url ?? '',
            assets: (parsed.assets ?? [])
              .filter((asset) => typeof asset.name === 'string' && typeof asset.browser_download_url === 'string')
              .map((asset) => ({
                name: asset.name as string,
                browserDownloadUrl: asset.browser_download_url as string,
              })),
          });
        } catch {
          rejectPromise(new Error('Failed to parse GitHub releases response'));
        }
      });
    });

    request.on('error', (networkError) => rejectPromise(networkError));
    // Timeout after 5 seconds — update checks should not block the UI from loading.
    request.setTimeout(5000, () => {
      request.destroy();
      rejectPromise(new Error('GitHub releases API request timed out'));
    });
  });
}

/**
 * Reads the current EZTest version from package.json in the install directory.
 * Falls back to '0.0.0' if the file cannot be read or the version field is absent.
 */
function readCurrentVersion(): string {
  try {
    const packageJsonPath = join(getEzTestRootDirectory(), 'package.json');
    const packageJson     = JSON.parse(readFileSync(packageJsonPath, 'utf-8')) as { version?: string };
    return packageJson.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** Returns the EZTest install root. In portable mode this is the extracted bundle folder. */
function getEzTestRootDirectory(): string {
  return process.cwd();
}

/** Returns the directory where downloaded portable updates are staged. */
function getStagedPortableUpdateDirectory(): string {
  return join(
    getEzTestRootDirectory(),
    PORTABLE_UPDATES_DIRECTORY_NAME,
    STAGED_PORTABLE_UPDATE_DIRECTORY_NAME,
  );
}

/** Downloads a file over HTTPS and follows GitHub's redirect responses automatically. */
function downloadFileOverHttps(downloadUrl: string, destinationFilePath: string): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    const request = httpsGet(downloadUrl, {
      headers: {
        'User-Agent': 'EZTest-portable-updater/1.0',
        'Accept': 'application/octet-stream',
      },
    }, (response) => {
      const statusCode = response.statusCode ?? 0;
      const redirectLocation = response.headers.location;

      if (statusCode >= 300 && statusCode < 400 && redirectLocation) {
        response.resume();
        downloadFileOverHttps(redirectLocation, destinationFilePath)
          .then(resolvePromise)
          .catch(rejectPromise);
        return;
      }

      if (statusCode !== 200) {
        response.resume();
        rejectPromise(new Error('Download failed with status code ' + statusCode));
        return;
      }

      const destinationStream = createWriteStream(destinationFilePath);
      response.pipe(destinationStream);

      destinationStream.on('finish', () => {
        destinationStream.close();
        resolvePromise();
      });

      destinationStream.on('error', (streamError) => {
        destinationStream.close();
        rejectPromise(streamError);
      });
    });

    request.on('error', (networkError) => rejectPromise(networkError));
    request.setTimeout(30_000, () => {
      request.destroy();
      rejectPromise(new Error('Portable update download timed out'));
    });
  });
}

/**
 * Extracts a portable zip file into the given destination directory using the
 * Windows built-in tar.exe (available since Windows 10 1803). This avoids
 * spawning PowerShell with -ExecutionPolicy Bypass, which triggers AV heuristics.
 */
function extractPortableArchive(zipFilePath: string, destinationDirectoryPath: string): Promise<void> {
  // tar.exe lives in System32 and is always on PATH on Windows 10+.
  // Flags: -x extract, -f archive file, -C change to destination before extracting.
  return new Promise((resolvePromise, rejectPromise) => {
    const extractProcess = spawn('tar.exe', [
      '-xf', zipFilePath,
      '-C', destinationDirectoryPath,
    ], {
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let errorOutput = '';

    extractProcess.stderr?.on('data', (errorChunk: Buffer) => {
      errorOutput += errorChunk.toString();
    });

    extractProcess.on('close', (exitCode) => {
      if (exitCode === 0) {
        resolvePromise();
        return;
      }

      rejectPromise(new Error(
        'Portable update extraction failed with exit code ' + String(exitCode) +
        (errorOutput.trim() ? ': ' + errorOutput.trim() : ''),
      ));
    });

    extractProcess.on('error', (processError) => rejectPromise(processError));
  });
}

/** Downloads the newest portable bundle and stages it for application on next launch. */
async function downloadAndStagePortableUpdate(): Promise<{ latestVersion: string }> {
  const latestRelease = await fetchLatestGithubRelease();
  const portableAsset = selectPortableReleaseAsset(latestRelease);

  if (!portableAsset) {
    throw new Error('Latest release does not contain the portable Windows bundle asset');
  }

  const stagedUpdateDirectoryPath = getStagedPortableUpdateDirectory();
  const temporaryZipFilePath = join(tmpdir(), 'eztest-portable-update-' + Date.now() + '.zip');

  rmSync(stagedUpdateDirectoryPath, { recursive: true, force: true });
  mkdirSync(stagedUpdateDirectoryPath, { recursive: true });

  try {
    await downloadFileOverHttps(portableAsset.browserDownloadUrl, temporaryZipFilePath);
    await extractPortableArchive(temporaryZipFilePath, stagedUpdateDirectoryPath);
  } catch (updateError) {
    rmSync(stagedUpdateDirectoryPath, { recursive: true, force: true });
    throw updateError;
  } finally {
    if (existsSync(temporaryZipFilePath)) {
      unlinkSync(temporaryZipFilePath);
    }
  }

  const stagedLauncherPath = join(stagedUpdateDirectoryPath, 'EZTest.exe');
  const stagedNodeRuntimePath = join(stagedUpdateDirectoryPath, 'node.exe');
  const stagedDependenciesDirectoryPath = join(stagedUpdateDirectoryPath, 'node_modules');
  const stagedPackageJsonPath = join(stagedUpdateDirectoryPath, 'package.json');
  const stagedCliEntryPath = join(stagedUpdateDirectoryPath, 'dist', 'cli', 'index.js');

  if (
    !existsSync(stagedLauncherPath) ||
    !existsSync(stagedNodeRuntimePath) ||
    !existsSync(stagedDependenciesDirectoryPath) ||
    !existsSync(stagedPackageJsonPath) ||
    !existsSync(stagedCliEntryPath)
  ) {
    rmSync(stagedUpdateDirectoryPath, { recursive: true, force: true });
    throw new Error('Downloaded portable bundle is missing required runtime files');
  }

  return { latestVersion: latestRelease.tagName.replace(/^v/, '') };
}



/**
 * Settings EZTest remembers between sessions: which project to use,
 * what URL the user's app runs on, etc. Stored in app-config.json
 * in the EZTest install directory (never committed to git).
 */
interface AppConfig {
  projectPath: string | null;
  appUrl:      string | null;
}

/**
 * What EZTest learns about the user's project by reading its files —
 * framework, language, file counts, etc. Recomputed on every load
 * so it stays accurate as the project changes.
 */
interface ProjectScanResult {
  projectName:           string;
  detectedFramework:     string;
  language:              string;
  componentFileCount:    number;
  existingTestFileCount: number;
  sourceDirectory:       string;
}

// ── Types ──────────────────────────────────────────────────────────────────────

/** Options passed when starting the wizard server. */
export interface UiServerOptions {
  port: number;
}

/** Returned handle that lets the caller query the URL or shut down gracefully. */
export interface UiServerInstance {
  serverUrl: string;
  shutdown(): Promise<void>;
}

/**
 * Configuration emitted by the browser when the user clicks "Run".
 * Fields are workflow-dependent — unused fields will be undefined.
 */
interface RunConfig {
  workflow: 'init' | 'plan' | 'generate' | 'record' | 'replay' | 'run-tests';
  source?: string;
  url?: string;
  output?: string;
  report?: string;
  /**
   * The working directory to run the child process in.
   * For run-tests this is the target project root (not the EZTest install dir),
   * so Playwright can find its config and node_modules in the right place.
   */
  workingDir?: string;
  /** Base URL of the application under test — embedded in the Playwright config. */
  appUrl?: string;
  /** Whether to run tests after generation and auto-fix selector failures. */
  runAndFix?: boolean;
  /** Whether to skip the behavioral assertion review pass. */
  noReview?: boolean;
  /** Whether to dry-run (print output without writing files). */
  dryRun?: boolean;
}

/** Log severity levels understood by the wizard terminal pane. */
type LogLevel = 'info' | 'success' | 'error' | 'warning' | 'debug';

// ── Module-level state ─────────────────────────────────────────────────────────

/**
 * The currently running CLI child process, if any.
 * Kept at module scope so the `run:cancel` handler can kill it.
 */
let activeChildProcess: ChildProcess | null = null;

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Infers a log level from a line of CLI output text by looking for well-known
 * symbols and keywords. Falls back to 'info' when nothing specific is found.
 *
 * Design principle: red should only appear for genuine failures the user needs to act on.
 * Retry/rate-limit messages, file paths containing "error", and similar informational
 * lines should never be coloured red. The ⚠ check intentionally runs before the error
 * check so that EZTest's warning-prefixed retry lines are always yellow, not red.
 */
function detectLogLevel(outputLine: string): LogLevel {
  const lowerLine = outputLine.toLowerCase();

  // ── Success ──────────────────────────────────────────────────────────────
  // Check success first — EZTest ✓ and Playwright "ok N" passing-test prefix.
  if (
    outputLine.includes('✓') ||
    outputLine.includes('✅') ||
    /^\s*ok\s+\d+\s/.test(outputLine) ||     // Playwright: "ok 1 tests/…"
    lowerLine.includes('success') ||
    lowerLine.includes('passed') ||
    lowerLine.includes('generated') ||
    lowerLine.includes('saved') ||
    lowerLine.includes('done')
  ) {
    return 'success';
  }

  // ── Warning ───────────────────────────────────────────────────────────────
  // Warnings come before the error check so that EZTest retry lines (which carry ⚠)
  // are never misclassified as errors just because they contain the word "failed".
  if (
    outputLine.includes('⚠') ||
    lowerLine.includes('warn') ||
    lowerLine.includes('warning')
  ) {
    return 'warning';
  }

  // ── Error ─────────────────────────────────────────────────────────────────
  // Be precise: only flag as red when it is a genuine failure, not when the word
  // "error" happens to appear inside a file path or a retry-progress message.
  if (
    outputLine.includes('✗') ||
    /^\s*x\s+\d+\s/.test(outputLine) ||          // Playwright: "x 4 tests/…" (failing test)
    /(?:^|\])\s*error:/i.test(outputLine) ||      // "Error: …" or "][error:" Node/TS messages
    /\b\d+\s+failed\b/i.test(outputLine) ||       // "10 failed" Playwright suite summary
    lowerLine.startsWith('throw ') ||             // thrown exception in a stack trace
    lowerLine.includes('uncaughtexception')        // Node unhandled rejection notice
  ) {
    return 'error';
  }

  // ── Debug ─────────────────────────────────────────────────────────────────
  if (lowerLine.includes('debug') || lowerLine.includes('[debug]')) {
    return 'debug';
  }

  return 'info';
}

/**
 * Builds the array of CLI arguments to pass when spawning the EZTest process
 * based on the chosen workflow and the user-supplied config values.
 */
function buildCliArgsForWorkflow(runConfig: RunConfig): string[] {
  const cliArgs: string[] = [runConfig.workflow];

  if (runConfig.workflow === 'init') {
    if (runConfig.source)  { cliArgs.push('--source', runConfig.source); }
    if (runConfig.output)  { cliArgs.push('--output', runConfig.output); }
    if (runConfig.dryRun)  { cliArgs.push('--dry-run'); }

  } else if (runConfig.workflow === 'plan') {
    if (runConfig.source)  { cliArgs.push('--source', runConfig.source); }
    if (runConfig.url)     { cliArgs.push('--url',    runConfig.url);    }
    if (runConfig.output)  { cliArgs.push('--output', runConfig.output); }

  } else if (runConfig.workflow === 'generate') {
    if (runConfig.source)    { cliArgs.push('--source', runConfig.source); }
    if (runConfig.url)       { cliArgs.push('--url',    runConfig.url);    }
    if (runConfig.output)    { cliArgs.push('--output', runConfig.output); }
    if (runConfig.runAndFix) { cliArgs.push('--run-and-fix'); }
    if (runConfig.noReview)  { cliArgs.push('--no-review'); }

  } else if (runConfig.workflow === 'record') {
    if (runConfig.url)    { cliArgs.push('--url',    runConfig.url);    }
    if (runConfig.output) { cliArgs.push('--output', runConfig.output); }

  } else if (runConfig.workflow === 'replay') {
    if (runConfig.report) { cliArgs.push('--report', runConfig.report); }
    if (runConfig.source) { cliArgs.push('--source', runConfig.source); }
  }
  // 'run-tests' is handled separately in the socket handler — it spawns
  // `npx playwright test` directly in the target project, not the EZTest CLI.

  return cliArgs;
}

// ── Process spawning helpers ───────────────────────────────────────────────

/**
 * Removes ANSI terminal escape sequences from a string.
 * Playwright (and other CLI tools) embed color codes in their output.
 * Those codes appear as raw garbage when rendered as plain text in the browser,
 * so we strip them here before forwarding to the socket.
 */
function stripAnsiCodes(text: string): string {
  return text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
}

/**
 * Spawns a child process and streams its stdout/stderr line-by-line to the
 * connected browser socket as `run:log` events. Emits `run:done` when the
 * process exits. Extracted so both EZTest CLI runs and `playwright test` runs
 * share the same streaming infrastructure.
 */
function spawnAndStreamProcess(
  command: string,
  commandArgs: string[],
  workingDirectory: string,
  clientSocket: SocketIoSocket,
  doneMetadata: Record<string, unknown> = {},
): void {
  // Absolute paths (e.g. process.execPath = "C:\Program Files\nodejs\node.exe") must
  // NOT use shell: true — cmd.exe splits unquoted paths at spaces, turning
  // "C:\Program Files\..." into the unknown command "C:\Program".
  // Short names like "npx" and "tsx" are not absolute paths and need shell: true
  // so Windows can resolve them from PATH.
  const shouldUseShell = !isAbsolute(command);

  const childProcess = spawn(command, commandArgs, {
    cwd: workingDirectory,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env },
    shell: shouldUseShell,
  });

  activeChildProcess = childProcess;

  childProcess.stdout?.on('data', (dataChunk: Buffer) => {
    const outputText = dataChunk.toString();
    for (const outputLine of outputText.split('\n')) {
      const trimmedLine = stripAnsiCodes(outputLine.trimEnd());
      if (trimmedLine.length === 0) { continue; }
      const logLevel = detectLogLevel(trimmedLine);
      clientSocket.emit('run:log', { level: logLevel, message: trimmedLine });
    }
  });

  childProcess.stderr?.on('data', (dataChunk: Buffer) => {
    const outputText = dataChunk.toString();
    for (const outputLine of outputText.split('\n')) {
      const trimmedLine = stripAnsiCodes(outputLine.trimEnd());
      if (trimmedLine.length === 0) { continue; }
      clientSocket.emit('run:log', { level: 'error' as LogLevel, message: trimmedLine });
    }
  });

  childProcess.on('close', (exitCode: number | null) => {
    activeChildProcess = null;
    clientSocket.emit('run:done', { exitCode: exitCode ?? 1, ...doneMetadata });
  });

  childProcess.on('error', (processError: Error) => {
    clientSocket.emit('run:log', {
      level: 'error' as LogLevel,
      message: 'Failed to start process: ' + processError.message,
    });
    clientSocket.emit('run:done', { exitCode: 1, ...doneMetadata });
    activeChildProcess = null;
  });
}

/**
 * The filename for the minimal Playwright config EZTest writes alongside
 * generated test files. Using a distinct name avoids overwriting the user's
 * own playwright.config.ts and makes it clear which config drives EZTest runs.
 */
const EZTEST_PLAYWRIGHT_CONFIG_FILENAME = 'eztest.playwright.config.js';

/**
 * Common locations where Playwright auth session files are saved.
 * Checked in order — the first match is used. Paths are relative to
 * the project root, not the tests directory.
 */
const KNOWN_AUTH_SESSION_RELATIVE_PATHS = [
  'e2e/.auth/session.json',
  '.auth/session.json',
  'playwright/.auth/session.json',
  'tests/.auth/session.json',
];

/**
 * Writes (or overwrites) the EZTest Playwright config into the tests directory.
 * Always regenerates so changes to appUrl or auth state are immediately reflected —
 * the file is auto-generated and safe to overwrite on every run.
 *
 * Dynamically:
 *  - Sets baseURL from the configured appUrl (any app, any URL)
 *  - Discovers and wires up the project's existing auth session if one exists
 *  - Sets testDir '.' so Playwright finds all spec files in this folder,
 *    regardless of what testDir the host project's own config uses
 */
function writeEZTestPlaywrightConfig(
  testsDirAbsolutePath: string,
  projectRootAbsolutePath: string,
  appUrl: string | null | undefined,
): void {
  mkdirSync(testsDirAbsolutePath, { recursive: true });

  // Discover an existing auth session relative to the project root
  const foundAuthRelativePath = KNOWN_AUTH_SESSION_RELATIVE_PATHS.find(
    (candidate) => existsSync(join(projectRootAbsolutePath, candidate)),
  ) ?? null;

  const lines: string[] = [
    '// @ts-check',
    '/**',
    ' * Playwright configuration auto-generated by EZTest.',
    ' * This file is overwritten on every run — edit app settings in EZTest instead.',
    ' */',
    "const { defineConfig } = require('@playwright/test');",
  ];

  if (foundAuthRelativePath) {
    lines.push(
      "const path = require('path');",
      "const fs   = require('fs');",
      '',
      '// Reuse the project auth session so tests run as an authenticated user.',
      '// Path goes up from tests/ to the project root, then down to the auth file.',
      `const AUTH_FILE = path.join(__dirname, '${join('..', foundAuthRelativePath).replace(/\\/g, '/')}');`,
      'const savedStorageState = fs.existsSync(AUTH_FILE) ? AUTH_FILE : undefined;',
    );
  }

  lines.push('', 'module.exports = defineConfig({');
  lines.push("  testDir: '.',");
  lines.push("  reporter: [['html', { open: 'never' }], ['list']],");

  // Auth-based tests (cloud apps like Jira Forge) require generous timeouts.
  // The Forge iframe alone needs up to 90 seconds to load — a 60s test timeout
  // causes every test to fail before the iframe even appears.
  // When an auth session is present, assume cloud/remote app and use safe timeouts.
  const testTimeoutMs = foundAuthRelativePath ? 120_000 : 60_000;
  lines.push(`  timeout: ${testTimeoutMs.toLocaleString('en-US').replace(/,/g, '_')},`);

  // Limit parallelism for auth-based apps. Running 16 workers against a cloud service
  // (e.g. Jira, GitHub) with a shared session file causes throttling and session
  // invalidation — most tests fail even though the app is perfectly fine.
  // 2 workers: fast enough (2x speedup), safe enough (won't hammer the rate limiter).
  if (foundAuthRelativePath) {
    lines.push('  workers: 2,');
  }

  lines.push('  fullyParallel: false,');
  lines.push('  use: {');

  if (appUrl) {
    // Escape single quotes in the URL just in case
    lines.push(`    baseURL: '${appUrl.replace(/'/g, "\\'")}',`);
  }

  if (foundAuthRelativePath) {
    lines.push('    storageState: savedStorageState,');
  }

  lines.push('    headless: true,');
  lines.push('    actionTimeout: 15_000,');
  // Cloud apps like Jira need longer navigation timeouts — the SPA shell
  // takes 30-60s to fully load before the iframe becomes interactive.
  if (foundAuthRelativePath) {
    lines.push('    navigationTimeout: 90_000,');
  }
  lines.push('  },');
  lines.push('});');
  lines.push('');

  writeFileSync(
    join(testsDirAbsolutePath, EZTEST_PLAYWRIGHT_CONFIG_FILENAME),
    lines.join('\n'),
    'utf-8',
  );
}

/**
 * Runs Playwright tests that live in the EZTest-generated tests directory.
 * Uses a minimal config file (eztest.playwright.config.js) written into that
 * directory so Playwright ignores the host project's testDir setting, which
 * may point somewhere else (e.g. ./e2e).
 *
 * The working directory MUST be the target project root so Playwright can
 * find its locally-installed browsers and node_modules.
 */
function spawnPlaywrightTestRun(
  runConfig: RunConfig,
  clientSocket: SocketIoSocket,
): void {
  const targetDirectory    = runConfig.workingDir ?? process.cwd();
  const outputDirectory    = runConfig.output ?? './tests';
  const absoluteTestsDir   = resolve(targetDirectory, outputDirectory);
  const relativeConfigPath = join(outputDirectory, EZTEST_PLAYWRIGHT_CONFIG_FILENAME)
    .replace(/\\/g, '/');

  // Always regenerate the config so baseURL and auth reflect current EZTest settings
  writeEZTestPlaywrightConfig(absoluteTestsDir, targetDirectory, runConfig.appUrl);

  clientSocket.emit('run:log', {
    level: 'info' as LogLevel,
    message: `Running Playwright tests in: ${targetDirectory}`,
  });
  clientSocket.emit('run:log', {
    level: 'info' as LogLevel,
    message: `App URL: ${runConfig.appUrl ?? '(none configured)'}`,
  });

  const playwrightArgs = [
    'playwright', 'test',
    '--config', relativeConfigPath,
    '--reporter=list,html',
  ];

  spawnAndStreamProcess('npx', playwrightArgs, targetDirectory, clientSocket, { workingDir: targetDirectory });
}

/**
 * Writes an API key to the .env file so it persists across application restarts.
 * Also immediately applies the value to the current process environment
 * so subsequent status checks reflect the new key without a restart.
 */
function persistEnvKey(envKey: string, envValue: string): void {
  const envFilePath = join(getEzTestRootDirectory(), '.env');
  let envFileContent = existsSync(envFilePath) ? readFileSync(envFilePath, 'utf-8') : '';

  // Replace existing key or append it — use a regex to handle inline values
  const keyPattern = new RegExp(`^${envKey}=.*$`, 'm');
  const newEntry   = `${envKey}=${envValue}`;

  if (keyPattern.test(envFileContent)) {
    envFileContent = envFileContent.replace(keyPattern, newEntry);
  } else {
    // Ensure there is a trailing newline before appending
    if (envFileContent.length > 0 && !envFileContent.endsWith('\n')) {
      envFileContent += '\n';
    }
    envFileContent += newEntry + '\n';
  }

  writeFileSync(envFilePath, envFileContent, 'utf-8');

  // Apply immediately so the next /api/status call sees the new key
  process.env[envKey] = envValue;
}

/**
 * Removes an environment variable line from the .env file and unsets it from
 * the current process so subsequent status checks reflect the removal immediately
 * without requiring an application restart.
 */
function removeEnvKey(envKey: string): void {
  const envFilePath = join(getEzTestRootDirectory(), '.env');
  if (!existsSync(envFilePath)) { return; }

  let envFileContent = readFileSync(envFilePath, 'utf-8');

  // Match the full key=value line including the trailing newline (CRLF or LF)
  const keyLinePattern = new RegExp(`^${envKey}=.*\\r?\\n?`, 'm');
  envFileContent = envFileContent.replace(keyLinePattern, '');

  writeFileSync(envFilePath, envFileContent, 'utf-8');

  // Unset from the running process so subsequent /api/status calls see the change
  delete process.env[envKey];
}

// ── App config helpers ─────────────────────────────────────────────────────────

/** Path where EZTest stores its own settings (never the user's project folder). */
const APP_CONFIG_FILE_PATH = join(getEzTestRootDirectory(), 'app-config.json');

/** Reads the saved app config, returning empty defaults if the file is missing. */
function readAppConfig(): AppConfig {
  try {
    if (existsSync(APP_CONFIG_FILE_PATH)) {
      return JSON.parse(readFileSync(APP_CONFIG_FILE_PATH, 'utf-8')) as AppConfig;
    }
  } catch { /* return defaults on any read/parse error */ }
  return { projectPath: null, appUrl: null };
}

/** Writes the app config to disk. */
function writeAppConfig(config: AppConfig): void {
  writeFileSync(APP_CONFIG_FILE_PATH, JSON.stringify(config, null, 2), 'utf-8');
}

/**
 * Recursively counts files matching any of the given extensions under a
 * directory, skipping excluded folder names (e.g. node_modules) and
 * stopping at depthLimit to avoid hanging on very deep trees.
 */
function countFilesWithExtensions(
  dir: string,
  extensions: string[],
  excludedDirNames: string[],
  depthLimit: number,
): number {
  if (depthLimit <= 0) { return 0; }
  let count = 0;
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return 0; }

  for (const entry of entries) {
    if (excludedDirNames.includes(entry)) { continue; }
    const fullPath = join(dir, entry);
    try {
      const fileStats = statSync(fullPath);
      if (fileStats.isDirectory()) {
        count += countFilesWithExtensions(fullPath, extensions, excludedDirNames, depthLimit - 1);
      } else if (extensions.some(ext => entry.endsWith(ext))) {
        count++;
      }
    } catch { continue; }
  }
  return count;
}

/**
 * Reads a project folder and returns human-readable information about it:
 * framework, language, source file count, and existing test count.
 */
function scanProjectDirectory(projectPath: string): ProjectScanResult {
  const packageJsonPath = join(projectPath, 'package.json');
  let projectName       = 'My Project';
  let detectedFramework = 'Web App';
  const language        = existsSync(join(projectPath, 'tsconfig.json')) ? 'TypeScript' : 'JavaScript';

  if (existsSync(packageJsonPath)) {
    try {
      const packageContent = JSON.parse(readFileSync(packageJsonPath, 'utf-8')) as Record<string, unknown>;
      if (typeof packageContent['name'] === 'string' && packageContent['name']) {
        // Convert kebab-case package names to Title Case for display
        projectName = (packageContent['name'] as string)
          .split(/[-_]/)
          .map(word => word.charAt(0).toUpperCase() + word.slice(1))
          .join(' ');
      }
      const allDeps: Record<string, string> = {
        ...packageContent['dependencies'] as Record<string, string> ?? {},
        ...packageContent['devDependencies'] as Record<string, string> ?? {},
      };
      if (allDeps['next'])               { detectedFramework = 'Next.js'; }
      else if (allDeps['react'])         { detectedFramework = 'React'; }
      else if (allDeps['vue'])           { detectedFramework = 'Vue'; }
      else if (allDeps['@angular/core']) { detectedFramework = 'Angular'; }
      else if (allDeps['svelte'])        { detectedFramework = 'Svelte'; }
      else if (allDeps['express'] || allDeps['fastify'] || allDeps['koa']) {
        detectedFramework = 'Node API';
      }
    } catch { /* leave defaults if package.json is malformed */ }
  }

  // Prefer /src if it exists, otherwise scan the root (excluding noise dirs)
  const sourceDirectory    = existsSync(join(projectPath, 'src')) ? join(projectPath, 'src') : projectPath;
  const componentExtensions = ['.tsx', '.jsx', '.vue', '.svelte', '.ts', '.js'];
  const testExtensions      = ['.spec.ts', '.spec.js', '.test.ts', '.test.js', '.spec.tsx', '.test.tsx'];
  const excludedDirs        = ['node_modules', '.git', 'dist', 'build', '.next', 'out', 'coverage', '.nuxt'];

  const componentFileCount    = countFilesWithExtensions(sourceDirectory, componentExtensions, excludedDirs, 6);
  const existingTestFileCount = countFilesWithExtensions(projectPath,     testExtensions,      excludedDirs, 6);

  return { projectName, detectedFramework, language, componentFileCount, existingTestFileCount, sourceDirectory };
}

// ── Server factory ─────────────────────────────────────────────────────────────

// ── EZTest Report Theme Injection ─────────────────────────────────────────────

/** Sentinel comment written into the report so we only inject our CSS once per file. */
const EZTEST_THEME_SENTINEL = '<!-- eztest-theme-injected -->';

/**
 * Injects a custom EZTest color theme into a Playwright HTML report file.
 *
 * The default Playwright report uses drab charcoal-on-black tones that make it
 * hard to quickly distinguish pass/fail at a glance. This post-processes the
 * generated HTML to inject CSS variable overrides that make the report vivid and
 * readable — rich navy background, bright status colors, high-contrast text.
 *
 * The sentinel comment prevents double-injection if the report is opened multiple times.
 * Silently skips if the file cannot be read or written.
 */
function injectEZTestThemeIntoReport(reportIndexPath: string): void {
  try {
    const originalHtml = readFileSync(reportIndexPath, 'utf-8');

    // Skip if we already injected the theme in a previous open
    if (originalHtml.includes(EZTEST_THEME_SENTINEL)) return;

    const themeStyleBlock = `
${EZTEST_THEME_SENTINEL}
<style id="eztest-theme">
  /* ── EZTest Report Theme — overrides Playwright's default dark palette ── */

  /* Rich navy/indigo background instead of pure black */
  body {
    background: #080c18 !important;
    background-image:
      radial-gradient(ellipse 80% 40% at 20% 0%, rgba(29, 78, 216, 0.12) 0%, transparent 60%),
      radial-gradient(ellipse 60% 40% at 80% 100%, rgba(109, 40, 217, 0.08) 0%, transparent 60%) !important;
    background-attachment: fixed !important;
  }

  /* Override Playwright's GitHub Primer CSS variables for the dark theme */
  html, :root {
    --color-canvas-default:   #0d1117 !important;
    --color-canvas-subtle:    #161b22 !important;
    --color-canvas-inset:     #010409 !important;
    --color-canvas-overlay:   #1c2128 !important;
    --color-border-default:   #1e3a5f !important;
    --color-border-muted:     #21262d !important;
    --color-border-subtle:    #1b2434 !important;
    --color-fg-default:       #e6edf3 !important;
    --color-fg-muted:         #8b949e !important;
    --color-fg-subtle:        #6e7681 !important;
    /* Vivid accent — electric blue */
    --color-accent-fg:        #58a6ff !important;
    --color-accent-emphasis:  #1f6feb !important;
    /* Pass = vivid emerald, Fail = vivid rose */
    --color-success-fg:       #3fb950 !important;
    --color-success-emphasis: #238636 !important;
    --color-danger-fg:        #f85149 !important;
    --color-danger-emphasis:  #da3633 !important;
  }

  /* Top filter bar — give it a branded indigo gradient */
  .subnav, [class*="subnav"], nav {
    background: linear-gradient(135deg, #0f172a 0%, #1e1b4b 100%) !important;
    border-bottom: 1px solid #312e81 !important;
    box-shadow: 0 4px 24px rgba(99, 102, 241, 0.15) !important;
  }

  /* Tab buttons: All / Passed / Failed / Flaky / Skipped */
  .subnav-item, [class*="subnav-item"] {
    color: #94a3b8 !important;
    border-color: transparent !important;
  }
  .subnav-item[aria-selected="true"], [class*="subnav-item"][aria-selected="true"] {
    color: #e6edf3 !important;
    border-bottom: 2px solid #6366f1 !important;
    background: rgba(99, 102, 241, 0.1) !important;
  }

  /* Test file accordion headers */
  .test-file-summary, [class*="test-file"] {
    background: #161b22 !important;
    border: 1px solid #1e3a5f !important;
    border-radius: 8px !important;
  }

  /* Failed test rows — rose left-border glow */
  [class*="unexpected"], .outcome-unexpected {
    border-left: 3px solid #f85149 !important;
    background: rgba(248, 81, 73, 0.06) !important;
  }

  /* Passed test rows — emerald left-border */
  [class*="expected"]:not([class*="unexpected"]), .outcome-expected {
    border-left: 3px solid #3fb950 !important;
    background: rgba(63, 185, 80, 0.04) !important;
  }

  /* Status count badges next to tab labels */
  [class*="counter"], .Counter {
    background: #1e3a5f !important;
    color: #58a6ff !important;
    border-radius: 999px !important;
    font-weight: 600 !important;
  }

  /* Search input */
  input[type="text"], input[type="search"] {
    background: #161b22 !important;
    border: 1px solid #30363d !important;
    color: #e6edf3 !important;
    border-radius: 6px !important;
    box-shadow: inset 0 1px 4px rgba(0, 0, 0, 0.4) !important;
  }
  input[type="text"]:focus, input[type="search"]:focus {
    border-color: #58a6ff !important;
    outline: none !important;
    box-shadow: 0 0 0 3px rgba(88, 166, 255, 0.15) !important;
  }

  /* Duration / timing labels */
  [class*="duration"], [class*="timing"] {
    color: #6e7681 !important;
    font-size: 0.85em !important;
  }

  /* Make the test title text bright white — the most important text in the report */
  [class*="title"], [class*="testName"], [class*="test-name"] {
    color: #f0f6fc !important;
    font-weight: 500 !important;
  }

  /* File path labels under test names — muted but readable */
  [class*="location"], [class*="fileName"] {
    color: #58a6ff !important;
    font-size: 0.82em !important;
  }
</style>`;

    // Inject before </head> so styles load before the React app mounts
    const patchedHtml = originalHtml.replace('</head>', `${themeStyleBlock}\n</head>`);
    writeFileSync(reportIndexPath, patchedHtml, 'utf-8');
  } catch {
    // Non-fatal: if injection fails, the report still opens — just with default colors
  }
}

/**
 * Starts the Express + Socket.io wizard server on the given port.
 * Returns a handle containing the local URL and a shutdown function.
 */
export async function startUiServer(options: UiServerOptions): Promise<UiServerInstance> {
  const expressApp  = express();
  const httpServer  = createServer(expressApp);
  const socketServer = new SocketIoServer(httpServer);

  // Parse JSON request bodies for the /api/env endpoint
  expressApp.use(express.json());

  // ── GET / — serve the wizard page ──────────────────────────────────────────
  expressApp.get('/', (_req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(buildWizardPageHtml());
  });

  // ── GET /api/status — environment health check ────────────────────────────
  expressApp.get('/api/status', (_req, res) => {
    const nodeVersionString = process.version;
    const nodeMajorVersion  = parseInt(nodeVersionString.replace('v', '').split('.')[0], 10);
    const isNodeVersionOk   = nodeMajorVersion >= 18;

    const hasGithubKey   = Boolean((process.env['EZTEST_GITHUB_TOKEN'] ?? process.env['GITHUB_MODELS_TOKEN'])?.trim());
    const hasOpenAiKey    = Boolean(process.env['OPENAI_API_KEY']?.trim());
    const hasAnthropicKey = Boolean(process.env['ANTHROPIC_API_KEY']?.trim());
    const isCopilotProvider = process.env['EZTEST_AI_PROVIDER'] === 'copilot';
    const hasAnyApiKey    = hasGithubKey || hasOpenAiKey || hasAnthropicKey || isCopilotProvider;

    // Playwright can be in node_modules/.bin with or without .cmd (Windows)
    const playwrightBinPath    = join(process.cwd(), 'node_modules', '.bin', 'playwright');
    const playwrightCmdPath    = join(process.cwd(), 'node_modules', '.bin', 'playwright.cmd');
    const isPlaywrightInstalled = existsSync(playwrightBinPath) || existsSync(playwrightCmdPath);

    res.json({
      node: {
        version: nodeVersionString,
        ok: isNodeVersionOk,
      },
      apiKey: {
        hasGithub:   hasGithubKey,
        hasCopilot:  isCopilotProvider,
        hasOpenAi:   hasOpenAiKey,
        hasAnthropic: hasAnthropicKey,
        ok: hasAnyApiKey,
      },
      playwright: {
        installed: isPlaywrightInstalled,
      },
    });
  });

  // ── POST /api/env — save API key to .env ──────────────────────────────────
  expressApp.post('/api/env', (req, res) => {
    const { provider, apiKey } = req.body as { provider: string; apiKey: string };

    if (!provider || !apiKey) {
      res.status(400).json({ saved: false, error: 'provider and apiKey are required' });
      return;
    }

    // Map provider name to the correct environment variable name
    const envKeyMap: Record<string, string> = {
      github:    'EZTEST_GITHUB_TOKEN',
      copilot:   'EZTEST_AI_PROVIDER',
      openai:    'OPENAI_API_KEY',
      anthropic: 'ANTHROPIC_API_KEY',
      gemini:    'GOOGLE_API_KEY',
    };
    const envKeyName = envKeyMap[provider] ?? 'OPENAI_API_KEY';

    // Copilot provider authenticates via `gh auth token` — no API key to persist.
    // Only write the provider name; skip the key write.
    if (provider === 'copilot') {
      persistEnvKey('EZTEST_AI_PROVIDER', 'copilot');
      res.json({ saved: true });
      return;
    }

    persistEnvKey(envKeyName, apiKey);
    persistEnvKey('EZTEST_AI_PROVIDER', provider);

    res.json({ saved: true });
  });

  // ── GET /api/env — returns active provider status (never exposes key values) ──
  // Used by the API key management UI to show which provider is currently connected.
  expressApp.get('/api/env', (_req, res) => {
    const hasGithubKey      = Boolean((process.env['EZTEST_GITHUB_TOKEN'] ?? process.env['GITHUB_MODELS_TOKEN'])?.trim());
    const hasOpenAiKey      = Boolean(process.env['OPENAI_API_KEY']?.trim());
    const hasAnthropicKey   = Boolean(process.env['ANTHROPIC_API_KEY']?.trim());
    const hasGeminiKey      = Boolean(process.env['GOOGLE_API_KEY']?.trim());
    const isCopilotProvider = process.env['EZTEST_AI_PROVIDER'] === 'copilot';

    let activeProvider: string | null = null;
    let providerLabel                 = 'None';

    // Mirror the same priority order used in readAiConfigFromEnvironment() in config.ts:
    // copilot > github > gemini > anthropic > openai
    if (isCopilotProvider) {
      activeProvider = 'copilot';
      providerLabel  = 'Copilot via gh CLI';
    } else if (hasGithubKey) {
      activeProvider = 'github';
      providerLabel  = 'GitHub Copilot';
    } else if (hasGeminiKey) {
      activeProvider = 'gemini';
      providerLabel  = 'Google Gemini';
    } else if (hasOpenAiKey) {
      activeProvider = 'openai';
      providerLabel  = 'OpenAI';
    } else if (hasAnthropicKey) {
      activeProvider = 'anthropic';
      providerLabel  = 'Anthropic';
    }

    const hasKey = hasGithubKey || hasOpenAiKey || hasAnthropicKey || hasGeminiKey || isCopilotProvider;
    res.json({ provider: activeProvider, providerLabel, hasKey });
  });

  // ── DELETE /api/env — removes the active provider's API key from .env ─────────
  // Clears both the provider-specific key and the EZTEST_AI_PROVIDER selector so
  // EZTest is fully decoupled from the removed provider after this call.
  expressApp.delete('/api/env', (_req, res) => {
    // Map each provider to the env var(s) that hold its credentials
    const providerKeyEnvVars: Record<string, string[]> = {
      github:    ['EZTEST_GITHUB_TOKEN', 'GITHUB_MODELS_TOKEN'],
      openai:    ['OPENAI_API_KEY'],
      anthropic: ['ANTHROPIC_API_KEY'],
      gemini:    ['GOOGLE_API_KEY'],
      copilot:   [],   // copilot authenticates via gh CLI — no stored key to remove
    };

    const activeProvider = process.env['EZTEST_AI_PROVIDER'] ?? '';
    const credentialKeysToRemove = providerKeyEnvVars[activeProvider]
      // When no explicit provider is set, fall back to clearing all known key vars
      ?? ['EZTEST_GITHUB_TOKEN', 'GITHUB_MODELS_TOKEN', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GOOGLE_API_KEY'];

    for (const credentialKey of credentialKeysToRemove) {
      removeEnvKey(credentialKey);
    }
    // Always clear the provider selector so stale config doesn't affect future key detection
    removeEnvKey('EZTEST_AI_PROVIDER');

    res.json({ removed: true });
  });

  // ── GET /api/app-config — returns saved project path + scan result ────────
  expressApp.get('/api/app-config', (_req, res) => {
    const config = readAppConfig();
    if (config.projectPath && existsSync(config.projectPath)) {
      const scanResult = scanProjectDirectory(config.projectPath);
      res.json({ ...config, isConfigured: true, scanResult });
    } else {
      res.json({ projectPath: null, appUrl: null, isConfigured: false, scanResult: null });
    }
  });

  // ── POST /api/app-config — saves project path and/or app URL ─────────────
  expressApp.post('/api/app-config', (req, res) => {
    const { projectPath, appUrl } = req.body as { projectPath?: string; appUrl?: string };
    const existing = readAppConfig();
    const updated: AppConfig = {
      projectPath: projectPath !== undefined ? projectPath : existing.projectPath,
      appUrl:      appUrl      !== undefined ? appUrl      : existing.appUrl,
    };
    writeAppConfig(updated);

    if (updated.projectPath && existsSync(updated.projectPath)) {
      const scanResult = scanProjectDirectory(updated.projectPath);
      res.json({ saved: true, scanResult });
    } else {
      res.json({ saved: true, scanResult: null });
    }
  });

  // ── POST /api/browse-folder — opens native Windows folder picker ──────────
  // Uses PowerShell's WinForms FolderBrowserDialog — no SDK required on Windows.
  // A hidden topmost Form is used as the dialog owner so it appears in front of
  // the browser window instead of hidden behind it.
  expressApp.post('/api/browse-folder', (_req, res) => {
    const psCommand = [
      'Add-Type -AssemblyName System.Windows.Forms;',
      '[void][System.Windows.Forms.Application]::EnableVisualStyles();',
      // Create an invisible topmost owner window so the dialog surfaces above the browser.
      '$owner = New-Object System.Windows.Forms.Form;',
      '$owner.TopMost = $true;',
      '$owner.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen;',
      '$owner.Width = 0; $owner.Height = 0; $owner.ShowInTaskbar = $false;',
      '$owner.Show();',
      '$d = New-Object System.Windows.Forms.FolderBrowserDialog;',
      '$d.Description = "Select your project root folder";',
      '$d.ShowNewFolderButton = $false;',
      'if ($d.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $d.SelectedPath }',
      '$owner.Dispose();',
    ].join(' ');

    const pickerProcess = spawn(
      'powershell',
      ['-Sta', '-NoProfile', '-Command', psCommand],
      { stdio: ['ignore', 'pipe', 'ignore'], shell: false },
    );

    let selectedPath = '';
    pickerProcess.stdout?.on('data', (chunk: Buffer) => { selectedPath += chunk.toString(); });

    pickerProcess.on('close', () => {
      const trimmedPath = selectedPath.trim();
      if (trimmedPath && existsSync(trimmedPath)) {
        res.json({ path: trimmedPath, cancelled: false });
      } else {
        res.json({ path: null, cancelled: true });
      }
    });

    pickerProcess.on('error', () => {
      res.json({ path: null, cancelled: true, error: 'Could not open folder picker' });
    });
  });

  // ── POST /api/browse-file — opens native Windows file picker ─────────────
  // Same topmost-owner pattern as browse-folder so the dialog appears in front.
  expressApp.post('/api/browse-file', (req, res) => {
    const { filter = 'All files|*.*' } = req.body as { filter?: string };
    const safeFilter = filter.replace(/'/g, '');

    const psCommand = [
      'Add-Type -AssemblyName System.Windows.Forms;',
      '[void][System.Windows.Forms.Application]::EnableVisualStyles();',
      '$owner = New-Object System.Windows.Forms.Form;',
      '$owner.TopMost = $true;',
      '$owner.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen;',
      '$owner.Width = 0; $owner.Height = 0; $owner.ShowInTaskbar = $false;',
      '$owner.Show();',
      '$d = New-Object System.Windows.Forms.OpenFileDialog;',
      '$d.Title = "Select a file";',
      '$d.Filter = \'' + safeFilter + '\';',
      'if ($d.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $d.FileName }',
      '$owner.Dispose();',
    ].join(' ');

    const pickerProcess = spawn(
      'powershell',
      ['-Sta', '-NoProfile', '-Command', psCommand],
      { stdio: ['ignore', 'pipe', 'ignore'], shell: false },
    );

    let selectedFile = '';
    pickerProcess.stdout?.on('data', (chunk: Buffer) => { selectedFile += chunk.toString(); });

    pickerProcess.on('close', () => {
      const trimmedFile = selectedFile.trim();
      if (trimmedFile && existsSync(trimmedFile)) {
        res.json({ path: trimmedFile, cancelled: false });
      } else {
        res.json({ path: null, cancelled: true });
      }
    });

    pickerProcess.on('error', () => {
      res.json({ path: null, cancelled: true, error: 'Could not open file picker' });
    });
  });

  // ── POST /api/open-report — opens the Playwright HTML report in the browser ──
  // Uses the Windows `start` command to open the file with the default browser.
  // The reportDir is the project root where Playwright wrote playwright-report/.
  expressApp.post('/api/open-report', (req, res) => {
    const { reportDir } = req.body as { reportDir?: string };
    if (!reportDir) {
      res.status(400).json({ opened: false, error: 'reportDir is required' });
      return;
    }

    // Playwright always writes its HTML report to playwright-report/index.html
    // relative to the cwd used when the tests ran.
    const reportIndexPath = join(reportDir, 'playwright-report', 'index.html');

    if (!existsSync(reportIndexPath)) {
      res.status(404).json({ opened: false, error: 'Report not found at: ' + reportIndexPath });
      return;
    }

    // Inject the EZTest color theme before opening — makes the report visually compelling
    // instead of the default drab charcoal-on-black Playwright palette.
    injectEZTestThemeIntoReport(reportIndexPath);

    // `start "" "path"` opens the file with the system default browser on Windows.
    // The empty first argument is required so Windows doesn't treat the path as the window title.
    spawn('cmd', ['/c', 'start', '""', reportIndexPath], {
      shell: false,
      detached: true,
      stdio: 'ignore',
    }).unref(); // unref() so Node doesn't wait for the browser process to exit

    res.json({ opened: true, reportPath: reportIndexPath });
  });

  // ── GET /api/update/check — checks GitHub for a newer EZTest release ──────
  expressApp.get('/api/update/check', (_req, res) => {
    const currentVersion = readCurrentVersion();

    fetchLatestGithubRelease()
      .then((latestRelease) => {
        const portableAsset = selectPortableReleaseAsset(latestRelease);
        const hasUpdate = isVersionNewer(currentVersion, latestRelease.tagName) && portableAsset !== null;
        const result: UpdateCheckResult = {
          hasUpdate,
          currentVersion,
          latestVersion: latestRelease.tagName.replace(/^v/, ''),
          releaseUrl: latestRelease.htmlUrl,
          canInstallInApp: portableAsset !== null,
        };
        res.json(result);
      })
      .catch((checkError: unknown) => {
        // Non-fatal — the UI simply won't show the update banner if this fails.
        res.json({
          hasUpdate:      false,
          currentVersion,
          latestVersion:  currentVersion,
          releaseUrl: '',
          canInstallInApp: false,
          error:          (checkError as Error).message,
        });
      });
  });

  // ── Socket.io — real-time run streaming ───────────────────────────────────
  socketServer.on('connection', (clientSocket) => {

    // Client asks to start a workflow run
    clientSocket.on('run:start', (runConfig: RunConfig) => {
      // Kill any already-running process before starting a new one
      if (activeChildProcess) {
        activeChildProcess.kill();
        activeChildProcess = null;
      }

      // run-tests spawns `npx playwright test` directly in the target project —
      // it does NOT go through the EZTest CLI because Playwright must run with
      // the target project's cwd so it can find its config and node_modules.
      if (runConfig.workflow === 'run-tests') {
        spawnPlaywrightTestRun(runConfig, clientSocket);
        return;
      }

      const cliArgs = buildCliArgsForWorkflow(runConfig);

      // Use the compiled dist if it exists, otherwise fall back to tsx (dev mode)
      const cliEntryPath = join(getEzTestRootDirectory(), 'dist', 'cli', 'index.js');
      const isBuilt      = existsSync(cliEntryPath);
      const command      = isBuilt ? process.execPath : 'tsx';
      const commandArgs  = isBuilt
        ? [cliEntryPath, ...cliArgs]
        : [join(getEzTestRootDirectory(), 'src', 'cli', 'index.ts'), ...cliArgs];

      spawnAndStreamProcess(command, commandArgs, getEzTestRootDirectory(), clientSocket);
    });

    // Client requests cancellation of the active process
    clientSocket.on('run:cancel', () => {
      if (activeChildProcess) {
        activeChildProcess.kill();
        activeChildProcess = null;
        clientSocket.emit('run:log', { level: 'warning' as LogLevel, message: 'Run cancelled by user.' });
        clientSocket.emit('run:done', { exitCode: 130 }); // 130 = killed by Ctrl+C
      } else {
        // Notify the client there was nothing to cancel — avoids a silent no-op
        clientSocket.emit('run:log', { level: 'warning' as LogLevel, message: 'No active run to cancel.' });
      }
    });

    // Client asks to install the latest EZTest update.
    // Downloads the portable GitHub release zip, stages it in updates/, and
    // applies it on the next launcher start so users never need the repo layout.
    clientSocket.on('update:install', () => {
      const sendUpdateLog = (message: string) => {
        clientSocket.emit('update:log', { message });
      };

      sendUpdateLog('Checking GitHub releases for a newer portable bundle...');
      sendUpdateLog('Bundle root: ' + getEzTestRootDirectory());
      sendUpdateLog('Expected asset: ' + PORTABLE_RELEASE_ASSET_NAME);
      sendUpdateLog('');

      void downloadAndStagePortableUpdate()
        .then(({ latestVersion }) => {
          sendUpdateLog('\u2713 Portable bundle downloaded successfully');
          sendUpdateLog('\u2713 Update staged in: ' + getStagedPortableUpdateDirectory());
          sendUpdateLog('');
          sendUpdateLog('Close EZTest and launch it again to apply v' + latestVersion + '.');
          clientSocket.emit('update:complete', {
            success: true,
            message: 'Update downloaded and staged. Close EZTest and launch it again to apply v' + latestVersion + '.',
          });
        })
        .catch((updateError: unknown) => {
          sendUpdateLog('\u274C ' + (updateError as Error).message);
          clientSocket.emit('update:complete', {
            success: false,
            message: 'Update failed — see log above.',
          });
        });
    });
  });

  // ── Start listening ────────────────────────────────────────────────────────
  await new Promise<void>((resolve) => {
    httpServer.listen(options.port, () => resolve());
  });

  const serverUrl = 'http://localhost:' + options.port;

  return {
    serverUrl,
    /** Closes the HTTP server and terminates any active child process. */
    shutdown: () =>
      new Promise<void>((resolve) => {
        if (activeChildProcess) {
          activeChildProcess.kill();
          activeChildProcess = null;
        }
        httpServer.close(() => resolve());
      }),
  };
}
