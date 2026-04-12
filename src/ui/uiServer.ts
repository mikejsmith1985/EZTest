/**
 * UI Server — local Express + Socket.io server that powers the EZTest wizard.
 * Serves the wizard HTML page and provides the API + real-time log streaming
 * that lets users run EZTest workflows without touching the terminal.
 */
import { createServer } from 'node:http';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import express from 'express';
import { Server as SocketIoServer } from 'socket.io';
import { buildWizardPageHtml } from './wizardPage.js';

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
  workflow: 'init' | 'plan' | 'generate' | 'record' | 'replay';
  source?: string;
  url?: string;
  output?: string;
  report?: string;
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
 */
function detectLogLevel(outputLine: string): LogLevel {
  const lowerLine = outputLine.toLowerCase();

  // Check success indicators first — they contain symbols not in other levels
  if (
    outputLine.includes('✓') ||
    outputLine.includes('✅') ||
    lowerLine.includes('success') ||
    lowerLine.includes('done') ||
    lowerLine.includes('passed') ||
    lowerLine.includes('generated') ||
    lowerLine.includes('saved')
  ) {
    return 'success';
  }

  if (
    outputLine.includes('✗') ||
    lowerLine.includes('error') ||
    lowerLine.includes('failed') ||
    lowerLine.includes('error:') ||
    lowerLine.includes('throw')
  ) {
    return 'error';
  }

  if (
    outputLine.includes('⚠') ||
    lowerLine.includes('warn') ||
    lowerLine.includes('warning')
  ) {
    return 'warning';
  }

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

  return cliArgs;
}

/**
 * Updates or appends a key=value entry in the project's .env file.
 * Also immediately applies the value to the current process environment
 * so subsequent status checks reflect the new key without a restart.
 */
function persistEnvKey(envKey: string, envValue: string): void {
  const envFilePath = join(process.cwd(), '.env');
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

// ── Server factory ─────────────────────────────────────────────────────────────

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

    const hasOpenAiKey    = Boolean(process.env['OPENAI_API_KEY']?.trim());
    const hasAnthropicKey = Boolean(process.env['ANTHROPIC_API_KEY']?.trim());
    const hasAnyApiKey    = hasOpenAiKey || hasAnthropicKey;

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
        hasOpenAi:    hasOpenAiKey,
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

    const envKeyName =
      provider === 'openai' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY';

    persistEnvKey(envKeyName, apiKey);
    persistEnvKey('EZTEST_AI_PROVIDER', provider);

    res.json({ saved: true });
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

      const cliArgs = buildCliArgsForWorkflow(runConfig);

      // Use the compiled dist if it exists, otherwise fall back to tsx (dev mode)
      const cliEntryPath = join(process.cwd(), 'dist', 'cli', 'index.js');
      const isBuilt      = existsSync(cliEntryPath);
      const command      = isBuilt ? 'node' : 'tsx';
      const commandArgs  = isBuilt
        ? [cliEntryPath, ...cliArgs]
        : [join(process.cwd(), 'src', 'cli', 'index.ts'), ...cliArgs];

      // shell: true ensures npx/tsx resolve on all platforms including Windows
      const childProcess = spawn(command, commandArgs, {
        cwd: process.cwd(),
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env },
        shell: true,
      });

      activeChildProcess = childProcess;

      // Stream stdout lines to the browser terminal pane
      childProcess.stdout?.on('data', (dataChunk: Buffer) => {
        const outputText = dataChunk.toString();
        // Split on newlines so each line gets its own colored entry
        for (const outputLine of outputText.split('\n')) {
          const trimmedLine = outputLine.trimEnd();
          if (trimmedLine.length === 0) { continue; }
          const logLevel = detectLogLevel(trimmedLine);
          clientSocket.emit('run:log', { level: logLevel, message: trimmedLine });
        }
      });

      // Stream stderr as error-level lines
      childProcess.stderr?.on('data', (dataChunk: Buffer) => {
        const outputText = dataChunk.toString();
        for (const outputLine of outputText.split('\n')) {
          const trimmedLine = outputLine.trimEnd();
          if (trimmedLine.length === 0) { continue; }
          clientSocket.emit('run:log', { level: 'error' as LogLevel, message: trimmedLine });
        }
      });

      childProcess.on('close', (exitCode: number | null) => {
        activeChildProcess = null;
        clientSocket.emit('run:done', { exitCode: exitCode ?? 1 });
      });

      childProcess.on('error', (processError: Error) => {
        clientSocket.emit('run:log', {
          level: 'error' as LogLevel,
          message: 'Failed to start process: ' + processError.message,
        });
        clientSocket.emit('run:done', { exitCode: 1 });
        activeChildProcess = null;
      });
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
