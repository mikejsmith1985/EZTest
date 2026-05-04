/**
 * Test Failure Classifier — determines whether a Playwright test failure is
 * a bad test (fixable selector mismatch) or evidence of broken application code.
 *
 * This distinction is the philosophical heart of EZTest's integrity: we must
 * NEVER silently rewrite tests to pass. Tests that fail because the application
 * behaves incorrectly should surface as developer action items, not be patched away.
 */

// ── Types ──────────────────────────────────────────────────────────────────

/**
 * How a Playwright test failure should be interpreted before deciding whether to
 * attempt an AI-driven fix.
 *
 * - `selector-mismatch`: The test cannot find a DOM element. The AI probably
 *   generated the wrong locator. Safe to attempt regeneration with better selectors.
 *
 * - `behavioral-failure`: The element was found but the application behaved
 *   differently than expected (wrong URL, wrong text, wrong state, element
 *   disabled when it should be enabled). Do NOT auto-fix — this likely means
 *   the feature is broken. Surface it as a developer action item.
 *
 * - `uncertain`: Cannot confidently classify. Attempt a fix but flag the result
 *   so the developer can review whether the test is still meaningful.
 */
export type TestFailureCategory = 'selector-mismatch' | 'behavioral-failure' | 'uncertain';

// ── Classification ─────────────────────────────────────────────────────────

/**
 * Classifies a Playwright test failure by inspecting the error output.
 * Rule-based — no AI calls. Fast, deterministic, zero token cost.
 *
 * The classifier reads the Playwright assertion method name and the accompanying
 * "Expected/Received" text to determine whether the problem is a locator issue
 * (fixable by the AI) or a behavioral discrepancy (a real application bug).
 */
export function classifyTestFailure(playwrightErrorOutput: string): TestFailureCategory {
  // ── Behavioral failures (application did something wrong) ─────────────────
  // These are assertions that can only fail if the element WAS found but
  // the application produced the wrong outcome. Do not attempt to auto-fix.

  // Navigation assertion — app didn't route to the expected URL
  if (
    /toHaveURL/i.test(playwrightErrorOutput) ||
    /Expected pattern:/i.test(playwrightErrorOutput) ||
    /Expected string:.*http/i.test(playwrightErrorOutput)
  ) {
    return 'behavioral-failure';
  }

  // Content assertion — app rendered wrong text (element must have existed)
  if (
    /toHaveText|toContainText/i.test(playwrightErrorOutput) &&
    !/element\(s\) not found/i.test(playwrightErrorOutput)
  ) {
    return 'behavioral-failure';
  }

  // State assertion — element exists but is in the wrong interactive state
  if (
    /toBeEnabled|toBeDisabled/i.test(playwrightErrorOutput) &&
    !/element\(s\) not found/i.test(playwrightErrorOutput)
  ) {
    return 'behavioral-failure';
  }

  // Value/check assertion — element exists but holds the wrong value
  if (
    /toHaveValue|toBeChecked/i.test(playwrightErrorOutput) &&
    !/element\(s\) not found/i.test(playwrightErrorOutput)
  ) {
    return 'behavioral-failure';
  }

  // ── Selector mismatches (test used the wrong locator) ─────────────────────
  // The element simply could not be found. The AI probably guessed wrong.
  // Regenerating with a more flexible locator has a good chance of fixing this.

  if (/element\(s\) not found/i.test(playwrightErrorOutput)) {
    return 'selector-mismatch';
  }

  // Timeout while waiting for a locator to match — element never appeared in DOM
  if (
    /TimeoutError/i.test(playwrightErrorOutput) &&
    /waiting for/i.test(playwrightErrorOutput)
  ) {
    return 'selector-mismatch';
  }

  // ── Uncertain ─────────────────────────────────────────────────────────────
  // Doesn't fit either category cleanly. Attempt a fix but note the ambiguity.
  return 'uncertain';
}

/**
 * Returns a short, developer-readable explanation of why a behavioral failure
 * should be treated as a potential application bug rather than a test defect.
 *
 * Used in log output and summary reports so developers understand the distinction.
 */
export function describeBehavioralFailure(playwrightErrorOutput: string): string {
  if (/toHaveURL|Expected pattern:|Expected string:.*http/i.test(playwrightErrorOutput)) {
    return 'expected navigation did not occur — the app may not be routing correctly';
  }
  if (/toHaveText|toContainText/i.test(playwrightErrorOutput)) {
    return 'the app showed unexpected content — the feature may have a logic error';
  }
  if (/toBeEnabled/i.test(playwrightErrorOutput)) {
    return 'an expected interactive element is disabled — check the feature\'s state management';
  }
  if (/toHaveValue/i.test(playwrightErrorOutput)) {
    return 'a form field holds an unexpected value — the feature may not be initializing state correctly';
  }
  return 'the application behaved differently than the test expected';
}
