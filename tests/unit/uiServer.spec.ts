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

  test('GET / served HTML has valid JavaScript (no broken regex from template literal escaping)', async () => {
    const response = await fetch(activeServerInstance.serverUrl + '/');
    const htmlBody = await response.text();

    // Extract the inline <script> block
    const scriptMatch = htmlBody.match(/<script>([\s\S]*?)<\/script>/);
    expect(scriptMatch).not.toBeNull();

    const scriptContent = scriptMatch![1];

    // Confirm all 6 action cards are present — a blank page means cards are missing
    const cardMatches = htmlBody.match(/class="action-card"/g) ?? [];
    expect(cardMatches).toHaveLength(6);
    expect(htmlBody).toContain('Set Up EZTest In My IDE');
    expect(htmlBody).toContain('Manage AI Provider');

    // The most common template-literal escape bug: \d and \s lose their backslash,
    // turning /(\d+)/ into /(d+)/ in the output. Verify the raw regex chars are correct.
    // A valid output must contain \d and \s (escaped form), not bare d+ or s+ in regex context.
    expect(scriptContent).toContain('\\d+');
    expect(scriptContent).toContain('\\s+');

    // The critical structural check: no unescaped slash mid-regex that would cause
    // "SyntaxError: Unexpected token" and blank the entire page.
    // We detect this by ensuring the script does NOT contain the broken pattern.
    expect(scriptContent).not.toMatch(/logMessage\.match\(\/[^)]*[^\\]\/[^)]*\/[^)]*\)/);
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

  // ── GET /api/env ─────────────────────────────────────────────────────────────

  test('GET /api/env returns hasKey false when no API key is set', async () => {
    // Stash and clear all known provider keys so the status read starts clean
    const savedGithubToken   = process.env['EZTEST_GITHUB_TOKEN'];
    const savedOpenAiKey     = process.env['OPENAI_API_KEY'];
    const savedAnthropicKey  = process.env['ANTHROPIC_API_KEY'];
    const savedAiProvider    = process.env['EZTEST_AI_PROVIDER'];

    delete process.env['EZTEST_GITHUB_TOKEN'];
    delete process.env['OPENAI_API_KEY'];
    delete process.env['ANTHROPIC_API_KEY'];
    delete process.env['EZTEST_AI_PROVIDER'];

    try {
      const response = await fetch(activeServerInstance.serverUrl + '/api/env');
      expect(response.status).toBe(200);

      const envStatus = await response.json() as { provider: string | null; providerLabel: string; hasKey: boolean };
      expect(envStatus.hasKey).toBe(false);
      expect(envStatus.provider).toBeNull();
    } finally {
      if (savedGithubToken  !== undefined) { process.env['EZTEST_GITHUB_TOKEN']  = savedGithubToken; }
      if (savedOpenAiKey    !== undefined) { process.env['OPENAI_API_KEY']        = savedOpenAiKey; }
      if (savedAnthropicKey !== undefined) { process.env['ANTHROPIC_API_KEY']     = savedAnthropicKey; }
      if (savedAiProvider   !== undefined) { process.env['EZTEST_AI_PROVIDER']    = savedAiProvider; }
    }
  });

  test('GET /api/env returns correct provider when OpenAI key is present', async () => {
    const savedOpenAiKey  = process.env['OPENAI_API_KEY'];
    const savedAiProvider = process.env['EZTEST_AI_PROVIDER'];
    const savedGithubToken = process.env['EZTEST_GITHUB_TOKEN'];

    // Only set OpenAI so the provider detection is unambiguous
    delete process.env['EZTEST_GITHUB_TOKEN'];
    delete process.env['EZTEST_AI_PROVIDER'];
    process.env['OPENAI_API_KEY'] = 'sk-test-get-env-openai';

    try {
      const response = await fetch(activeServerInstance.serverUrl + '/api/env');
      expect(response.status).toBe(200);

      const envStatus = await response.json() as { provider: string | null; providerLabel: string; hasKey: boolean };
      expect(envStatus.hasKey).toBe(true);
      expect(envStatus.provider).toBe('openai');
      expect(envStatus.providerLabel).toBe('OpenAI');
    } finally {
      if (savedOpenAiKey   !== undefined) { process.env['OPENAI_API_KEY']      = savedOpenAiKey;   } else { delete process.env['OPENAI_API_KEY']; }
      if (savedAiProvider  !== undefined) { process.env['EZTEST_AI_PROVIDER']  = savedAiProvider;  } else { delete process.env['EZTEST_AI_PROVIDER']; }
      if (savedGithubToken !== undefined) { process.env['EZTEST_GITHUB_TOKEN'] = savedGithubToken; } else { delete process.env['EZTEST_GITHUB_TOKEN']; }
    }
  });

  // ── DELETE /api/env ───────────────────────────────────────────────────────────

  test('DELETE /api/env removes the active provider key from process.env', async () => {
    const savedOpenAiKey  = process.env['OPENAI_API_KEY'];
    const savedAiProvider = process.env['EZTEST_AI_PROVIDER'];

    // Set up OpenAI as the active provider so delete has something to remove
    process.env['OPENAI_API_KEY']     = 'sk-test-delete-openai';
    process.env['EZTEST_AI_PROVIDER'] = 'openai';

    try {
      const response = await fetch(activeServerInstance.serverUrl + '/api/env', { method: 'DELETE' });
      expect(response.status).toBe(200);

      const removeResult = await response.json() as { removed: boolean };
      expect(removeResult.removed).toBe(true);

      // The server must have cleared the key from its running process.env
      expect(process.env['OPENAI_API_KEY']).toBeUndefined();
      expect(process.env['EZTEST_AI_PROVIDER']).toBeUndefined();
    } finally {
      if (savedOpenAiKey  !== undefined) { process.env['OPENAI_API_KEY']     = savedOpenAiKey;  } else { delete process.env['OPENAI_API_KEY']; }
      if (savedAiProvider !== undefined) { process.env['EZTEST_AI_PROVIDER'] = savedAiProvider; } else { delete process.env['EZTEST_AI_PROVIDER']; }
      // Clean up any .env lines written during this test
      const envFilePath = join(process.cwd(), '.env');
      if (existsSync(envFilePath)) {
        let envContent = readFileSync(envFilePath, 'utf-8');
        envContent = envContent.replace(/^OPENAI_API_KEY=sk-test-delete-openai\r?\n?/m, '');
        writeFileSync(envFilePath, envContent, 'utf-8');
      }
    }
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
