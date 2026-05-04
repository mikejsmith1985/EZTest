/**
 * ariaSnapshotCapture — Best-effort accessibility tree capture for failing tests.
 *
 * When a test fails due to a missing element, the AI regenerator benefits greatly
 * from seeing what the page actually looks like at that moment. This module
 * launches a headless browser, navigates to the target URL, and captures the
 * accessibility tree snapshot via Playwright's ariaSnapshot() method.
 *
 * All failures are silently suppressed and return null — the caller always gets
 * either a useful snapshot or nothing. This prevents snapshot failures from
 * blocking the test fix loop.
 */
import { logDebug, logWarning } from '../shared/logger.js';

/** Maximum time in milliseconds to wait for a page to load before giving up. */
const PAGE_LOAD_TIMEOUT_MS = 10_000;

/**
 * Attempts to capture a YAML accessibility tree snapshot of the page at the given URL.
 *
 * Launches a headless browser, navigates to the URL, waits for the DOM to stabilize,
 * then calls page.ariaSnapshot() to get a YAML representation of the accessibility tree.
 *
 * Returns null if the page is unreachable, requires authentication, or any error occurs.
 * The caller should treat null as "no additional context available" and proceed normally.
 *
 * @param targetUrl - The URL to navigate to and snapshot
 * @returns YAML accessibility tree snapshot string, or null if capture fails
 */
export async function captureAriaSnapshot(targetUrl: string): Promise<string | null> {
  let browser;
  try {
    // Dynamic import to avoid bundling the Playwright browser binaries unless
    // they're actually needed. The portable bundle includes @playwright/test
    // in node_modules, so this import is always available at runtime.
    const { chromium } = await import('@playwright/test');
    browser = await chromium.launch({ headless: true });
    const browserContext = await browser.newContext();
    const page = await browserContext.newPage();

    // Navigate with a timeout — unreachable URLs fail fast
    await page.goto(targetUrl, {
      timeout: PAGE_LOAD_TIMEOUT_MS,
      waitUntil: 'domcontentloaded',
    });

    // Wait for the page to stabilize before capturing
    await page.waitForLoadState('domcontentloaded');

    // ariaSnapshot() returns a YAML string of the accessibility tree
    const snapshot = await page.ariaSnapshot();

    logDebug(`Captured aria snapshot for ${targetUrl} (${snapshot.length} chars)`);
    return snapshot;
  } catch (captureError) {
    // Best-effort: any failure (auth required, network error, timeout) → return null
    logWarning(
      `Could not capture aria snapshot for ${targetUrl}: ` +
      `${captureError instanceof Error ? captureError.message : String(captureError)}`,
    );
    return null;
  } finally {
    if (browser) {
      await browser.close().catch(() => {
        // Ignore close errors — the browser may already be closed
      });
    }
  }
}
