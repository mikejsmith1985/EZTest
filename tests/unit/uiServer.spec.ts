/**
 * Unit tests for the EZTest UI Server.
 * Verifies the /api/status and /api/env HTTP endpoints and the
 * Socket.io run:cancel event without requiring a real AI provider.
 */
import { test, expect } from '@playwright/test';
import { mkdirSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { io as connectSocketClient } from 'socket.io-client';
import { startUiServer } from '../../src/ui/uiServer.js';
import type { UiServerInstance } from '../../src/ui/uiServer.js';

// ── Constants ──────────────────────────────────────────────────────────────────

/** Port reserved for UI server unit tests — separate from annotation server (7499). */
const UI_TEST_PORT = 7435;

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Creates a temporary working directory for one test and returns its path. */
function createTempWorkingDir(): string {
  const tempDirPath = join(tmpdir(), 'eztest-ui-test-' + randomUUID().slice(0, 8));
  mkdirSync(tempDirPath, { recursive: true });
  return tempDirPath;
}

/**
 * Waits for a socket event with a timeout. Rejects if the event does not
 * arrive within the specified milliseconds — prevents tests from hanging.
 */
function waitForSocketEvent<T>(
  socketClient: ReturnType<typeof connectSocketClient>,
  eventName: string,
  timeoutMs: number = 3000,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeoutHandle = setTimeout(() => {
      reject(new Error('Timed out waiting for socket event: ' + eventName));
    }, timeoutMs);

    socketClient.once(eventName, (payload: T) => {
      clearTimeout(timeoutHandle);
      resolve(payload);
    });
  });
}

// ── Test Suite ─────────────────────────────────────────────────────────────────

