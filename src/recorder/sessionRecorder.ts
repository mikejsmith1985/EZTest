/**
 * Session Recorder — the heart of the "Follow Me" experience in EZTest.
 *
 * Uses Playwright's Chrome DevTools Protocol (CDP) access to record every user
 * interaction with perfect fidelity: clicks, inputs, navigation, network calls,
 * and DOM snapshots before/after each action. When the user flags an unexpected
 * result, the full session context is packaged into a BugReport.
 *
 * The recorder orchestrates three components:
 * 1. Playwright browser for interaction capture and overlay injection
 * 2. Annotation Server for receiving bug flags from the overlay UI
 * 3. Bug Report Builder for assembling the final structured report
 */
import { chromium } from '@playwright/test';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import type { RecordedInteraction, NetworkRequestRecord, BugReport } from '../shared/types.js';
import { startAnnotationServer, SOCKET_EVENTS } from './annotationServer.js';
import type { AnnotationServerInstance, BugFlagAnnotation } from './annotationServer.js';
import { buildOverlayScript } from './overlay/overlayScript.js';
import { buildInteractionTrackingScript } from './interactionTracker.js';
import type { BrowserInteractionData } from './interactionTracker.js';
import { buildBugReport } from './bugReportBuilder.js';
import { logInfo, logSuccess, logDebug, logWarning } from '../shared/logger.js';

// ── Selector Generation ────────────────────────────────────────────────────

/**
 * Generates the best available CSS selector for a DOM element.
 * Prefers: data-testid → aria-label → role+text → element type+text → nth-of-type
 *
 * The CDP provides element info as a serialized object — we extract identifiers
 * from it to produce Playwright-compatible selectors.
 */
function generateBestSelectorFromElementInfo(elementInfo: {
  tagName?: string;
  attributes?: Record<string, string>;
  textContent?: string;
}): string {
  const attributes = elementInfo.attributes ?? {};
  const tagName = elementInfo.tagName?.toLowerCase() ?? 'element';
  const textContent = elementInfo.textContent?.trim().slice(0, 50);

  if (attributes['data-testid']) return `[data-testid="${attributes['data-testid']}"]`;
  if (attributes['data-cy']) return `[data-cy="${attributes['data-cy']}"]`;
  if (attributes['aria-label']) return `[aria-label="${attributes['aria-label']}"]`;
  if (attributes['id']) return `#${attributes['id']}`;
  if (textContent && ['button', 'a'].includes(tagName)) return `${tagName}:has-text("${textContent}")`;
  if (attributes['name']) return `[name="${attributes['name']}"]`;
  if (attributes['type']) return `${tagName}[type="${attributes['type']}"]`;

  return tagName;
}

// ── Interaction Recording via CDP ──────────────────────────────────────────

/**
 * Attaches a Chrome DevTools Protocol session to the page and sets up
 * network request interception for capturing triggered network calls.
 */
async function setupCdpNetworkCapture(page: Page): Promise<{
  capturedRequests: NetworkRequestRecord[];
  clearCapturedRequests: () => void;
}> {
  const capturedRequests: NetworkRequestRecord[] = [];

  // Playwright's built-in request/response events are simpler than raw CDP for network
  page.on('request', (request) => {
    capturedRequests.push({
      url: request.url(),
      method: request.method(),
      requestBody: request.postData() ?? undefined,
    });
  });

  page.on('response', async (response) => {
    const matchingRequest = capturedRequests.find(
      captured => captured.url === response.url() && !captured.statusCode
    );
    if (matchingRequest) {
      matchingRequest.statusCode = response.status();
      try {
        // Only capture response body for JSON API calls to avoid huge payloads
        const contentType = response.headers()['content-type'] ?? '';
        if (contentType.includes('application/json')) {
          matchingRequest.responseBody = await response.text();
        }
      } catch {
        // Some responses can't be read (e.g., already consumed) — silently skip
      }
    }
  });

  return {
    capturedRequests,
    clearCapturedRequests: () => capturedRequests.splice(0),
  };
}

// ── DOM Snapshot ───────────────────────────────────────────────────────────

  /**
   * Captures a lightweight DOM snapshot of the current page state.
   * We capture the outer HTML of the body (truncated) — enough for the AI to understand
   * the page structure without sending megabytes of HTML per interaction.
   */
