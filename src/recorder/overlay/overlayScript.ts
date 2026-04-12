/**
 * Annotation Overlay — injected into the target application during recording sessions.
 *
 * This is a self-contained vanilla JavaScript + CSS module that gets injected into
 * the target application's browser context by Playwright. It adds a floating "Flag"
 * button and an annotation modal to the page.
 *
 * IMPORTANT: This code runs in the BROWSER, not in Node.js. It must be:
 * - Pure vanilla JS/CSS (no framework dependencies)
 * - Self-contained (no imports, no require)
 * - Compatible with any host application without conflicts
 *
 * When the user clicks "Flag Unexpected Result", they describe what they expected
 * and the data is sent to the local annotation server for processing.
 */

/**
 * Returns the overlay JavaScript source code as a string.
 * Playwright injects this into the page with page.addInitScript().
 *
 * The annotationServerUrl parameter is templated in before injection
 * so the overlay knows where to send bug flags.
 */
export function buildOverlayScript(annotationServerUrl: string): string {
  // The overlay script is a template — we substitute the server URL before injection
  return `
(function initializeEZTestOverlay() {
  // Prevent double-injection if the script somehow runs twice
  if (window.__ezTestOverlayActive) return;
  window.__ezTestOverlayActive = true;

  const ANNOTATION_SERVER_URL = '${annotationServerUrl}';

  // ── CSS Injection ──────────────────────────────────────────────────────

  const overlayStyles = \`
    #eztest-flag-button {
      position: fixed;
      bottom: 24px;
      right: 24px;
      z-index: 2147483647;
      background: #ef4444;
      color: white;
      border: none;
      border-radius: 50px;
      padding: 12px 20px;
      font-size: 14px;
      font-weight: 600;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      cursor: pointer;
      box-shadow: 0 4px 14px rgba(239, 68, 68, 0.5);
      display: flex;
      align-items: center;
      gap: 8px;
      transition: transform 0.1s, box-shadow 0.1s;
      user-select: none;
    }
    #eztest-flag-button:hover {
      transform: scale(1.05);
      box-shadow: 0 6px 20px rgba(239, 68, 68, 0.6);
    }
    #eztest-flag-button:active {
      transform: scale(0.98);
    }
    #eztest-recording-indicator {
      position: fixed;
      top: 12px;
      right: 12px;
      z-index: 2147483647;
      background: rgba(0,0,0,0.75);
      color: white;
      border-radius: 20px;
      padding: 6px 12px;
      font-size: 12px;
      font-weight: 500;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      display: flex;
      align-items: center;
      gap: 6px;
      pointer-events: none;
    }
    #eztest-recording-indicator .pulse-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #ef4444;
      animation: eztest-pulse 1.5s ease-in-out infinite;
    }
    @keyframes eztest-pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.3; }
    }
    #eztest-modal-backdrop {
      position: fixed;
      inset: 0;
      z-index: 2147483646;
      background: rgba(0, 0, 0, 0.5);
      display: flex;
      align-items: center;
      justify-content: center;
      backdrop-filter: blur(2px);
    }
    #eztest-modal {
      background: white;
      border-radius: 12px;
      padding: 28px;
      width: 480px;
      max-width: 90vw;
      box-shadow: 0 20px 60px rgba(0,0,0,0.3);
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    }
    #eztest-modal h2 {
      margin: 0 0 8px;
      font-size: 18px;
      font-weight: 700;
      color: #111;
    }
    #eztest-modal p.subtitle {
      margin: 0 0 20px;
      font-size: 14px;
      color: #666;
    }
    #eztest-modal label {
      display: block;
      font-size: 13px;
      font-weight: 600;
      color: #333;
      margin-bottom: 8px;
    }
    #eztest-expectation-input {
      width: 100%;
      min-height: 100px;
      border: 2px solid #e5e7eb;
      border-radius: 8px;
      padding: 12px;
      font-size: 14px;
      font-family: inherit;
      resize: vertical;
      box-sizing: border-box;
      outline: none;
      transition: border-color 0.15s;
    }
    #eztest-expectation-input:focus {
      border-color: #6366f1;
    }
    .eztest-modal-buttons {
      display: flex;
      gap: 12px;
      margin-top: 20px;
      justify-content: flex-end;
    }
    .eztest-btn-cancel {
      background: #f3f4f6;
      color: #374151;
      border: none;
      border-radius: 8px;
      padding: 10px 20px;
      font-size: 14px;
      font-weight: 500;
      cursor: pointer;
      font-family: inherit;
    }
    .eztest-btn-cancel:hover { background: #e5e7eb; }
    .eztest-btn-submit {
      background: #6366f1;
      color: white;
      border: none;
      border-radius: 8px;
      padding: 10px 20px;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      font-family: inherit;
    }
    .eztest-btn-submit:hover { background: #4f46e5; }
    .eztest-btn-submit:disabled { background: #a5b4fc; cursor: not-allowed; }
    #eztest-submit-status {
      font-size: 13px;
      margin-top: 12px;
      text-align: center;
      min-height: 20px;
    }
  \`;

  const styleElement = document.createElement('style');
  styleElement.textContent = overlayStyles;
  document.head.appendChild(styleElement);

  // ── Recording Indicator ────────────────────────────────────────────────

  const recordingIndicator = document.createElement('div');
  recordingIndicator.id = 'eztest-recording-indicator';
  recordingIndicator.innerHTML = '<div class="pulse-dot"></div><span>EZTest Recording</span>';
  document.body.appendChild(recordingIndicator);

  // ── Flag Button ────────────────────────────────────────────────────────

  const flagButton = document.createElement('button');
  flagButton.id = 'eztest-flag-button';
  flagButton.innerHTML = '🚩 Flag Unexpected Result';
  document.body.appendChild(flagButton);

  // ── Annotation Modal ───────────────────────────────────────────────────

  function showAnnotationModal() {
    const backdrop = document.createElement('div');
    backdrop.id = 'eztest-modal-backdrop';

    const modal = document.createElement('div');
    modal.id = 'eztest-modal';
    modal.innerHTML = \`
      <h2>🚩 Flag Unexpected Result</h2>
      <p class="subtitle">Describe what you expected to happen — this will be used to generate a test that catches this bug.</p>
      <label for="eztest-expectation-input">What did you expect?</label>
      <textarea 
        id="eztest-expectation-input" 
        placeholder="e.g., The total should update when I remove an item from the cart. The modal should close after clicking Submit. The error message should disappear after fixing the input."
        autofocus
      ></textarea>
      <div class="eztest-modal-buttons">
        <button class="eztest-btn-cancel" id="eztest-cancel-btn">Cancel</button>
        <button class="eztest-btn-submit" id="eztest-submit-btn">Submit Bug Flag</button>
      </div>
      <div id="eztest-submit-status"></div>
    \`;

    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);

    const textarea = document.getElementById('eztest-expectation-input');
    const submitButton = document.getElementById('eztest-submit-btn');
    const cancelButton = document.getElementById('eztest-cancel-btn');
    const statusDiv = document.getElementById('eztest-submit-status');

    if (textarea) textarea.focus();

    function closeModal() {
      backdrop.remove();
    }

    cancelButton.addEventListener('click', closeModal);
    backdrop.addEventListener('click', function(event) {
      if (event.target === backdrop) closeModal();
    });

    submitButton.addEventListener('click', async function() {
      const userExpectation = textarea.value.trim();
      if (!userExpectation) {
        statusDiv.textContent = 'Please describe what you expected to happen.';
        statusDiv.style.color = '#ef4444';
        return;
      }

      submitButton.disabled = true;
      submitButton.textContent = 'Sending...';
      statusDiv.textContent = '';

      try {
        const response = await fetch(ANNOTATION_SERVER_URL + '/api/flag', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            userExpectation: userExpectation,
            pageUrl: window.location.href,
            flaggedAt: new Date().toISOString(),
          }),
        });

        if (response.ok) {
          statusDiv.textContent = '✓ Bug flagged! EZTest will generate a test to catch this.';
          statusDiv.style.color = '#16a34a';
          setTimeout(closeModal, 2000);
        } else {
          throw new Error('Server returned ' + response.status);
        }
      } catch (error) {
        statusDiv.textContent = 'Failed to send flag. Is EZTest recording session running?';
        statusDiv.style.color = '#ef4444';
        submitButton.disabled = false;
        submitButton.textContent = 'Submit Bug Flag';
      }
    });
  }

  flagButton.addEventListener('click', showAnnotationModal);

})();
  `.trim();
}