test.describe('uiServer', () => {
  // Serial mode prevents port collision — each test starts/stops the server sequentially
  test.describe.configure({ mode: 'serial' });

  let activeServerInstance: UiServerInstance;

  test.beforeEach(async () => {
    activeServerInstance = await startUiServer({ port: UI_TEST_PORT });
  });

  test.afterEach(async () => {
    await activeServerInstance.shutdown();
  });

  // ── GET / ────────────────────────────────────────────────────────────────────

  test('GET / returns HTML page with wizard content', async () => {
    const response = await fetch(activeServerInstance.serverUrl + '/');

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');

    const htmlBody = await response.text();
    // The wizard page must identify itself
    expect(htmlBody).toContain('EZTest');
  });

  // ── GET /api/status ──────────────────────────────────────────────────────────

  test('GET /api/status returns node version and ok flag', async () => {
    const response = await fetch(activeServerInstance.serverUrl + '/api/status');
    const statusData = await response.json() as {
      node: { version: string; ok: boolean };
      apiKey: { hasOpenAi: boolean; hasAnthropic: boolean; ok: boolean };
      playwright: { installed: boolean };
    };

    expect(response.status).toBe(200);
    expect(statusData.node.version).toMatch(/^v\d+\.\d+\.\d+$/);
    // Node 18+ required — we are running the tests on this machine so it should pass
    expect(statusData.node.ok).toBe(true);
  });

  test('GET /api/status detects OPENAI_API_KEY in process environment', async () => {
    const savedOpenAiKey = process.env['OPENAI_API_KEY'];
    process.env['OPENAI_API_KEY'] = 'sk-test-ui-openai-detection';
    delete process.env['ANTHROPIC_API_KEY'];

    try {
      const response = await fetch(activeServerInstance.serverUrl + '/api/status');
      const statusData = await response.json() as {
        apiKey: { hasOpenAi: boolean; hasAnthropic: boolean; ok: boolean };
      };

      expect(statusData.apiKey.hasOpenAi).toBe(true);
      expect(statusData.apiKey.hasAnthropic).toBe(false);
      expect(statusData.apiKey.ok).toBe(true);
    } finally {
      // Always restore the environment to avoid polluting other tests
      if (savedOpenAiKey !== undefined) {
        process.env['OPENAI_API_KEY'] = savedOpenAiKey;
      } else {
        delete process.env['OPENAI_API_KEY'];
      }
    }
  });

  test('GET /api/status reports apiKey.ok=false when no key is present', async () => {
    const savedOpenAiKey     = process.env['OPENAI_API_KEY'];
    const savedAnthropicKey  = process.env['ANTHROPIC_API_KEY'];
    delete process.env['OPENAI_API_KEY'];
    delete process.env['ANTHROPIC_API_KEY'];

    try {
      const response = await fetch(activeServerInstance.serverUrl + '/api/status');
      const statusData = await response.json() as {
        apiKey: { hasOpenAi: boolean; hasAnthropic: boolean; ok: boolean };
      };

      expect(statusData.apiKey.hasOpenAi).toBe(false);
      expect(statusData.apiKey.hasAnthropic).toBe(false);
      expect(statusData.apiKey.ok).toBe(false);
    } finally {
      if (savedOpenAiKey   !== undefined) process.env['OPENAI_API_KEY']     = savedOpenAiKey;
      if (savedAnthropicKey !== undefined) process.env['ANTHROPIC_API_KEY'] = savedAnthropicKey;
    }
  });

  test('GET /api/status includes playwright installed flag', async () => {
    const response = await fetch(activeServerInstance.serverUrl + '/api/status');
    const statusData = await response.json() as {
      playwright: { installed: boolean };
    };

    // The flag must be a boolean — true in CI where playwright is installed
    expect(typeof statusData.playwright.installed).toBe('boolean');
  });

  // ── POST /api/env ────────────────────────────────────────────────────────────

  test('POST /api/env saves OpenAI key to process.env immediately', async () => {
    const savedOpenAiKey = process.env['OPENAI_API_KEY'];
    delete process.env['OPENAI_API_KEY'];

    // Write a temp .env file so persistEnvKey does not touch the real project .env
    const originalCwd = process.cwd();

    try {
      const response = await fetch(activeServerInstance.serverUrl + '/api/env', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: 'openai', apiKey: 'sk-test-save-key-openai' }),
      });

      const responseBody = await response.json() as { saved: boolean };
      expect(response.status).toBe(200);
      expect(responseBody.saved).toBe(true);

      // The server should have applied the key to its own process.env immediately
      expect(process.env['OPENAI_API_KEY']).toBe('sk-test-save-key-openai');
    } finally {
      if (savedOpenAiKey !== undefined) {
        process.env['OPENAI_API_KEY'] = savedOpenAiKey;
      } else {
        delete process.env['OPENAI_API_KEY'];
      }
      // Clean up the .env entry the server wrote to the real project .env
      const envFilePath = join(originalCwd, '.env');
      if (existsSync(envFilePath)) {
        let envContent = readFileSync(envFilePath, 'utf-8');
        envContent = envContent.replace(/^OPENAI_API_KEY=sk-test-save-key-openai\n?/m, '');
        writeFileSync(envFilePath, envContent, 'utf-8');
      }
    }
  });

  test('POST /api/env returns 400 when provider is missing', async () => {
    const response = await fetch(activeServerInstance.serverUrl + '/api/env', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey: 'sk-test-only-key-no-provider' }),
    });

    expect(response.status).toBe(400);
    const errorBody = await response.json() as { saved: boolean; error: string };
    expect(errorBody.saved).toBe(false);
    expect(errorBody.error).toBeTruthy();
  });

  // ── Socket.io ────────────────────────────────────────────────────────────────

  test('run:cancel when no active process emits a run:log warning', async () => {
    const socketClient = connectSocketClient(activeServerInstance.serverUrl);

    try {
      // Wait for the socket connection to be established
      await new Promise<void>((resolve, reject) => {
        const timeoutHandle = setTimeout(() => reject(new Error('Socket connect timeout')), 3000);
        socketClient.on('connect', () => { clearTimeout(timeoutHandle); resolve(); });
      });

      // Collect all log events emitted after the cancel request
      const receivedLogEvents: Array<{ level: string; message: string }> = [];
      socketClient.on('run:log', (logEvent: { level: string; message: string }) => {
        receivedLogEvents.push(logEvent);
      });

      const warningLogPromise = waitForSocketEvent<{ level: string; message: string }>(
        socketClient,
        'run:log',
      );

      // Cancel with no active run — server should emit a warning, not a run:done
      socketClient.emit('run:cancel');

      const warningPayload = await warningLogPromise;

      expect(warningPayload.level).toBe('warning');
      expect(warningPayload.message).toContain('cancel');
    } finally {
      socketClient.disconnect();
    }
  });
});