async function capturePageDomSnapshot(page: Page): Promise<string> {
  try {
    const domSnapshot = await page.evaluate((): string => {
      const body = document.body; // eslint-disable-line no-undef
      if (!body) return '';
      // Remove script/style/svg to reduce noise in the snapshot
      const clonedBody = body.cloneNode(true) as Element;
      clonedBody.querySelectorAll('script, style, svg').forEach((element: Element) => element.remove());
      return clonedBody.innerHTML.slice(0, 8000); // 8KB limit per snapshot
    });
    return domSnapshot;
  } catch {
    return '[DOM snapshot unavailable]';
  }
}

// ── Main Session Recording Engine ─────────────────────────────────────────

/** Active recording session state. */
interface RecordingSession {
  browser: Browser;
  browserContext: BrowserContext;
  page: Page;
  annotationServer: AnnotationServerInstance;
  interactionHistory: RecordedInteraction[];
  sessionStartTimeMs: number;
}

/**
 * Records a single user interaction and appends it to the interaction history.
 * Called by page event listeners during the recording session.
 */
async function recordInteraction(
  session: RecordingSession,
  interactionKind: RecordedInteraction['interactionKind'],
  targetSelector: string,
  targetDescription: string | undefined,
  inputValue: string | undefined,
  capturedRequests: NetworkRequestRecord[],
  domStateBefore: string,
): Promise<void> {
  // Wait for the page to settle after the interaction before capturing after-state
  await session.page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => {
    // Non-fatal — some interactions don't trigger navigation, so networkidle may not fire
  });

  const domStateAfter = await capturePageDomSnapshot(session.page);

  const interaction: RecordedInteraction = {
    timestampMs: Date.now() - session.sessionStartTimeMs,
    interactionKind,
    targetSelector,
    targetDescription,
    inputValue,
    pageUrl: session.page.url(),
    domStateBefore,
    domStateAfter,
    triggeredNetworkRequests: [...capturedRequests],
  };

  session.interactionHistory.push(interaction);
  capturedRequests.splice(0); // Clear captured requests for next interaction
  logDebug(`Recorded: ${interactionKind} on ${targetSelector} at ${session.page.url()}`);
}

// ── Public API ─────────────────────────────────────────────────────────────

/** Options for starting a recording session. */
export interface RecordingSessionOptions {
  /** URL to open in the recording browser */
  targetUrl: string;
  /** Port for the annotation server */
  annotationServerPort: number;
  /** Directory to save bug reports to */
  bugReportOutputDirectory: string;
  /** Whether to run the browser with the UI visible (non-headless) */
  shouldShowBrowser: boolean;
}

/**
 * Starts an EZTest recording session.
 *
 * Opens a browser with the annotation overlay injected, records all user interactions,
 * and waits for bug flags from the overlay. When a bug is flagged, packages everything
 * into a BugReport and saves it to disk.
 *
 * Returns when the user closes the browser or presses Ctrl+C.
 */
