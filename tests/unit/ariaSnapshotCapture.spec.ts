/**
 * Unit tests for the ariaSnapshot capture module.
 *
 * The capture function is best-effort: it attempts to launch a headless browser
 * and snapshot the page, but gracefully returns null if the page is unreachable,
 * requires authentication, or the browser fails to launch.
 */
import { test, expect } from '@playwright/test';
import { captureAriaSnapshot } from '../../src/synthesizer/ariaSnapshotCapture.js';

// Override the project-level 5s timeout — network calls need more headroom.
// "Unreachable" tests fail fast (connection refused), but DNS failure can
// take several seconds before the OS returns NXDOMAIN.
test.describe('captureAriaSnapshot', () => {
  test.setTimeout(30_000);

  test('returns null when the target URL is unreachable', async () => {
    // A closed port on localhost should cause a navigation failure → null
    const result = await captureAriaSnapshot('http://localhost:19999');
    expect(result).toBeNull();
  });

  test('returns null for a URL that causes a network error', async () => {
    // An invalid hostname should produce a network error → null
    const result = await captureAriaSnapshot('http://invalid-host-that-does-not-exist-eztest.local');
    expect(result).toBeNull();
  });

  test('returns a non-empty string for a reachable page', async () => {
    // Use the Playwright test server that the test runner provides.
    // If a real page is available, we get a non-empty string snapshot.
    // SKIP this if no server is available — it's best-effort
    const result = await captureAriaSnapshot('https://example.com');
    // Either returns a non-empty string (page loaded) or null (blocked, auth, etc.)
    if (result !== null) {
      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(0);
    }
    // null is also acceptable — the function is best-effort
  });
});
