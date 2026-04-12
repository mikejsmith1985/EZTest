/**
 * Unit tests for the Bug Report Builder.
 * These tests verify that BugReports are assembled correctly from session data
 * and that interaction histories are formatted cleanly for AI prompts.
 */
import { test, expect } from '@playwright/test';
import { buildBugReport, formatInteractionHistoryForPrompt } from '../../src/recorder/bugReportBuilder.js';
import type { RecordedInteraction } from '../../src/shared/types.js';

const SAMPLE_CLICK_INTERACTION: RecordedInteraction = {
  timestampMs: 1200,
  interactionKind: 'click',
  targetSelector: '[data-testid="remove-item-button"]',
  targetDescription: 'Remove button for "Widget Pro"',
  pageUrl: 'http://localhost:3000/cart',
  domStateBefore: '<div class="cart">...</div>',
  domStateAfter: '<div class="cart">...</div>',
  triggeredNetworkRequests: [
    { url: '/api/cart/items/42', method: 'DELETE', statusCode: 200 },
  ],
};

const SAMPLE_NAVIGATION_INTERACTION: RecordedInteraction = {
  timestampMs: 0,
  interactionKind: 'navigation',
  targetSelector: 'http://localhost:3000/cart',
  pageUrl: 'http://localhost:3000/cart',
  domStateBefore: '',
  domStateAfter: '<div class="cart">3 items</div>',
  triggeredNetworkRequests: [],
};

test.describe('buildBugReport', () => {
  test('creates a bug report with a unique ID and correct fields', () => {
    const bugReport = buildBugReport({
      userExpectation: 'The cart total should update after removing an item',
      observedAtUrl: 'http://localhost:3000/cart',
      flaggedAt: '2026-04-12T12:00:00.000Z',
      interactionHistory: [SAMPLE_CLICK_INTERACTION],
      domStateAtFlag: '<div class="cart-total">$99.99</div>',
    });

    // The report ID must be a valid UUID
    expect(bugReport.reportId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );
    expect(bugReport.userExpectation).toBe('The cart total should update after removing an item');
    expect(bugReport.observedAtUrl).toBe('http://localhost:3000/cart');
    expect(bugReport.interactionHistory).toHaveLength(1);
    expect(bugReport.domStateAtFlag).toContain('cart-total');
  });

  test('generates a different ID for each report (ensures uniqueness)', () => {
    const input = {
      userExpectation: 'Button should work',
      observedAtUrl: 'http://localhost:3000',
      flaggedAt: new Date().toISOString(),
      interactionHistory: [],
      domStateAtFlag: '',
    };

    const firstReport = buildBugReport(input);
    const secondReport = buildBugReport(input);

    expect(firstReport.reportId).not.toBe(secondReport.reportId);
  });

  test('includes optional screenshot when provided', () => {
    const bugReport = buildBugReport({
      userExpectation: 'Modal should close',
      observedAtUrl: 'http://localhost:3000',
      flaggedAt: new Date().toISOString(),
      interactionHistory: [],
      domStateAtFlag: '',
      screenshotAtFlag: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB',
    });

    expect(bugReport.screenshotAtFlag).toBeDefined();
    expect(bugReport.screenshotAtFlag).toContain('data:image/png');
  });
});

test.describe('formatInteractionHistoryForPrompt', () => {
  test('formats an empty history gracefully', () => {
    const formatted = formatInteractionHistoryForPrompt([]);

    expect(formatted).toContain('No interactions recorded');
  });

  test('formats navigation interactions with the destination URL', () => {
    const formatted = formatInteractionHistoryForPrompt([SAMPLE_NAVIGATION_INTERACTION]);

    expect(formatted).toContain('1.');
    expect(formatted).toContain('Navigated');
    expect(formatted).toContain('http://localhost:3000/cart');
  });

  test('formats click interactions with the element description', () => {
    const formatted = formatInteractionHistoryForPrompt([SAMPLE_CLICK_INTERACTION]);

    expect(formatted).toContain('1.');
    expect(formatted).toContain('Clicked');
    expect(formatted).toContain('Remove button for "Widget Pro"');
  });

  test('numbers steps sequentially for multi-step histories', () => {
    const formatted = formatInteractionHistoryForPrompt([
      SAMPLE_NAVIGATION_INTERACTION,
      SAMPLE_CLICK_INTERACTION,
    ]);

    expect(formatted).toContain('1.');
    expect(formatted).toContain('2.');
  });

  test('formats input interactions with the typed value', () => {
    const inputInteraction: RecordedInteraction = {
      ...SAMPLE_CLICK_INTERACTION,
      interactionKind: 'input',
      targetDescription: 'Email input',
      inputValue: 'user@example.com',
    };

    const formatted = formatInteractionHistoryForPrompt([inputInteraction]);

    expect(formatted).toContain('Typed');
    expect(formatted).toContain('user@example.com');
    expect(formatted).toContain('Email input');
  });
});