export async function startRecordingSession(
  options: RecordingSessionOptions,
): Promise<BugReport[]> {
  const {
    targetUrl,
    annotationServerPort,
    bugReportOutputDirectory,
    shouldShowBrowser,
  } = options;

  // Start the annotation server first so it's ready before the browser opens
  const annotationServer = await startAnnotationServer(annotationServerPort);
  const collectedBugReports: BugReport[] = [];

  // Launch the browser — always headed (non-headless) during recording so the user can interact
  const browser = await chromium.launch({
    headless: false,
    args: ['--disable-web-security'], // Allows overlay to communicate with localhost server
  });

  const browserContext = await browser.newContext({
    javaScriptEnabled: true,
  });

  const page = await browserContext.newPage();

  // Set up network capture before the exposeFunction handler (so capturedRequests is in scope)
  const { capturedRequests } = await setupCdpNetworkCapture(page);

  const session: RecordingSession = {
    browser,
    browserContext,
    page,
    annotationServer,
    interactionHistory: [],
    sessionStartTimeMs: Date.now(),
  };

  // Register the Node.js bridge that the browser-side tracking script calls.
  // exposeFunction must be registered BEFORE any navigation occurs.
  await page.exposeFunction(
    '__eztest_record',
    async (data: BrowserInteractionData) => {
      await recordInteraction(
        session,
        data.kind,
        data.selector,
        data.description,
        data.value ?? undefined,
        capturedRequests,
        data.domBefore,
      );
    },
  );

  // Inject the annotation overlay (flag button + modal) into every page that loads
  const overlayScript = buildOverlayScript(annotationServer.serverUrl);
  await browserContext.addInitScript({ content: overlayScript });

  // Inject the interaction tracking script — captures clicks and input changes,
  // sending them to Node.js via the __eztest_record bridge registered above
  await browserContext.addInitScript({ content: buildInteractionTrackingScript() });

  // ── Listen for bug flags from the overlay ──
  annotationServer.socketServer.on('connection', (socket) => {
    // Bug flag: user clicked "🚩 Flag Unexpected Result" and described the problem
    socket.on(SOCKET_EVENTS.BUG_FLAGGED, async (annotation: BugFlagAnnotation) => {
      logInfo(`\n🚩 Bug flagged at ${annotation.pageUrl}`);
      logInfo(`   Expected: "${annotation.userExpectation}"`);

      const domStateAtFlag = await capturePageDomSnapshot(page);

      const bugReport = buildBugReport({
        userExpectation: annotation.userExpectation,
        observedAtUrl: annotation.pageUrl,
        flaggedAt: annotation.flaggedAt,
        interactionHistory: [...session.interactionHistory],
        screenshotAtFlag: annotation.screenshotData,
        domStateAtFlag,
      });

      const savedReportPath = await saveBugReport(bugReport, bugReportOutputDirectory);
      collectedBugReports.push(bugReport);

      logSuccess(`Bug report saved: ${savedReportPath}`);
      logInfo(`   Report ID: ${bugReport.reportId}`);
    });

    // Note: click/input interactions are now captured via page.exposeFunction('__eztest_record')
    // rather than Socket.io, which is more reliable and avoids an HTTP roundtrip.
  });

  // ── Record page interactions ──
  // Track navigation events
  page.on('framenavigated', async (frame) => {
    if (frame === page.mainFrame()) {
      const domBefore = '[navigation triggered]';
      await recordInteraction(
        session, 'navigation', page.url(), `Navigated to ${page.url()}`,
        undefined, capturedRequests, domBefore,
      );
    }
  });

  // Navigate to the target URL
  logInfo(`Opening recording browser at ${targetUrl}...`);
  await page.goto(targetUrl);

  logSuccess(`Recording session started!`);
  logInfo(`  → Use the application normally in the browser`);
  logInfo(`  → Click "🚩 Flag Unexpected Result" when something doesn't work as expected`);
  logInfo(`  → Press Ctrl+C to end the session`);
  logInfo(`  → Bug reports will be saved to: ${bugReportOutputDirectory}`);

  // Keep the session alive until the browser is closed or process is interrupted
  await new Promise<void>((resolve) => {
    browser.on('disconnected', () => resolve());
    process.on('SIGINT', async () => {
      logInfo('\nEnding recording session...');
      resolve();
    });
  });

  await annotationServer.shutdown();
  await browser.close().catch(() => {});

  logSuccess(`Recording session ended. Captured ${collectedBugReports.length} bug report(s).`);
  return collectedBugReports;
}

// ── Bug Report Persistence ─────────────────────────────────────────────────

/**
 * Saves a bug report to disk as a JSON file for later processing by the agent loop.
 */
async function saveBugReport(
  bugReport: BugReport,
  outputDirectory: string,
): Promise<string> {
  const { mkdirSync, writeFileSync, existsSync } = await import('node:fs');
  const { join, resolve } = await import('node:path');

  const resolvedDirectory = resolve(outputDirectory);
  if (!existsSync(resolvedDirectory)) {
    mkdirSync(resolvedDirectory, { recursive: true });
  }

  const reportFileName = `bug-report-${bugReport.reportId}.json`;
  const reportFilePath = join(resolvedDirectory, reportFileName);

  writeFileSync(
    reportFilePath,
    JSON.stringify(bugReport, null, 2),
    'utf-8',
  );

  return reportFilePath;
}
