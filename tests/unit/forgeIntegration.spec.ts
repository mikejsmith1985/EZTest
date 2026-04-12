/**
 * Unit tests for the Forge Terminal Integration module.
 *
 * Tests the two delivery modes (webhook and file drop) and verifies that the
 * formatted agent prompt contains all the essential bug report information.
 */
import { test, expect } from '@playwright/test';
import { mkdirSync, existsSync, rmSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { sendBugReportToForgeAgent } from '../../src/agentLoop/forgeIntegration.js';
import type { BugReport } from '../../src/shared/types.js';

// ── Test Fixtures ──────────────────────────────────────────────────────────

function createMockBugReport(): BugReport {
  return {
    reportId: `forge-test-${randomUUID().slice(0, 8)}`,
    reportedAt: '2026-04-12T13:00:00.000Z',
    observedAtUrl: 'http://localhost:3000/checkout',
    userExpectation: 'The order total should update when I change the quantity',
    interactionHistory: [
      {
        timestampMs: 500,
        interactionKind: 'click',
        targetSelector: '[data-testid="qty-increment"]',
        targetDescription: 'Quantity increment button',
        pageUrl: 'http://localhost:3000/checkout',
        domStateBefore: '<div class="qty">1</div>',
        domStateAfter: '<div class="qty">2</div>',
        triggeredNetworkRequests: [],
      },
    ],
    domStateAtFlag: '<div class="order-total">$10.00</div>',
    sourceDirectory: './src',
  };
}

// ── Test Setup ─────────────────────────────────────────────────────────────

let testTemporaryDirectory: string;

test.beforeAll(() => {
  testTemporaryDirectory = join('test-results', `forge-integration-unit-${randomUUID()}`);
  mkdirSync(testTemporaryDirectory, { recursive: true });
});

test.afterAll(() => {
  if (existsSync(testTemporaryDirectory)) {
    rmSync(testTemporaryDirectory, { recursive: true, force: true });
  }
});

// ── File Delivery Tests ────────────────────────────────────────────────────

test.describe('sendBugReportToForgeAgent — file delivery', () => {
  test('writes an agent prompt markdown file to .forge/pending-tasks/', async () => {
    const bugReport = createMockBugReport();

    await sendBugReportToForgeAgent(bugReport, {
      projectWorkingDirectory: testTemporaryDirectory,
    });

    const expectedTaskFilePath = resolve(
      testTemporaryDirectory,
      '.forge',
      'pending-tasks',
      `bug-report-${bugReport.reportId}.md`,
    );

    expect(existsSync(expectedTaskFilePath)).toBe(true);
  });

  test('creates the .forge/pending-tasks/ directory if it does not exist', async () => {
    const bugReport = createMockBugReport();
    const freshDirectory = join(testTemporaryDirectory, `fresh-${randomUUID().slice(0, 8)}`);
    mkdirSync(freshDirectory, { recursive: true });

    await sendBugReportToForgeAgent(bugReport, {
      projectWorkingDirectory: freshDirectory,
    });

    const pendingTasksDirectory = resolve(freshDirectory, '.forge', 'pending-tasks');
    expect(existsSync(pendingTasksDirectory)).toBe(true);
  });

  test('agent prompt contains the bug report ID', async () => {
    const bugReport = createMockBugReport();

    await sendBugReportToForgeAgent(bugReport, {
      projectWorkingDirectory: testTemporaryDirectory,
    });

    const taskFilePath = resolve(
      testTemporaryDirectory,
      '.forge',
      'pending-tasks',
      `bug-report-${bugReport.reportId}.md`,
    );
    const promptContent = readFileSync(taskFilePath, 'utf-8');
    expect(promptContent).toContain(bugReport.reportId);
  });

  test('agent prompt contains the user expectation', async () => {
    const bugReport = createMockBugReport();

    await sendBugReportToForgeAgent(bugReport, {
      projectWorkingDirectory: testTemporaryDirectory,
    });

    const taskFilePath = resolve(
      testTemporaryDirectory,
      '.forge',
      'pending-tasks',
      `bug-report-${bugReport.reportId}.md`,
    );
    const promptContent = readFileSync(taskFilePath, 'utf-8');
    expect(promptContent).toContain(bugReport.userExpectation);
  });

  test('agent prompt includes all four required task steps', async () => {
    const bugReport = createMockBugReport();

    await sendBugReportToForgeAgent(bugReport, {
      projectWorkingDirectory: testTemporaryDirectory,
    });

    const taskFilePath = resolve(
      testTemporaryDirectory,
      '.forge',
      'pending-tasks',
      `bug-report-${bugReport.reportId}.md`,
    );
    const promptContent = readFileSync(taskFilePath, 'utf-8');

    expect(promptContent).toContain('Step 1');
    expect(promptContent).toContain('Step 2');
    expect(promptContent).toContain('Step 3');
    expect(promptContent).toContain('Step 4');
  });

  test('interaction history steps appear in the agent prompt', async () => {
    const bugReport = createMockBugReport();

    await sendBugReportToForgeAgent(bugReport, {
      projectWorkingDirectory: testTemporaryDirectory,
    });

    const taskFilePath = resolve(
      testTemporaryDirectory,
      '.forge',
      'pending-tasks',
      `bug-report-${bugReport.reportId}.md`,
    );
    const promptContent = readFileSync(taskFilePath, 'utf-8');

    // The interaction history should be formatted with numbered steps
    expect(promptContent).toMatch(/Step 1:|1\./);
  });
});

// ── Webhook Delivery Tests ─────────────────────────────────────────────────

test.describe('sendBugReportToForgeAgent — webhook delivery', () => {
  test('falls back to file delivery when webhook returns a non-OK status', async () => {
    const bugReport = createMockBugReport();
    const fallbackDirectory = join(testTemporaryDirectory, `webhook-fallback-${randomUUID().slice(0, 8)}`);
    mkdirSync(fallbackDirectory, { recursive: true });

    // Mock fetch to return a server error — should trigger fallback to file delivery
    const originalFetch = global.fetch;
    global.fetch = async () => new Response(null, { status: 500 }) as Response;

    try {
      await sendBugReportToForgeAgent(bugReport, {
        webhookUrl: 'http://localhost:9999/webhook/eztest',
        projectWorkingDirectory: fallbackDirectory,
      });
    } finally {
      global.fetch = originalFetch;
    }

    // File should have been written as fallback
    const expectedFilePath = resolve(
      fallbackDirectory,
      '.forge',
      'pending-tasks',
      `bug-report-${bugReport.reportId}.md`,
    );
    expect(existsSync(expectedFilePath)).toBe(true);
  });

  test('falls back to file delivery when webhook throws a network error', async () => {
    const bugReport = createMockBugReport();
    const fallbackDirectory = join(testTemporaryDirectory, `webhook-error-${randomUUID().slice(0, 8)}`);
    mkdirSync(fallbackDirectory, { recursive: true });

    const originalFetch = global.fetch;
    global.fetch = async () => { throw new Error('ECONNREFUSED'); };

    try {
      await sendBugReportToForgeAgent(bugReport, {
        webhookUrl: 'http://localhost:9999/webhook/eztest',
        projectWorkingDirectory: fallbackDirectory,
      });
    } finally {
      global.fetch = originalFetch;
    }

    const expectedFilePath = resolve(
      fallbackDirectory,
      '.forge',
      'pending-tasks',
      `bug-report-${bugReport.reportId}.md`,
    );
    expect(existsSync(expectedFilePath)).toBe(true);
  });

  test('does NOT write a file when webhook succeeds', async () => {
    const bugReport = createMockBugReport();
    const successDirectory = join(testTemporaryDirectory, `webhook-success-${randomUUID().slice(0, 8)}`);
    mkdirSync(successDirectory, { recursive: true });

    const originalFetch = global.fetch;
    global.fetch = async () => new Response(JSON.stringify({ status: 'ok' }), { status: 200 });

    try {
      await sendBugReportToForgeAgent(bugReport, {
        webhookUrl: 'http://localhost:9999/webhook/eztest',
        projectWorkingDirectory: successDirectory,
      });
    } finally {
      global.fetch = originalFetch;
    }

    const pendingTasksDirectory = resolve(successDirectory, '.forge', 'pending-tasks');
    expect(existsSync(pendingTasksDirectory)).toBe(false);
  });
});
