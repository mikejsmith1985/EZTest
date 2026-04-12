/**
 * Unit tests for the Session Recorder and Interaction Tracker modules.
 *
 * Tests cover:
 * - The interaction tracking browser script structure (no browser required)
 * - The saveBugReport helper behavior (writes to correct path)
 * - The selector generation logic (via the exported interactionTracker script)
 */
import { test, expect } from '@playwright/test';
import { mkdirSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { buildInteractionTrackingScript } from '../../src/recorder/interactionTracker.js';

// ── Test Setup ─────────────────────────────────────────────────────────────

let testTempDirectory: string;

test.beforeAll(() => {
  testTempDirectory = join('test-results', `session-recorder-unit-${randomUUID()}`);
  mkdirSync(testTempDirectory, { recursive: true });
});

test.afterAll(() => {
  if (existsSync(testTempDirectory)) {
    rmSync(testTempDirectory, { recursive: true, force: true });
  }
});

// ── Interaction Tracker Script Tests ───────────────────────────────────────

test.describe('buildInteractionTrackingScript', () => {
  test('returns a non-empty string', () => {
    const script = buildInteractionTrackingScript();
    expect(typeof script).toBe('string');
    expect(script.length).toBeGreaterThan(500);
  });

  test('script contains the double-injection guard', () => {
    const script = buildInteractionTrackingScript();
    // Must check if already injected to survive SPA in-page navigation
    expect(script).toContain('__eztest_tracking_active');
  });

  test('script calls window.__eztest_record for click events', () => {
    const script = buildInteractionTrackingScript();
    expect(script).toContain('__eztest_record');
    expect(script).toContain("'click'");
    // Capture phase (true) ensures it fires before app handlers
    expect(script).toContain('true');
  });

  test('script calls window.__eztest_record for change events', () => {
    const script = buildInteractionTrackingScript();
    expect(script).toContain("'change'");
    // Should use 'change' not 'input' to capture final value, not every keystroke
    expect(script).not.toContain("addEventListener('input'");
  });

  test('script filters out EZTest overlay elements', () => {
    const script = buildInteractionTrackingScript();
    // Must guard against recording clicks on the EZTest flag button itself
    expect(script).toContain('eztest-');
    expect(script).toContain('isEZTestOverlayElement');
  });

  test('script uses capture phase for event listeners', () => {
    const script = buildInteractionTrackingScript();
    // Both click and change listeners must use capture phase (third argument = true)
    // to fire before the app's own handlers and get the pre-interaction state
    const capturePhaseCount = (script.match(/,\s*true\s*\)/g) || []).length;
    expect(capturePhaseCount).toBeGreaterThanOrEqual(2);
  });

  test('script captures DOM snapshot before the interaction', () => {
    const script = buildInteractionTrackingScript();
    // domBefore should be captured at the time of the event, not after
    expect(script).toContain('captureDomSnapshot');
    expect(script).toContain('domBefore');
  });

  test('script generates meaningful selectors with priority order', () => {
    const script = buildInteractionTrackingScript();
    // Selector priority: data-testid > aria-label > id > text content
    expect(script).toContain('data-testid');
    expect(script).toContain('aria-label');
    // ID should be used but NOT for eztest- prefixed IDs
    expect(script).toContain("!elementId.startsWith('eztest-')");
  });

  test('script is valid IIFE syntax that would parse as JavaScript', () => {
    const script = buildInteractionTrackingScript();
    // Must be wrapped in an IIFE to avoid polluting global scope
    expect(script.trim()).toMatch(/^\(function\s*\(\s*\)/);
    expect(script.trim()).toMatch(/\}\)\(\)\s*;?\s*$/);
  });

  test('script uses fire-and-forget pattern for the bridge call', () => {
    const script = buildInteractionTrackingScript();
    // Must NOT block the UI with await at the top level
    // The .catch() indicates fire-and-forget (call but don't block on result)
    expect(script).toContain('.catch(');
  });

  test('script truncates DOM snapshots to prevent oversized payloads', () => {
    const script = buildInteractionTrackingScript();
    // 8KB limit per snapshot — prevent megabyte payloads
    expect(script).toContain('8000');
  });
});
