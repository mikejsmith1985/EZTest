/**
 * Interaction Tracker — browser-side script injected during recording sessions
 * to capture every user click and input before they happen.
 *
 * This script bridges the gap between the user's actions in the browser and the
 * Node.js recording engine. It uses Playwright's exposeFunction mechanism:
 * the browser-side script calls `window.__eztest_record(data)` and Playwright
 * routes that call back into Node.js where it's appended to the session history.
 *
 * Design decisions:
 * - Fire-and-forget (no await) to avoid blocking the host app's UI event loop
 * - DOM snapshot is taken BEFORE the action so we get the pre-interaction state
 * - Filters out EZTest's own overlay UI so annotation actions aren't recorded
 * - Uses `change` (not `input`) for text fields to capture the final value, not keystrokes
 */

// ── Types ──────────────────────────────────────────────────────────────────

/**
 * The data structure sent from the browser to the Node.js recording engine
 * for each captured interaction. Must be JSON-serializable.
 */
export interface BrowserInteractionData {
  kind: 'click' | 'input';
  selector: string;
  description: string;
  /** Only populated for input/change events */
  value?: string;
  /** Serialized DOM state at the moment BEFORE the interaction */
  domBefore: string;
}

// ── Script Builder ─────────────────────────────────────────────────────────

/**
 * Returns the browser-side JavaScript string for tracking user interactions.
 *
 * The returned string is injected via `browserContext.addInitScript()` so it
 * runs at document creation time (before any app code) on every page navigation.
 *
 * The script calls `window.__eztest_record(data)`, which must be registered
 * with `page.exposeFunction('__eztest_record', handler)` BEFORE navigating.
 */
export function buildInteractionTrackingScript(): string {
  // Written as a plain string (not TypeScript) because this runs in the browser context
  return `
(function () {
  'use strict';

  // Guard: avoid double-injection on same-page navigations
  if (window.__eztest_tracking_active) return;
  window.__eztest_tracking_active = true;

  // ── Selector Generation ──────────────────────────────────────────────────

  /**
   * Generates the best available CSS/attribute selector for a DOM element.
   * Priority: data-testid > aria-label > id > role+text > tag+text > tag
   * This mirrors the Node.js generateBestSelectorFromElementInfo function.
   */
  function getElementSelector(element) {
    if (!element || element.nodeType !== 1) return 'unknown';

    var testId = element.getAttribute('data-testid') || element.getAttribute('data-cy');
    if (testId) return '[data-testid="' + testId + '"]';

    var ariaLabel = element.getAttribute('aria-label');
    if (ariaLabel) return '[aria-label="' + ariaLabel.slice(0, 80) + '"]';

    var elementId = element.id;
    // Exclude EZTest's own IDs from selector generation
    if (elementId && !elementId.startsWith('eztest-')) return '#' + elementId;

    var tag = element.tagName.toLowerCase();
    var text = (element.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 40);

    if (text && ['button', 'a'].includes(tag)) return tag + ':has-text("' + text + '")';

    var name = element.getAttribute('name');
    if (name) return '[name="' + name + '"]';

    var placeholder = element.getAttribute('placeholder');
    if (placeholder) return '[placeholder="' + placeholder.slice(0, 40) + '"]';

    var type = element.getAttribute('type');
    if (type && tag !== 'input') return tag + '[type="' + type + '"]';
    if (type) return 'input[type="' + type + '"]';

    return tag;
  }

  /**
   * Produces a human-readable description of an element for the interaction log.
   * Readers of the bug report will see this, so it should be as meaningful as possible.
   */
  function getElementDescription(element) {
    var ariaLabel = element.getAttribute('aria-label');
    if (ariaLabel) return ariaLabel;

    var text = (element.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 100);
    if (text) return text;

    var placeholder = element.getAttribute('placeholder');
    if (placeholder) return placeholder;

    var name = element.getAttribute('name');
    if (name) return name;

    return element.tagName.toLowerCase();
  }

  /**
   * Returns true if the element is part of EZTest's own overlay UI.
   * We must not record clicks on the Flag button or modal as application interactions.
   */
  function isEZTestOverlayElement(element) {
    if (!element) return false;
    var current = element;
    // Walk up the DOM tree — if any ancestor has an EZTest ID, this is overlay UI
    while (current && current.tagName && current.tagName !== 'BODY') {
      var id = current.id || '';
      if (id.startsWith('eztest-')) return true;
      current = current.parentElement;
    }
    return false;
  }

  /**
   * Captures a lightweight DOM snapshot of the current page body.
   * Strips script/style/svg tags to reduce size. Truncated to 8KB.
   */
  function captureDomSnapshot() {
    try {
      var body = document.body;
      if (!body) return '';
      var clone = body.cloneNode(true);
      var noisy = clone.querySelectorAll('script, style, svg');
      for (var ni = 0; ni < noisy.length; ni++) noisy[ni].remove();
      return clone.innerHTML.slice(0, 8000);
    } catch (err) {
      return '[DOM snapshot unavailable]';
    }
  }

  // ── Interaction Listeners ────────────────────────────────────────────────

  /**
   * Sends interaction data to the Node.js recording engine via the exposeFunction bridge.
   * Fire-and-forget — we never await this to avoid blocking UI event handling.
   */
  function reportInteraction(data) {
    if (typeof window.__eztest_record === 'function') {
      window.__eztest_record(data).catch(function () {
        // Silently ignore bridge errors — recording is best-effort
      });
    }
  }

  // ── Click Listener ──
  // Runs in the capture phase so it fires before any app click handlers
  document.addEventListener('click', function (event) {
    var target = event.target;
    if (!target || isEZTestOverlayElement(target)) return;

    // Only record interactions on elements the user consciously targets
    var tag = target.tagName ? target.tagName.toLowerCase() : '';
    var role = target.getAttribute('role') || '';
    var hasClickHandler = target.onclick !== null || target.getAttribute('data-testid');
    var tabIndex = target.getAttribute('tabindex');
    var isKnownInteractive = ['button', 'a', 'input', 'select', 'textarea', 'label'].includes(tag);
    var isRoleInteractive = ['button', 'link', 'menuitem', 'tab', 'checkbox', 'radio'].includes(role);

    if (!isKnownInteractive && !isRoleInteractive && !hasClickHandler && tabIndex === null) return;

    reportInteraction({
      kind: 'click',
      selector: getElementSelector(target),
      description: getElementDescription(target),
      domBefore: captureDomSnapshot(),
    });
  }, true);

  // ── Change Listener (for inputs, selects, textareas) ──
  // 'change' fires when the user commits a value (on blur or selection), not on every keystroke
  document.addEventListener('change', function (event) {
    var target = event.target;
    if (!target || isEZTestOverlayElement(target)) return;

    var tag = target.tagName ? target.tagName.toLowerCase() : '';
    if (!['input', 'select', 'textarea'].includes(tag)) return;

    // Skip hidden/submit/button inputs — they don't represent user-entered values
    var type = (target.getAttribute('type') || '').toLowerCase();
    if (['hidden', 'submit', 'button', 'reset'].includes(type)) return;

    reportInteraction({
      kind: 'input',
      selector: getElementSelector(target),
      description: getElementDescription(target),
      value: target.value || '',
      domBefore: captureDomSnapshot(),
    });
  }, true);

})();
`.trim();
}
