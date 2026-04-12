/**
 * App Page — builds the complete HTML string for the EZTest browser UI.
 * This is the full application: an app-bar, project dashboard with action cards,
 * a first-launch onboarding overlay, and a run-output modal — all self-contained
 * in a single HTML document so no external assets are needed.
 *
 * IMPORTANT: The embedded <script> block must NOT use JS template literals
 * (backticks / ${...}) because this entire string is a TypeScript template literal.
 * All dynamic JS values must use string concatenation instead.
 */

// ── Color palette ────────────────────────────────────────────────────────────

const COLOR_BG       = '#0d1117';
const COLOR_CARD     = '#161b22';
const COLOR_BORDER   = '#30363d';
const COLOR_ACCENT   = '#7c3aed';
const COLOR_SUCCESS  = '#3fb950';
const COLOR_ERROR    = '#f85149';
const COLOR_WARNING  = '#e3b341';
const COLOR_PRIMARY  = '#e6edf3';
const COLOR_MUTED    = '#8b949e';

/**
 * Returns the full HTML document for the EZTest application as a string.
 * The page is entirely self-contained — all CSS and JavaScript are inlined.
 */
export function buildWizardPageHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>EZTest</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      background: ${COLOR_BG};
      color: ${COLOR_PRIMARY};
      font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      min-height: 100vh;
    }

    /* ── App bar ── */
    .app-bar {
      height: 56px;
      background: ${COLOR_CARD};
      border-bottom: 1px solid ${COLOR_BORDER};
      display: flex;
      align-items: center;
      padding: 0 24px;
      gap: 12px;
      position: sticky;
      top: 0;
      z-index: 10;
    }
    .app-bar-brand {
      font-size: 1.1rem;
      font-weight: 800;
      letter-spacing: -0.3px;
      color: ${COLOR_PRIMARY};
    }
    .app-bar-brand span { color: ${COLOR_ACCENT}; }
    .app-bar-spacer { flex: 1; }
    .project-pill {
      display: flex;
      align-items: center;
      background: ${COLOR_BG};
      border: 1px solid ${COLOR_BORDER};
      border-radius: 20px;
      padding: 4px 6px 4px 14px;
      gap: 8px;
      font-size: 0.83rem;
      max-width: 380px;
      overflow: hidden;
    }
    .project-pill-name {
      color: ${COLOR_PRIMARY};
      font-weight: 500;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .project-pill-name.muted { color: ${COLOR_MUTED}; }
    .pill-btn {
      background: #21262d;
      border: 1px solid ${COLOR_BORDER};
      color: ${COLOR_MUTED};
      border-radius: 12px;
      padding: 3px 10px;
      font-size: 0.75rem;
      cursor: pointer;
      white-space: nowrap;
      flex-shrink: 0;
    }
    .pill-btn:hover { background: #30363d; color: ${COLOR_PRIMARY}; }

    /* ── Dashboard ── */
    .dashboard {
      max-width: 980px;
      margin: 0 auto;
      padding: 36px 24px 80px;
    }

    /* Project summary bar */
    .project-summary-bar {
      background: ${COLOR_CARD};
      border: 1px solid ${COLOR_BORDER};
      border-radius: 10px;
      padding: 16px 24px;
      display: flex;
      gap: 32px;
      margin-bottom: 36px;
      flex-wrap: wrap;
      align-items: center;
    }
    .summary-stat { display: flex; flex-direction: column; gap: 2px; }
    .summary-stat-label {
      font-size: 0.7rem;
      color: ${COLOR_MUTED};
      text-transform: uppercase;
      letter-spacing: 0.6px;
    }
    .summary-stat-value { font-size: 1rem; font-weight: 700; color: ${COLOR_PRIMARY}; }
    .summary-divider {
      width: 1px;
      height: 32px;
      background: ${COLOR_BORDER};
    }

    /* Section heading */
    .section-heading {
      font-size: 1.35rem;
      font-weight: 700;
      margin-bottom: 6px;
    }
    .section-subheading {
      font-size: 0.9rem;
      color: ${COLOR_MUTED};
      margin-bottom: 28px;
      line-height: 1.5;
    }

    /* ── Action cards ── */
    .action-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
      gap: 16px;
    }
    @media (max-width: 620px) { .action-grid { grid-template-columns: 1fr; } }

    .action-card {
      background: ${COLOR_CARD};
      border: 1px solid ${COLOR_BORDER};
      border-radius: 12px;
      padding: 24px;
      display: flex;
      flex-direction: column;
      gap: 10px;
      transition: border-color 0.2s, box-shadow 0.2s;
      cursor: default;
    }
    .action-card:hover { border-color: ${COLOR_ACCENT}; box-shadow: 0 0 0 1px ${COLOR_ACCENT}22; }

    .action-icon { font-size: 2.2rem; line-height: 1; }
    .action-title { font-size: 1.05rem; font-weight: 700; color: ${COLOR_PRIMARY}; margin-top: 2px; }
    .action-description {
      font-size: 0.875rem;
      color: ${COLOR_MUTED};
      line-height: 1.6;
      flex: 1;
    }
    .action-best-for {
      font-size: 0.78rem;
      color: ${COLOR_ACCENT};
      line-height: 1.4;
      padding: 8px 12px;
      background: ${COLOR_ACCENT}11;
      border-radius: 6px;
      border-left: 2px solid ${COLOR_ACCENT};
    }
    .action-best-for strong { font-weight: 700; }
    .action-btn {
      margin-top: 6px;
      background: ${COLOR_ACCENT};
      color: #fff;
      border: none;
      border-radius: 8px;
      padding: 11px 16px;
      font-size: 0.9rem;
      font-weight: 600;
      cursor: pointer;
      width: 100%;
      transition: background 0.2s;
    }
    .action-btn:hover { background: #6d28d9; }
    .action-btn:disabled { background: ${COLOR_BORDER}; color: ${COLOR_MUTED}; cursor: not-allowed; }
    .action-secondary-link {
      text-align: center;
      font-size: 0.78rem;
      color: ${COLOR_MUTED};
      cursor: pointer;
      text-decoration: underline;
    }
    .action-secondary-link:hover { color: ${COLOR_PRIMARY}; }

    /* ── Onboarding overlay ── */
    .onboarding-overlay {
      position: fixed;
      inset: 0;
      background: rgba(13, 17, 23, 0.96);
      z-index: 100;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
    }
    .onboarding-card {
      background: ${COLOR_CARD};
      border: 1px solid ${COLOR_BORDER};
      border-radius: 16px;
      padding: 40px;
      max-width: 520px;
      width: 100%;
      text-align: center;
    }
    .ob-step-number {
      font-size: 0.72rem;
      color: ${COLOR_MUTED};
      text-transform: uppercase;
      letter-spacing: 1px;
      margin-bottom: 20px;
    }
    .ob-icon { font-size: 3rem; margin-bottom: 16px; line-height: 1; }
    .ob-heading {
      font-size: 1.4rem;
      font-weight: 800;
      margin-bottom: 10px;
    }
    .ob-body {
      color: ${COLOR_MUTED};
      font-size: 0.9rem;
      line-height: 1.65;
      margin-bottom: 24px;
    }

    /* Detected project card */
    .detected-project-card {
      background: ${COLOR_BG};
      border: 1px solid ${COLOR_SUCCESS};
      border-radius: 10px;
      padding: 16px 18px;
      text-align: left;
      margin-bottom: 20px;
    }
    .detected-project-name {
      font-weight: 700;
      color: ${COLOR_SUCCESS};
      margin-bottom: 8px;
      font-size: 0.95rem;
    }
    .detected-project-stats {
      display: flex;
      gap: 16px;
      flex-wrap: wrap;
    }
    .detected-stat { font-size: 0.83rem; color: ${COLOR_MUTED}; }
    .detected-stat strong { color: ${COLOR_PRIMARY}; font-weight: 600; }

    /* AI provider card in onboarding */
    .ai-status-card {
      background: ${COLOR_BG};
      border: 1px solid ${COLOR_BORDER};
      border-radius: 10px;
      padding: 16px 18px;
      text-align: left;
      margin-bottom: 20px;
      display: flex;
      align-items: center;
      gap: 14px;
    }
    .ai-status-card.is-ready { border-color: ${COLOR_SUCCESS}; }
    .ai-status-icon { font-size: 1.8rem; }
    .ai-status-label { font-weight: 700; font-size: 0.95rem; margin-bottom: 2px; }
    .ai-status-sublabel { font-size: 0.82rem; color: ${COLOR_MUTED}; }

    /* Manual provider form (shown when no key found) */
    .provider-form { text-align: left; margin-bottom: 20px; }
    .provider-form label {
      display: block;
      font-size: 0.8rem;
      color: ${COLOR_MUTED};
      margin-bottom: 5px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.4px;
    }
    .provider-form select,
    .provider-form input {
      width: 100%;
      background: ${COLOR_BG};
      border: 1px solid ${COLOR_BORDER};
      border-radius: 7px;
      color: ${COLOR_PRIMARY};
      padding: 9px 12px;
      font-size: 0.9rem;
      outline: none;
      margin-bottom: 12px;
    }
    .provider-form select:focus,
    .provider-form input:focus { border-color: ${COLOR_ACCENT}; }

    /* ── Shared buttons ── */
    .btn-primary {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      background: ${COLOR_ACCENT};
      color: #fff;
      border: none;
      border-radius: 8px;
      padding: 12px 24px;
      font-size: 0.95rem;
      font-weight: 600;
      cursor: pointer;
      transition: background 0.2s;
      width: 100%;
    }
    .btn-primary:hover:not(:disabled) { background: #6d28d9; }
    .btn-primary:disabled { background: ${COLOR_BORDER}; color: ${COLOR_MUTED}; cursor: not-allowed; }
    .btn-ghost {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      background: transparent;
      color: ${COLOR_MUTED};
      border: 1px solid ${COLOR_BORDER};
      border-radius: 8px;
      padding: 10px 20px;
      font-size: 0.88rem;
      cursor: pointer;
      transition: background 0.15s;
    }
    .btn-ghost:hover { background: #21262d; color: ${COLOR_PRIMARY}; }
    .btn-large { padding: 15px 28px; font-size: 1rem; }
    .btn-row { display: flex; gap: 10px; margin-top: 8px; }

    /* ── Action config overlay (URL / report input before running) ── */
    .config-overlay {
      position: fixed;
      inset: 0;
      background: rgba(13, 17, 23, 0.88);
      z-index: 50;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
    }
    .config-card {
      background: ${COLOR_CARD};
      border: 1px solid ${COLOR_BORDER};
      border-radius: 14px;
      padding: 32px;
      max-width: 460px;
      width: 100%;
    }
    .config-card-title { font-size: 1.1rem; font-weight: 700; margin-bottom: 6px; }
    .config-card-desc { font-size: 0.87rem; color: ${COLOR_MUTED}; line-height: 1.55; margin-bottom: 22px; }
    .config-input-row { display: flex; flex-direction: column; gap: 6px; margin-bottom: 14px; }
    .config-input-row label { font-size: 0.8rem; color: ${COLOR_MUTED}; font-weight: 600; text-transform: uppercase; letter-spacing: 0.4px; }
    .config-input-wrap { display: flex; gap: 8px; }
    .config-input {
      flex: 1;
      background: ${COLOR_BG};
      border: 1px solid ${COLOR_BORDER};
      border-radius: 7px;
      color: ${COLOR_PRIMARY};
      padding: 9px 12px;
      font-size: 0.9rem;
      outline: none;
    }
    .config-input:focus { border-color: ${COLOR_ACCENT}; }
    .config-browse-btn {
      background: #21262d;
      border: 1px solid ${COLOR_BORDER};
      color: ${COLOR_MUTED};
      border-radius: 7px;
      padding: 9px 14px;
      font-size: 0.85rem;
      cursor: pointer;
      white-space: nowrap;
    }
    .config-browse-btn:hover { background: #30363d; color: ${COLOR_PRIMARY}; }
    .config-btn-row { display: flex; gap: 10px; margin-top: 20px; }
    .config-btn-row .btn-primary { flex: 1; }
    .config-btn-row .btn-ghost { width: auto; }

    /* ── Run output modal ── */
    .run-modal {
      position: fixed;
      inset: 0;
      background: rgba(13, 17, 23, 0.92);
      z-index: 200;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
    }
    .run-modal-inner {
      background: ${COLOR_CARD};
      border: 1px solid ${COLOR_BORDER};
      border-radius: 14px;
      width: 100%;
      max-width: 780px;
      display: flex;
      flex-direction: column;
      max-height: 82vh;
    }
    .run-modal-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 16px 20px;
      border-bottom: 1px solid ${COLOR_BORDER};
      flex-shrink: 0;
    }
    .run-modal-title { font-weight: 700; font-size: 0.92rem; }
    .run-modal-cancel-btn {
      background: transparent;
      border: 1px solid ${COLOR_BORDER};
      color: ${COLOR_MUTED};
      border-radius: 6px;
      padding: 4px 12px;
      font-size: 0.82rem;
      cursor: pointer;
    }
    .run-modal-cancel-btn:hover { border-color: ${COLOR_ERROR}; color: ${COLOR_ERROR}; }
    /* ── Progress bar (shown between header and terminal during active runs) ── */
    .run-progress-section {
      padding: 12px 20px 10px;
      border-bottom: 1px solid ${COLOR_BORDER};
      flex-shrink: 0;
    }
    .run-progress-bar-track {
      height: 4px;
      background: ${COLOR_BORDER};
      border-radius: 3px;
      overflow: hidden;
      margin-bottom: 8px;
    }
    .run-progress-bar-fill {
      height: 100%;
      background: ${COLOR_ACCENT};
      border-radius: 3px;
      width: 0%;
      transition: width 0.5s ease;
    }
    .run-progress-bar-fill.is-done { background: ${COLOR_SUCCESS}; }
    .run-progress-label {
      font-size: 0.75rem;
      color: ${COLOR_MUTED};
      letter-spacing: 0.01em;
    }
    .run-terminal {
      flex: 1;
      overflow-y: auto;
      padding: 16px 20px;
      font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', monospace;
      font-size: 0.8rem;
      line-height: 1.65;
      min-height: 320px;
      background: #010409;
    }
    .log-info    { color: ${COLOR_PRIMARY}; }
    .log-success { color: ${COLOR_SUCCESS}; }
    .log-error   { color: ${COLOR_ERROR};   }
    .log-warning { color: ${COLOR_WARNING}; }
    .log-debug   { color: ${COLOR_MUTED};   }
    .run-done-bar {
      padding: 14px 20px;
      border-top: 1px solid ${COLOR_BORDER};
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-shrink: 0;
    }
    .run-done-bar .btn-ghost { width: auto; }
    .run-result-success { color: ${COLOR_SUCCESS}; font-weight: 600; font-size: 0.9rem; }
    .run-result-failure { color: ${COLOR_ERROR};   font-weight: 600; font-size: 0.9rem; }
    .run-result-warning { color: ${COLOR_WARNING}; font-weight: 600; font-size: 0.9rem; }
    /* Action buttons shown in the done bar after a run completes */
    .run-action-btn {
      background: ${COLOR_ACCENT};
      color: #fff;
      border: none;
      border-radius: 6px;
      padding: 6px 14px;
      font-size: 0.82rem;
      font-weight: 600;
      cursor: pointer;
      white-space: nowrap;
    }
    .run-action-btn:hover { opacity: 0.88; }
    .run-action-btn.is-secondary {
      background: transparent;
      border: 1px solid ${COLOR_BORDER};
      color: ${COLOR_MUTED};
    }
    .run-action-btn.is-secondary:hover { border-color: ${COLOR_ACCENT}; color: ${COLOR_ACCENT}; }
    .run-done-actions { display: flex; gap: 8px; align-items: center; }
    .spinner {
      width: 18px; height: 18px;
      border: 2px solid ${COLOR_BORDER};
      border-top-color: ${COLOR_ACCENT};
      border-radius: 50%;
      animation: spin 0.7s linear infinite;
      display: inline-block;
      margin-right: 8px;
      vertical-align: middle;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
  </style>
</head>
<body>

  <!-- ─────────────────────────────────────────────────────────────────────
       ONBOARDING OVERLAY
       Shown automatically on first launch (no project configured yet).
       Also shown when user clicks "Change Project".
       ───────────────────────────────────────────────────────────────────── -->
  <div id="onboarding" class="onboarding-overlay" style="display:none">
    <div class="onboarding-card">

      <!-- Step 1: Pick your project folder -->
      <div id="ob-step-folder">
        <div class="ob-step-number">Step 1 of 2</div>
        <div class="ob-icon">📁</div>
        <div class="ob-heading">Where is your project?</div>
        <p class="ob-body">
          EZTest reads your source code to understand what your app does,
          then writes tests based on what users actually see and do.
          Just point it at your project folder — it figures out the rest.
        </p>
        <button class="btn-primary btn-large" id="browse-folder-btn">Browse for project folder</button>
        <div id="detected-project-card" style="display:none; margin-top:20px"></div>
        <div id="ob-step-folder-next" style="display:none; margin-top:12px">
          <button class="btn-primary" id="goto-provider-btn">Looks good — Next &#8594;</button>
        </div>
      </div>

      <!-- Step 2: AI Provider -->
      <div id="ob-step-provider" style="display:none">
        <div class="ob-step-number">Step 2 of 2</div>
        <div class="ob-icon">&#x1F916;</div>
        <div class="ob-heading">AI Provider</div>
        <p class="ob-body">
          EZTest uses AI to read your code and write tests.
          Connect it to your AI provider below.
        </p>
        <div id="ai-auto-status"></div>
        <div id="ai-manual-form" style="display:none" class="provider-form">
          <label>Provider</label>
          <select id="ob-provider-select">
            <option value="github">GitHub Copilot (uses your Copilot subscription)</option>
            <option value="openai">OpenAI (GPT-4o)</option>
            <option value="anthropic">Anthropic (Claude)</option>
          </select>
          <label>API Key</label>
          <input type="password" id="ob-api-key" placeholder="Paste your key here" autocomplete="off" />
        </div>
        <div class="btn-row">
          <button class="btn-ghost" id="ob-back-btn">&#8592; Back</button>
          <button class="btn-primary" id="ob-finish-btn">Start Using EZTest &#8594;</button>
        </div>
      </div>

    </div>
  </div>


  <!-- ─────────────────────────────────────────────────────────────────────
       MAIN APP
       Hidden until onboarding is done. The real application lives here.
       ───────────────────────────────────────────────────────────────────── -->
  <div id="app" style="display:none">

    <!-- App bar -->
    <div class="app-bar">
      <div class="app-bar-brand">&#x26A1; EZ<span>Test</span></div>
      <div class="app-bar-spacer"></div>
      <div class="project-pill">
        <span class="project-pill-name muted" id="project-pill-name">No project selected</span>
        <button class="pill-btn" id="change-project-btn">Change</button>
      </div>
    </div>

    <!-- Dashboard -->
    <div class="dashboard">

      <!-- Project summary (hidden until project loaded) -->
      <div id="project-summary-bar" class="project-summary-bar" style="display:none"></div>

      <div class="section-heading">What would you like to do?</div>
      <p class="section-subheading">
        Pick an action below. EZTest handles the rest — no config files, no command line.
      </p>

      <div class="action-grid">

        <!-- Card 1: Generate Tests -->
        <div class="action-card">
          <div class="action-icon">&#x1F9EA;</div>
          <div class="action-title">Write Tests For My App</div>
          <div class="action-description">
            AI reads your source code, maps out how users interact with your app,
            and writes Playwright tests that check what users actually <em>see</em>
            and <em>experience</em> — not just that internal functions get called.
          </div>
          <div class="action-best-for">
            <strong>Best for:</strong> Getting meaningful test coverage fast on a new or existing project.
          </div>
          <button class="action-btn" id="btn-generate">Generate Tests &#8594;</button>
          <div class="action-secondary-link" id="btn-preview-plan">Preview what it will test first</div>
        </div>

        <!-- Card 2: Record a Session -->
        <div class="action-card">
          <div class="action-icon">&#x1F534;</div>
          <div class="action-title">Record a Testing Session</div>
          <div class="action-description">
            Open your app in a real browser, use it the way a user would,
            and tap the flag button whenever something looks wrong.
            EZTest captures your session and turns it into repeatable test cases
            that reproduce exactly what you found.
          </div>
          <div class="action-best-for">
            <strong>Best for:</strong> Capturing real user workflows and bugs you discover by hand.
          </div>
          <button class="action-btn" id="btn-record">Start Recording &#8594;</button>
        </div>

        <!-- Card 3: Fix a Failing Test -->
        <div class="action-card">
          <div class="action-icon">&#x1F527;</div>
          <div class="action-title">Fix a Failing Test</div>
          <div class="action-description">
            Got a test that's broken or flaky? Point EZTest at the failure report
            and it will identify the bug, fix the source code, write a regression
            test to make sure it never comes back, and confirm everything passes.
          </div>
          <div class="action-best-for">
            <strong>Best for:</strong> Recurring failures, regressions after refactors, or flaky tests.
          </div>
          <button class="action-btn" id="btn-fix">Fix &amp; Validate &#8594;</button>
        </div>

      </div>
    </div>
  </div>


  <!-- ─────────────────────────────────────────────────────────────────────
       ACTION CONFIG OVERLAY
       Shown when an action needs a URL or file path before it can run.
       ───────────────────────────────────────────────────────────────────── -->
  <div id="config-overlay" class="config-overlay" style="display:none">
    <div class="config-card">
      <div class="config-card-title" id="config-overlay-title"></div>
      <div class="config-card-desc"  id="config-overlay-desc"></div>
      <div id="config-overlay-fields"></div>
      <div class="config-btn-row">
        <button class="btn-ghost" id="config-cancel-btn">Cancel</button>
        <button class="btn-primary" id="config-run-btn">Run &#8594;</button>
      </div>
    </div>
  </div>


  <!-- ─────────────────────────────────────────────────────────────────────
       RUN OUTPUT MODAL
       Streams live output from the CLI process; shown during any run.
       ───────────────────────────────────────────────────────────────────── -->
  <div id="run-modal" class="run-modal" style="display:none">
    <div class="run-modal-inner">
      <div class="run-modal-header">
        <span class="run-modal-title" id="run-modal-title">
          <span class="spinner"></span>Running...
        </span>
        <button class="run-modal-cancel-btn" id="run-cancel-btn">Cancel</button>
      </div>
      <!-- Progress bar: driven by log message parsing — no separate protocol needed -->
      <div class="run-progress-section" id="run-progress-section" style="display:none">
        <div class="run-progress-bar-track">
          <div class="run-progress-bar-fill" id="run-progress-bar"></div>
        </div>
        <div class="run-progress-label" id="run-progress-label">Starting…</div>
      </div>
      <div class="run-terminal" id="run-terminal"></div>
      <div class="run-done-bar" id="run-done-bar" style="display:none">
        <span id="run-done-msg"></span>
        <div class="run-done-actions">
          <!-- Shown after a successful generate run -->
          <button class="run-action-btn" id="run-tests-btn"   style="display:none" onclick="startRunTests()">&#9654; Run Tests</button>
          <!-- Shown after a successful test run -->
          <button class="run-action-btn is-secondary" id="open-report-btn" style="display:none" onclick="openPlaywrightReport()">&#128202; Open Report</button>
          <button class="btn-ghost" onclick="closeRunModal()">Close</button>
        </div>
      </div>
    </div>
  </div>


  <script src="/socket.io/socket.io.js"></script>
  <script>
    // ── Application state ────────────────────────────────────────────────────

    var appConfig   = null;   // saved project path, appUrl
    var statusData  = null;   // node / apiKey / playwright status
    var scanResult  = null;   // scanned project info
    var isRunning   = false;
    var socket      = io();
    /** Interval handle for the rate-limit retry countdown — cleared on resume or cancel. */
    var progressRetryCountdown = null;
    /** Total test files to generate, extracted from "Generating Playwright tests for N" log line. */
    var progressTotalTests = 0;
    /** Running count of confirmed-written test files, incremented on each "Written:" log line. */
    var progressTestsWritten = 0;
    /**
     * The last successfully completed generate run config.
     * Retained so the "Run Tests" button knows which output dir and project root to use.
     */
    var lastGenerateRunConfig = null;
    /**
     * The project root used for the most recent test run.
     * Passed to /api/open-report so it can locate playwright-report/index.html.
     */
    var lastTestRunWorkingDir = null;
    /**
     * The run config for the currently active (or most recently started) run.
     * Used in run:done to decide which action buttons to show.
     */
    var currentRunConfig = null;

    // ── Bootstrap ─────────────────────────────────────────────────────────────

    /**
     * Entry point. Loads environment status and saved project config in parallel,
     * then decides whether to show onboarding (first launch) or the dashboard.
     */
    function initApp() {
      Promise.all([
        fetch('/api/app-config').then(function(r) { return r.json(); }),
        fetch('/api/status').then(function(r) { return r.json(); })
      ]).then(function(results) {
        appConfig  = results[0];
        statusData = results[1];
        if (appConfig && appConfig.isConfigured && appConfig.scanResult) {
          scanResult = appConfig.scanResult;
          showDashboard();
        } else {
          showOnboarding(1);
        }
      }).catch(function() {
        showOnboarding(1);
      });
    }

    // ── Onboarding flow ───────────────────────────────────────────────────────

    /** Shows the onboarding overlay and jumps to the given step (1 or 2). */
    function showOnboarding(stepNumber) {
      document.getElementById('app').style.display         = 'none';
      document.getElementById('onboarding').style.display  = 'flex';
      document.getElementById('ob-step-folder').style.display   = stepNumber === 1 ? 'block' : 'none';
      document.getElementById('ob-step-provider').style.display = stepNumber === 2 ? 'block' : 'none';
    }

    /**
     * Opens the native Windows folder browser dialog via the server.
     * When a folder is picked, scans it and shows the detected project card.
     */
    function browseForProjectFolder() {
      var btn = document.getElementById('browse-folder-btn');
      btn.disabled    = true;
      btn.textContent = 'Opening\u2026';

      fetch('/api/browse-folder', { method: 'POST' })
        .then(function(r) { return r.json(); })
        .then(function(result) {
          btn.disabled    = false;
          btn.textContent = 'Browse for project folder';
          if (!result.cancelled && result.path) {
            saveProjectAndScan(result.path);
          }
        })
        .catch(function() {
          btn.disabled    = false;
          btn.textContent = 'Browse for project folder';
        });
    }

    /**
     * Saves the chosen project path via the API, then renders the detected
     * project summary card in the onboarding screen.
     */
    function saveProjectAndScan(projectPath) {
      fetch('/api/app-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectPath: projectPath })
      })
        .then(function(r) { return r.json(); })
        .then(function(result) {
          if (result.scanResult) {
            scanResult = result.scanResult;
            appConfig  = Object.assign({}, appConfig, {
              projectPath:  projectPath,
              isConfigured: true,
              scanResult:   scanResult
            });
            renderDetectedProjectCard(scanResult);
            document.getElementById('ob-step-folder-next').style.display = 'block';
          }
        });
    }

    /** Fills in the "project detected" card shown after a folder is selected. */
    function renderDetectedProjectCard(scan) {
      var card = document.getElementById('detected-project-card');
      card.style.display = 'block';
      card.innerHTML =
        '<div class="detected-project-card">'
        + '<div class="detected-project-name">\u2705 ' + escapeHtml(scan.projectName) + '</div>'
        + '<div class="detected-project-stats">'
        + '<div class="detected-stat">' + escapeHtml(scan.detectedFramework) + ' &middot; ' + escapeHtml(scan.language) + '</div>'
        + '<div class="detected-stat"><strong>' + scan.componentFileCount + '</strong> source files</div>'
        + '<div class="detected-stat"><strong>' + scan.existingTestFileCount + '</strong> existing tests</div>'
        + '</div>'
        + '</div>';
    }

    /** Moves from folder step to provider step, auto-detecting key status. */
    function goToProviderStep() {
      showOnboarding(2);

      var autoStatus = document.getElementById('ai-auto-status');
      var manualForm = document.getElementById('ai-manual-form');

      if (statusData && statusData.apiKey && statusData.apiKey.ok) {
        var providerLabel = statusData.apiKey.hasGithub   ? 'GitHub Copilot'
                          : statusData.apiKey.hasOpenAi   ? 'OpenAI'
                          : 'Anthropic';
        autoStatus.innerHTML =
          '<div class="ai-status-card is-ready">'
          + '<div class="ai-status-icon">\u2705</div>'
          + '<div>'
          + '<div class="ai-status-label">' + escapeHtml(providerLabel) + ' is connected</div>'
          + '<div class="ai-status-sublabel">Your API key was found automatically \u2014 nothing to do here.</div>'
          + '</div>'
          + '</div>';
        manualForm.style.display = 'none';
      } else {
        autoStatus.innerHTML =
          '<div class="ai-status-card">'
          + '<div class="ai-status-icon">&#x1F511;</div>'
          + '<div>'
          + '<div class="ai-status-label">No API key found</div>'
          + '<div class="ai-status-sublabel">Add one below to enable AI-powered test generation.</div>'
          + '</div>'
          + '</div>';
        manualForm.style.display = 'block';
      }
    }

    /**
     * Completes onboarding: saves an API key if the user typed one,
     * then transitions to the main dashboard.
     */
    function finishOnboarding() {
      var providerSelect = document.getElementById('ob-provider-select');
      var keyInput       = document.getElementById('ob-api-key');

      if (providerSelect && keyInput && keyInput.value.trim()) {
        fetch('/api/env', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ provider: providerSelect.value, apiKey: keyInput.value.trim() })
        });
        // Update local status so the dashboard reflects the new key
        if (statusData) { statusData.apiKey = { ok: true }; }
      }

      document.getElementById('onboarding').style.display = 'none';
      showDashboard();
    }

    // ── Dashboard ─────────────────────────────────────────────────────────────

    /** Transitions to the main app dashboard and renders the project summary bar. */
    function showDashboard() {
      document.getElementById('onboarding').style.display = 'none';
      document.getElementById('app').style.display        = 'block';

      if (scanResult) {
        renderProjectSummaryBar(scanResult);
        document.getElementById('project-pill-name').textContent = escapeHtml(scanResult.projectName);
        document.getElementById('project-pill-name').className   = 'project-pill-name';
      }
    }

    /** Renders the stats bar at the top of the dashboard. */
    function renderProjectSummaryBar(scan) {
      var bar = document.getElementById('project-summary-bar');
      bar.style.display = 'flex';
      bar.innerHTML =
        '<div class="summary-stat">'
        + '<div class="summary-stat-label">Project</div>'
        + '<div class="summary-stat-value">' + escapeHtml(scan.projectName) + '</div>'
        + '</div>'
        + '<div class="summary-divider"></div>'
        + '<div class="summary-stat">'
        + '<div class="summary-stat-label">Framework</div>'
        + '<div class="summary-stat-value">' + escapeHtml(scan.detectedFramework) + ' \u00B7 ' + escapeHtml(scan.language) + '</div>'
        + '</div>'
        + '<div class="summary-divider"></div>'
        + '<div class="summary-stat">'
        + '<div class="summary-stat-label">Source Files</div>'
        + '<div class="summary-stat-value">' + scan.componentFileCount + '</div>'
        + '</div>'
        + '<div class="summary-divider"></div>'
        + '<div class="summary-stat">'
        + '<div class="summary-stat-label">Existing Tests</div>'
        + '<div class="summary-stat-value">' + (scan.existingTestFileCount === 0 ? 'None yet' : String(scan.existingTestFileCount)) + '</div>'
        + '</div>';
    }

    // ── Action card handlers ───────────────────────────────────────────────────

    /**
     * Runs the AI test generation workflow immediately using the
     * scanned source directory as input — no additional config needed.
     */
    function handleGenerateTests() {
      if (!appConfig || !appConfig.projectPath) { showOnboarding(1); return; }
      var sourceDir = scanResult ? scanResult.sourceDirectory : appConfig.projectPath;
      var outputDir = appConfig.projectPath + '/tests/';
      startRun('Generating tests\u2026', { workflow: 'generate', source: sourceDir, output: outputDir });
    }

    /**
     * Runs the AI spec preview — same as generate but dry-run mode
     * so the user can see the plan before any files are written.
     */
    function handlePreviewPlan() {
      if (!appConfig || !appConfig.projectPath) { showOnboarding(1); return; }
      var sourceDir = scanResult ? scanResult.sourceDirectory : appConfig.projectPath;
      startRun('Previewing test plan\u2026', { workflow: 'generate', source: sourceDir, dryRun: true });
    }

    /**
     * Opens the config overlay for "Record a Session" so the user can
     * enter their app's URL before the browser is launched.
     */
    function handleRecord() {
      if (!appConfig || !appConfig.projectPath) { showOnboarding(1); return; }

      openConfigOverlay(
        'Start Recording a Session',
        "Enter your app's URL. EZTest will open it in a browser where you can click around and flag anything that looks wrong.",
        function(container) {
          container.innerHTML =
            '<div class="config-input-row">'
            + '<label>Your app URL</label>'
            + '<div class="config-input-wrap">'
            + '<input class="config-input" type="url" id="cfg-url" placeholder="http://localhost:3000" value="' + escapeAttr(appConfig.appUrl || '') + '" />'
            + '</div>'
            + '</div>';
        },
        function() {
          var urlValue = document.getElementById('cfg-url').value.trim();
          if (!urlValue) { document.getElementById('cfg-url').focus(); return false; }
          // Persist URL so it pre-fills next time
          fetch('/api/app-config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ appUrl: urlValue })
          });
          appConfig.appUrl = urlValue;
          startRun('Recording session\u2026', { workflow: 'record', url: urlValue });
          return true;
        }
      );
    }

    /**
     * Opens the config overlay for "Fix a Failing Test" so the user can
     * choose a report file from a previous failing run.
     */
    function handleFixTest() {
      if (!appConfig || !appConfig.projectPath) { showOnboarding(1); return; }

      openConfigOverlay(
        'Fix a Failing Test',
        'Select the test report JSON file from a previous failed run. Reports are saved in the test-results/ folder inside your EZTest installation.',
        function(container) {
          container.innerHTML =
            '<div class="config-input-row">'
            + '<label>Failure report file</label>'
            + '<div class="config-input-wrap">'
            + '<input class="config-input" type="text" id="cfg-report" placeholder="test-results/..." />'
            + '<button class="config-browse-btn" id="cfg-report-browse-btn">Browse</button>'
            + '</div>'
            + '</div>';

          // Wire up the browse button after the DOM is updated
          setTimeout(function() {
            var browseBtn = document.getElementById('cfg-report-browse-btn');
            if (browseBtn) {
              browseBtn.onclick = function() {
                browseBtn.textContent = 'Opening\u2026';
                browseBtn.disabled = true;
                fetch('/api/browse-file', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ filter: 'JSON reports|*.json|All files|*.*' })
                })
                  .then(function(r) { return r.json(); })
                  .then(function(result) {
                    browseBtn.textContent = 'Browse';
                    browseBtn.disabled = false;
                    if (!result.cancelled && result.path) {
                      document.getElementById('cfg-report').value = result.path;
                    }
                  })
                  .catch(function() { browseBtn.textContent = 'Browse'; browseBtn.disabled = false; });
              };
            }
          }, 50);
        },
        function() {
          var reportValue = document.getElementById('cfg-report').value.trim();
          if (!reportValue) { document.getElementById('cfg-report').focus(); return false; }
          startRun('Fixing failing test\u2026', {
            workflow: 'replay',
            report:   reportValue,
            source:   appConfig.projectPath
          });
          return true;
        }
      );
    }

    // ── Config overlay ────────────────────────────────────────────────────────

    /** Active "run" callback stored while the config overlay is open. */
    var activeConfigRunFn = null;

    /**
     * Opens the action config overlay with a custom title, description,
     * and field-builder function. The onRun callback is called when the
     * user clicks "Run" and should return false to cancel (e.g. validation fail).
     */
    function openConfigOverlay(title, description, buildFields, onRun) {
      document.getElementById('config-overlay-title').textContent = title;
      document.getElementById('config-overlay-desc').textContent  = description;
      buildFields(document.getElementById('config-overlay-fields'));
      activeConfigRunFn = onRun;
      document.getElementById('config-overlay').style.display = 'flex';
    }

    function closeConfigOverlay() {
      document.getElementById('config-overlay').style.display = 'none';
      activeConfigRunFn = null;
    }

    // ── Run output modal ──────────────────────────────────────────────────────

    /**
     * Emits a run:start event to the server and opens the output modal.
     * Clears previous output so every run starts fresh.
     */
    function startRun(titleText, runConfig) {
      if (isRunning) { return; }
      isRunning = true;

      // Reset progress bar to initial state for every new run
      var progressBar = document.getElementById('run-progress-bar');
      progressBar.style.width = '2%';
      progressBar.classList.remove('is-done');
      document.getElementById('run-progress-label').textContent  = 'Starting…';
      document.getElementById('run-progress-section').style.display = 'block';
      progressTotalTests   = 0;
      progressTestsWritten = 0;
      if (progressRetryCountdown) {
        clearInterval(progressRetryCountdown);
        progressRetryCountdown = null;
      }

      document.getElementById('run-modal-title').innerHTML = '<span class="spinner"></span>' + escapeHtml(titleText);
      document.getElementById('run-terminal').innerHTML    = '';
      document.getElementById('run-done-bar').style.display  = 'none';
      document.getElementById('run-tests-btn').style.display  = 'none';
      document.getElementById('open-report-btn').style.display = 'none';
      document.getElementById('run-cancel-btn').style.display = 'block';
      document.getElementById('run-modal').style.display     = 'flex';

      // Track the current run so run:done knows which action buttons to reveal
      currentRunConfig = runConfig;

      socket.emit('run:start', runConfig);
    }

    function appendLogLine(level, message) {
      var terminal = document.getElementById('run-terminal');
      var line     = document.createElement('div');
      line.className   = 'log-' + level;
      line.textContent = message;
      terminal.appendChild(line);
      terminal.scrollTop = terminal.scrollHeight;
    }

    /**
     * Sets the progress bar fill width and the stage label beneath it.
     * percentComplete is 0–100; stageLabelText is a human-readable description
     * of what the pipeline is currently doing.
     */
    function updateRunProgress(percentComplete, stageLabelText) {
      var barFill = document.getElementById('run-progress-bar');
      var label   = document.getElementById('run-progress-label');
      barFill.style.width   = Math.min(100, percentComplete) + '%';
      label.textContent     = stageLabelText;
      if (percentComplete >= 100) {
        barFill.classList.add('is-done');
      } else {
        barFill.classList.remove('is-done');
      }
    }

    /**
     * Shows a live countdown in the progress label when a rate-limit retry
     * is in progress. Ticks every second so the user knows the run is alive
     * and exactly how long until it resumes — not just frozen.
     */
    function startRetryCountdown(waitSeconds, stageLabel) {
      if (progressRetryCountdown) { clearInterval(progressRetryCountdown); }
      var secondsRemaining = waitSeconds;
      var currentPercent   = parseFloat(document.getElementById('run-progress-bar').style.width) || 0;

      function tickCountdown() {
        if (secondsRemaining <= 0) {
          clearInterval(progressRetryCountdown);
          progressRetryCountdown = null;
          updateRunProgress(currentPercent, stageLabel);
          return;
        }
        updateRunProgress(
          currentPercent,
          stageLabel + ' — rate limited, resuming in ' + secondsRemaining + 's…',
        );
        secondsRemaining--;
      }
      tickCountdown(); // fire immediately so first second shows right away
      progressRetryCountdown = setInterval(tickCountdown, 1000);
    }

    /**
     * Parses a single log line from the CLI process and advances the progress bar
     * when the line matches a known pipeline stage or batch/test count marker.
     *
     * All progress signals come from text already streamed to the terminal — no
     * separate protocol or socket event is needed. Patterns must stay in sync with
     * the log messages emitted by generate.ts, flowMapper.ts, and testGenerator.ts.
     */
    function parseProgressFromLog(logMessage) {
      // Stage: source code analysis begins
      if (logMessage.includes('Analyzing source code')) {
        updateRunProgress(10, 'Analyzing source code…');
        return;
      }

      // Stage: component scan complete — show the count
      var componentsMatch = logMessage.match(/Found (\d+) component/);
      if (componentsMatch) {
        updateRunProgress(22, 'Found ' + componentsMatch[1] + ' components — building flow map…');
        return;
      }

      // Stage: flow mapping begins
      if (logMessage.includes('Mapping components to user flows')) {
        updateRunProgress(25, 'Mapping components to user flows…');
        return;
      }

      // Flow-mapping batch progress — "batch N/M" appears in both normal and error log lines.
      // Maps batch N of M to the 25%–60% range.
      var batchMatch = logMessage.match(/batch\s+(\d+)\/(\d+)/i);
      if (batchMatch) {
        var batchCurrent = parseInt(batchMatch[1], 10);
        var batchTotal   = parseInt(batchMatch[2], 10);
        var batchPercent = 25 + Math.floor((batchCurrent / batchTotal) * 35);
        updateRunProgress(batchPercent, 'Mapping flows — batch ' + batchCurrent + ' of ' + batchTotal + '…');
        return;
      }

      // Stage: all flows identified
      var flowsMatch = logMessage.match(/Identified (\d+) user flow/);
      if (flowsMatch) {
        updateRunProgress(60, 'Identified ' + flowsMatch[1] + ' user flows — generating tests…');
        return;
      }

      // Stage: test generation begins
      if (logMessage.includes('Generating Playwright tests for')) {
        updateRunProgress(63, 'Generating Playwright test files…');
        return;
      }

      // Per-test progress — "Writing test N/M: flow name" emitted by testGenerator.ts.
      // Maps test N of M to the 63%–95% range.
      var testMatch = logMessage.match(/Writing test\s+(\d+)\/(\d+)/);
      if (testMatch) {
        var testCurrent = parseInt(testMatch[1], 10);
        var testTotal   = parseInt(testMatch[2], 10);
        var testPercent = 63 + Math.floor((testCurrent / testTotal) * 32);
        updateRunProgress(testPercent, 'Writing tests — ' + testCurrent + ' of ' + testTotal + '…');
        return;
      }

      // Rate-limit retry — start a live countdown so the user knows it's not frozen.
      // The "Retrying in Xs" text is emitted by aiClient.ts's executeWithRetry().
      var retryMatch = logMessage.match(/Retrying in (\d+)s/);
      if (retryMatch) {
        var waitSeconds  = parseInt(retryMatch[1], 10);
        var currentLabel = document.getElementById('run-progress-label').textContent
                             .replace(/ — rate limited.*/, ''); // strip any prior countdown
        startRetryCountdown(waitSeconds, currentLabel);
        return;
      }

      // Stage: pipeline finished
      if (logMessage.includes('Done!')) {
        if (progressRetryCountdown) {
          clearInterval(progressRetryCountdown);
          progressRetryCountdown = null;
        }
        updateRunProgress(100, '✅ Done!');
      }
    }

    function closeRunModal() {
      document.getElementById('run-modal').style.display = 'none';
      isRunning = false;
    }

    /**
     * Starts a Playwright test run against the output directory from the last
     * successful generate run. Uses the project root as the working directory
     * so Playwright finds its own config and installed browsers.
     */
    function startRunTests() {
      if (!lastGenerateRunConfig) { return; }
      var projectRoot = appConfig ? appConfig.projectPath : null;
      lastTestRunWorkingDir = projectRoot;

      startRun(
        'Running tests\u2026',
        {
          workflow:    'run-tests',
          output:      lastGenerateRunConfig.output,
          workingDir:  projectRoot || undefined,
        },
      );
    }

    /**
     * Sends the last test run's working directory to the server so it can open
     * the Playwright HTML report (playwright-report/index.html) in the default browser.
     */
    function openPlaywrightReport() {
      if (!lastTestRunWorkingDir) { return; }
      fetch('/api/open-report', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ reportDir: lastTestRunWorkingDir }),
      }).catch(function() {
        // Non-fatal — the button is best-effort; user can open the file manually
      });
    }

    // ── Socket events ─────────────────────────────────────────────────────────

    socket.on('run:log', function(data) {
      appendLogLine(data.level, data.message);
      parseProgressFromLog(data.message);
    });

    socket.on('run:done', function(data) {
      isRunning = false;
      // Always stop the retry countdown — the run is finished regardless of outcome
      if (progressRetryCountdown) {
        clearInterval(progressRetryCountdown);
        progressRetryCountdown = null;
      }
      var doneBar   = document.getElementById('run-done-bar');
      var doneMsg   = document.getElementById('run-done-msg');
      var cancelBtn = document.getElementById('run-cancel-btn');

      doneBar.style.display        = 'flex';
      cancelBtn.style.display      = 'none';
      document.getElementById('run-modal-title').textContent = 'Run complete';

      if (data.exitCode === 0) {
        updateRunProgress(100, '\u2705 All done!');
        doneMsg.className   = 'run-result-success';
        doneMsg.textContent = '\u2705 Completed successfully';

        // After a successful generate, offer to run the tests immediately
        if (currentRunConfig && currentRunConfig.workflow === 'generate') {
          lastGenerateRunConfig = currentRunConfig;
          document.getElementById('run-tests-btn').style.display = 'inline-block';
        }
        // After a successful test run, offer to open the HTML report
        if (currentRunConfig && currentRunConfig.workflow === 'run-tests') {
          lastTestRunWorkingDir = currentRunConfig.workingDir || null;
          document.getElementById('open-report-btn').style.display = 'inline-block';
        }
      } else if (data.exitCode === 130) {
        updateRunProgress(
          parseFloat(document.getElementById('run-progress-bar').style.width) || 0,
          'Cancelled',
        );
        doneMsg.className   = 'run-result-warning';
        doneMsg.textContent = 'Cancelled';
      } else {
        doneMsg.className   = 'run-result-failure';
        doneMsg.textContent = '\u274C Finished with errors (exit code ' + data.exitCode + ')';
        // Even on failure, offer report if it was a test run (partial results exist)
        if (currentRunConfig && currentRunConfig.workflow === 'run-tests') {
          lastTestRunWorkingDir = currentRunConfig.workingDir || null;
          document.getElementById('open-report-btn').style.display = 'inline-block';
        }
      }
    });

    // ── Utility helpers ───────────────────────────────────────────────────────

    /** Escapes HTML special characters to prevent XSS from path/name values. */
    function escapeHtml(text) {
      return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }

    /** Escapes a value for safe use inside an HTML attribute. */
    function escapeAttr(text) {
      return String(text)
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;');
    }

    // ── Wire up event listeners ───────────────────────────────────────────────

    document.addEventListener('DOMContentLoaded', function() {
      // Onboarding buttons
      document.getElementById('browse-folder-btn').addEventListener('click', browseForProjectFolder);
      document.getElementById('goto-provider-btn').addEventListener('click', goToProviderStep);
      document.getElementById('ob-back-btn').addEventListener('click', function() { showOnboarding(1); });
      document.getElementById('ob-finish-btn').addEventListener('click', finishOnboarding);

      // App bar
      document.getElementById('change-project-btn').addEventListener('click', function() {
        showOnboarding(1);
        document.getElementById('detected-project-card').style.display   = 'none';
        document.getElementById('ob-step-folder-next').style.display = 'none';
      });

      // Action card buttons
      document.getElementById('btn-generate').addEventListener('click', handleGenerateTests);
      document.getElementById('btn-preview-plan').addEventListener('click', handlePreviewPlan);
      document.getElementById('btn-record').addEventListener('click', handleRecord);
      document.getElementById('btn-fix').addEventListener('click', handleFixTest);

      // Config overlay
      document.getElementById('config-cancel-btn').addEventListener('click', closeConfigOverlay);
      document.getElementById('config-run-btn').addEventListener('click', function() {
        if (activeConfigRunFn) {
          var shouldClose = activeConfigRunFn();
          if (shouldClose !== false) { closeConfigOverlay(); }
        }
      });

      // Run modal cancel
      document.getElementById('run-cancel-btn').addEventListener('click', function() {
        socket.emit('run:cancel');
      });

      // Boot the app
      initApp();
    });
  </script>

</body>
</html>`;
}
