/**
 * Wizard Page — builds the complete HTML string for the EZTest browser UI.
 * All four steps of the wizard (environment check, workflow selection,
 * configuration, and live run output) are embedded in a single self-contained page.
 *
 * IMPORTANT: The embedded <script> block must NOT use JS template literals
 * (backticks / ${}) because this entire string is a TypeScript template literal.
 * All dynamic JS values use string concatenation instead.
 */

// ── Color palette constants ──────────────────────────────────────────────────

const COLOR_BACKGROUND   = '#0d1117';
const COLOR_CARD         = '#161b22';
const COLOR_BORDER       = '#30363d';
const COLOR_ACCENT       = '#7c3aed';
const COLOR_SUCCESS      = '#3fb950';
const COLOR_ERROR        = '#f85149';
const COLOR_WARNING      = '#e3b341';
const COLOR_TEXT_PRIMARY = '#e6edf3';
const COLOR_TEXT_MUTED   = '#8b949e';

/**
 * Returns the full HTML document for the EZTest wizard as a string.
 * The page is self-contained — CSS and JS are both inlined so no external
 * assets are needed beyond the Socket.io script served by the server itself.
 */
export function buildWizardPageHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>EZTest Wizard</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      background: ${COLOR_BACKGROUND};
      color: ${COLOR_TEXT_PRIMARY};
      font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      min-height: 100vh;
      display: flex;
      align-items: flex-start;
      justify-content: center;
      padding: 40px 16px 80px;
    }

    .wizard-container {
      width: 100%;
      max-width: 720px;
    }

    /* ── Header ── */
    .wizard-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 32px;
    }
    .wizard-logo {
      font-size: 1.5rem;
      font-weight: 700;
      letter-spacing: -0.5px;
    }

    /* ── Step dots ── */
    .step-dots {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .step-dot {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      background: ${COLOR_BORDER};
      transition: background 0.25s;
      cursor: default;
    }
    .step-dot.active   { background: ${COLOR_ACCENT}; }
    .step-dot.complete { background: ${COLOR_SUCCESS}; }
    .step-connector {
      width: 24px;
      height: 2px;
      background: ${COLOR_BORDER};
    }

    /* ── Card ── */
    .card {
      background: ${COLOR_CARD};
      border: 1px solid ${COLOR_BORDER};
      border-radius: 10px;
      padding: 20px 24px;
    }
    .card + .card { margin-top: 12px; }

    /* ── Section title ── */
    .section-title {
      font-size: 1.15rem;
      font-weight: 600;
      margin-bottom: 20px;
    }

    /* ── Check item row (Step 1) ── */
    .check-item {
      display: flex;
      align-items: flex-start;
      gap: 14px;
      padding: 16px 0;
      border-bottom: 1px solid ${COLOR_BORDER};
    }
    .check-item:last-child { border-bottom: none; }
    .check-icon {
      font-size: 1.3rem;
      margin-top: 2px;
      min-width: 24px;
      text-align: center;
    }
    .check-body { flex: 1; }
    .check-title {
      font-weight: 600;
      font-size: 0.95rem;
      margin-bottom: 3px;
    }
    .check-subtitle {
      font-size: 0.82rem;
      color: ${COLOR_TEXT_MUTED};
      line-height: 1.5;
    }
    .check-subtitle.error-text { color: ${COLOR_ERROR}; }
    .check-subtitle.success-text { color: ${COLOR_SUCCESS}; }

    /* ── Inline API key form ── */
    .api-key-form {
      display: flex;
      gap: 8px;
      margin-top: 10px;
      flex-wrap: wrap;
      align-items: center;
    }
    .api-key-form select,
    .api-key-form input {
      background: ${COLOR_BACKGROUND};
      border: 1px solid ${COLOR_BORDER};
      border-radius: 6px;
      color: ${COLOR_TEXT_PRIMARY};
      padding: 6px 10px;
      font-size: 0.85rem;
      outline: none;
    }
    .api-key-form select:focus,
    .api-key-form input:focus { border-color: ${COLOR_ACCENT}; }
    .api-key-form input { flex: 1; min-width: 180px; }
    .api-key-form .save-note {
      font-size: 0.78rem;
      color: ${COLOR_TEXT_MUTED};
      width: 100%;
      margin-top: 2px;
    }

    /* ── Workflow cards grid (Step 2) ── */
    .workflow-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
      gap: 12px;
      margin-bottom: 20px;
    }
    @media (max-width: 560px) {
      .workflow-grid { grid-template-columns: 1fr; }
    }
    .workflow-card {
      background: ${COLOR_CARD};
      border: 2px solid ${COLOR_BORDER};
      border-radius: 10px;
      padding: 20px 16px;
      cursor: pointer;
      transition: border-color 0.2s, background 0.2s;
      text-align: center;
    }
    .workflow-card:hover { border-color: ${COLOR_ACCENT}; background: #1c2230; }
    .workflow-card.selected {
      border-color: ${COLOR_ACCENT};
      background: #1a1535;
    }
    .workflow-card .wf-emoji { font-size: 2rem; display: block; margin-bottom: 10px; }
    .workflow-card .wf-title {
      font-weight: 700;
      font-size: 0.9rem;
      margin-bottom: 6px;
    }
    .workflow-card .wf-desc {
      font-size: 0.78rem;
      color: ${COLOR_TEXT_MUTED};
      line-height: 1.5;
    }

    /* ── Config form (Step 3) ── */
    .config-field { margin-bottom: 18px; }
    .config-field label {
      display: block;
      font-size: 0.85rem;
      font-weight: 600;
      margin-bottom: 6px;
      color: ${COLOR_TEXT_MUTED};
    }
    .config-field input {
      width: 100%;
      background: ${COLOR_BACKGROUND};
      border: 1px solid ${COLOR_BORDER};
      border-radius: 6px;
      color: ${COLOR_TEXT_PRIMARY};
      padding: 8px 12px;
      font-size: 0.9rem;
      outline: none;
      transition: border-color 0.2s;
    }
    .config-field input:focus { border-color: ${COLOR_ACCENT}; }
    .config-checkbox label {
      display: flex;
      align-items: center;
      gap: 8px;
      cursor: pointer;
      font-size: 0.85rem;
      color: ${COLOR_TEXT_MUTED};
    }
    .config-checkbox input[type="checkbox"] {
      width: auto;
      border: none;
      padding: 0;
      accent-color: ${COLOR_ACCENT};
      cursor: pointer;
    }

    /* ── Buttons ── */
    .btn {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 9px 20px;
      border: none;
      border-radius: 6px;
      font-size: 0.9rem;
      font-weight: 600;
      cursor: pointer;
      transition: opacity 0.2s, background 0.2s;
    }
    .btn:disabled { opacity: 0.4; cursor: not-allowed; }
    .btn-primary  { background: ${COLOR_ACCENT}; color: #fff; }
    .btn-primary:hover:not(:disabled) { background: #6d28d9; }
    .btn-secondary { background: ${COLOR_BORDER}; color: ${COLOR_TEXT_PRIMARY}; }
    .btn-secondary:hover:not(:disabled) { background: #3d444d; }
    .btn-danger { background: ${COLOR_ERROR}; color: #fff; }
    .btn-danger:hover:not(:disabled) { background: #c9322a; }
    .btn-save { background: ${COLOR_SUCCESS}; color: #0d1117; padding: 6px 14px; font-size: 0.83rem; }
    .btn-save:hover:not(:disabled) { background: #2ea043; }

    .btn-row {
      display: flex;
      gap: 10px;
      margin-top: 24px;
      flex-wrap: wrap;
    }

    /* ── Step panels ── */
    .step-panel { display: none; }
    .step-panel.active { display: block; }

    /* ── Run status row (Step 4) ── */
    .run-status-row {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 16px;
      font-size: 0.92rem;
    }
    .spinner {
      width: 20px;
      height: 20px;
      border: 3px solid ${COLOR_BORDER};
      border-top-color: ${COLOR_ACCENT};
      border-radius: 50%;
      animation: spin 0.75s linear infinite;
      flex-shrink: 0;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    .spinner.hidden { display: none; }
    .run-status-text { font-weight: 500; }

    /* ── Terminal pane ── */
    .terminal-pane {
      background: #010409;
      border: 1px solid ${COLOR_BORDER};
      border-radius: 8px;
      padding: 14px 16px;
      height: 320px;
      overflow-y: auto;
      font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
      font-size: 0.8rem;
      line-height: 1.6;
    }
    .log-line { margin: 0; white-space: pre-wrap; word-break: break-all; }
    .log-info    { color: #c9d1d9; }
    .log-success { color: ${COLOR_SUCCESS}; }
    .log-error   { color: ${COLOR_ERROR}; }
    .log-warning { color: ${COLOR_WARNING}; }
    .log-debug   { color: #484f58; }
  </style>
</head>
<body>
  <div class="wizard-container">

    <!-- ── Shared header with step dots ── -->
    <div class="wizard-header">
      <span class="wizard-logo">🧪 EZTest</span>
      <div class="step-dots" id="stepDots">
        <div class="step-dot active" id="dot1"></div>
        <div class="step-connector"></div>
        <div class="step-dot" id="dot2"></div>
        <div class="step-connector"></div>
        <div class="step-dot" id="dot3"></div>
        <div class="step-connector"></div>
        <div class="step-dot" id="dot4"></div>
      </div>
    </div>

    <!-- ══════════════════════════════════════════════════
         Step 1 — Environment Setup
    ══════════════════════════════════════════════════ -->
    <div class="step-panel active" id="stepPanel1">
      <div class="card">
        <p class="section-title">Environment Setup</p>

        <!-- Node.js version check -->
        <div class="check-item">
          <div class="check-icon" id="nodeIcon">⏳</div>
          <div class="check-body">
            <div class="check-title">Node.js</div>
            <div class="check-subtitle" id="nodeSubtitle">Checking version…</div>
          </div>
        </div>

        <!-- AI API key -->
        <div class="check-item">
          <div class="check-icon" id="apiKeyIcon">⏳</div>
          <div class="check-body">
            <div class="check-title">AI API Key</div>
            <div class="check-subtitle" id="apiKeySubtitle">Checking environment…</div>
            <!-- Shown only when no key found -->
            <div class="api-key-form" id="apiKeyForm" style="display:none">
              <select id="providerSelect">
                <option value="github">GitHub Copilot (recommended — uses your Copilot subscription)</option>
                <option value="openai">OpenAI</option>
                <option value="anthropic">Anthropic (Claude)</option>
              </select>
              <input type="password" id="apiKeyInput" placeholder="GitHub PAT, sk-… or sk-ant-…" autocomplete="off" />
              <button class="btn btn-save" id="saveKeyBtn" onclick="saveApiKey()">Save</button>
              <span class="save-note">Saved locally to .env</span>
            </div>
          </div>
        </div>

        <!-- Playwright check -->
        <div class="check-item">
          <div class="check-icon" id="playwrightIcon">⏳</div>
          <div class="check-body">
            <div class="check-title">Playwright</div>
            <div class="check-subtitle" id="playwrightSubtitle">Checking installation…</div>
          </div>
        </div>
      </div>

      <div class="btn-row">
        <button class="btn btn-primary" id="step1ContinueBtn" disabled onclick="goToStep(2)">
          Continue →
        </button>
      </div>
    </div>

    <!-- ══════════════════════════════════════════════════
         Step 2 — Choose Workflow
    ══════════════════════════════════════════════════ -->
    <div class="step-panel" id="stepPanel2">
      <div class="card">
        <p class="section-title">Choose a Workflow</p>
        <div class="workflow-grid">

          <div class="workflow-card" id="wfInit" onclick="selectWorkflow('init')">
            <span class="wf-emoji">📝</span>
            <div class="wf-title">Generate Spec</div>
            <div class="wf-desc">AI reads your source code and writes eztest-spec.md — start here</div>
          </div>

          <div class="workflow-card" id="wfPlan" onclick="selectWorkflow('plan')">
            <span class="wf-emoji">📋</span>
            <div class="wf-title">Preview Plan</div>
            <div class="wf-desc">See what tests will be written before committing to full generation</div>
          </div>

          <div class="workflow-card" id="wfGenerate" onclick="selectWorkflow('generate')">
            <span class="wf-emoji">🧪</span>
            <div class="wf-title">Generate Tests</div>
            <div class="wf-desc">AI reads your source code and writes Playwright tests</div>
          </div>

          <div class="workflow-card" id="wfRecord" onclick="selectWorkflow('record')">
            <span class="wf-emoji">📹</span>
            <div class="wf-title">Record Session</div>
            <div class="wf-desc">Browse your app with a Flag button — records everything you do</div>
          </div>

          <div class="workflow-card" id="wfReplay" onclick="selectWorkflow('replay')">
            <span class="wf-emoji">🔄</span>
            <div class="wf-title">Replay &amp; Fix</div>
            <div class="wf-desc">Feed a bug report → AI reproduces, fixes code, validates</div>
          </div>

        </div>
      </div>

      <div class="btn-row">
        <button class="btn btn-secondary" onclick="goToStep(1)">← Back</button>
        <button class="btn btn-primary" id="step2ConfigureBtn" disabled onclick="goToStep(3)">
          Configure →
        </button>
      </div>
    </div>

    <!-- ══════════════════════════════════════════════════
         Step 3 — Configure
    ══════════════════════════════════════════════════ -->
    <div class="step-panel" id="stepPanel3">
      <div class="card">
        <p class="section-title" id="step3Title">Configure</p>
        <div id="step3Fields">
          <!-- Fields rendered dynamically by renderConfigFields() -->
        </div>
      </div>

      <div class="btn-row">
        <button class="btn btn-secondary" onclick="goToStep(2)">← Back</button>
        <button class="btn btn-primary" onclick="startRun()">Run →</button>
      </div>
    </div>

    <!-- ══════════════════════════════════════════════════
         Step 4 — Run
    ══════════════════════════════════════════════════ -->
    <div class="step-panel" id="stepPanel4">
      <div class="card">
        <div class="run-status-row">
          <div class="spinner" id="runSpinner"></div>
          <span class="run-status-text" id="runStatusText">Starting…</span>
        </div>
        <div class="terminal-pane" id="terminalPane"></div>
      </div>

      <div class="btn-row">
        <button class="btn btn-danger" id="stopBtn" onclick="cancelRun()">Stop</button>
        <button class="btn btn-secondary" id="runAgainBtn" style="display:none" onclick="startRun()">Run Again</button>
        <button class="btn btn-secondary" id="chooseWorkflowBtn" style="display:none" onclick="goToStep(2)">← Choose Workflow</button>
      </div>
    </div>

  </div><!-- /.wizard-container -->

  <!-- Socket.io is auto-served by the UI server at this path -->
  <script src="/socket.io/socket.io.js"></script>
  <script>
    // ── State ─────────────────────────────────────────────────────────────────
    var currentStep = 1;
    var selectedWorkflow = null;
    var statusData = null;
    var socket = io();

    // ── Step navigation ────────────────────────────────────────────────────────

    function goToStep(stepNumber) {
      document.getElementById('stepPanel' + currentStep).classList.remove('active');
      currentStep = stepNumber;
      document.getElementById('stepPanel' + currentStep).classList.add('active');
      updateStepDots();
      if (stepNumber === 3) { renderConfigFields(); }
    }

    function updateStepDots() {
      for (var dotIndex = 1; dotIndex <= 4; dotIndex++) {
        var dotElement = document.getElementById('dot' + dotIndex);
        dotElement.classList.remove('active', 'complete');
        if (dotIndex < currentStep) {
          dotElement.classList.add('complete');
        } else if (dotIndex === currentStep) {
          dotElement.classList.add('active');
        }
      }
    }

    // ── Step 1: Fetch environment status ──────────────────────────────────────

    function loadStatus() {
      fetch('/api/status')
        .then(function(response) { return response.json(); })
        .then(function(data) {
          statusData = data;
          applyNodeStatus(data.node);
          applyApiKeyStatus(data.apiKey);
          applyPlaywrightStatus(data.playwright);
          checkStep1AllPassing(data);
        })
        .catch(function() {
          document.getElementById('nodeSubtitle').textContent = 'Could not reach server.';
        });
    }

    function applyNodeStatus(nodeInfo) {
      var iconEl    = document.getElementById('nodeIcon');
      var subtitleEl = document.getElementById('nodeSubtitle');
      if (nodeInfo.ok) {
        iconEl.textContent = '\u2705';
        subtitleEl.textContent = 'Running ' + nodeInfo.version;
        subtitleEl.className = 'check-subtitle success-text';
      } else {
        iconEl.textContent = '\u274C';
        subtitleEl.textContent = 'Node ' + nodeInfo.version + ' detected — v18 or newer required';
        subtitleEl.className = 'check-subtitle error-text';
      }
    }

    function applyApiKeyStatus(apiKeyInfo) {
      var iconEl     = document.getElementById('apiKeyIcon');
      var subtitleEl = document.getElementById('apiKeySubtitle');
      var formEl     = document.getElementById('apiKeyForm');
      if (apiKeyInfo.ok) {
        var providerLabel = apiKeyInfo.hasGithub ? 'GitHub Copilot' : (apiKeyInfo.hasOpenAi ? 'OpenAI' : 'Anthropic');
        iconEl.textContent = '\u2705';
        subtitleEl.textContent = providerLabel + ' key found';
        subtitleEl.className = 'check-subtitle success-text';
        formEl.style.display = 'none';
      } else {
        iconEl.textContent = '\u274C';
        subtitleEl.textContent = 'No API key found. Add one below or set EZTEST_GITHUB_TOKEN in .env';
        subtitleEl.className = 'check-subtitle error-text';
        formEl.style.display = 'flex';
      }
    }

    function applyPlaywrightStatus(playwrightInfo) {
      var iconEl     = document.getElementById('playwrightIcon');
      var subtitleEl = document.getElementById('playwrightSubtitle');
      if (playwrightInfo.installed) {
        iconEl.textContent = '\u2705';
        subtitleEl.textContent = 'Playwright is installed';
        subtitleEl.className = 'check-subtitle success-text';
      } else {
        iconEl.textContent = '\u274C';
        subtitleEl.textContent = 'Not found. Run: npx playwright install chromium';
        subtitleEl.className = 'check-subtitle error-text';
      }
    }

    function checkStep1AllPassing(data) {
      var isAllPassing = data.node.ok && data.apiKey.ok && data.playwright.installed;
      document.getElementById('step1ContinueBtn').disabled = !isAllPassing;
    }

    // ── Step 1: Save API key ───────────────────────────────────────────────────

    function saveApiKey() {
      var provider = document.getElementById('providerSelect').value;
      var apiKey   = document.getElementById('apiKeyInput').value.trim();
      if (!apiKey) { return; }

      var saveBtn = document.getElementById('saveKeyBtn');
      saveBtn.disabled = true;
      saveBtn.textContent = 'Saving…';

      fetch('/api/env', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: provider, apiKey: apiKey })
      })
        .then(function(response) { return response.json(); })
        .then(function(result) {
          if (result.saved) {
            // Re-fetch status to re-evaluate checks
            loadStatus();
          }
          saveBtn.disabled = false;
          saveBtn.textContent = 'Save';
        })
        .catch(function() {
          saveBtn.disabled = false;
          saveBtn.textContent = 'Save';
        });
    }

    // ── Step 2: Workflow selection ────────────────────────────────────────────

    function selectWorkflow(workflowName) {
      selectedWorkflow = workflowName;
      var workflowIds = ['wfInit', 'wfPlan', 'wfGenerate', 'wfRecord', 'wfReplay'];
      for (var wi = 0; wi < workflowIds.length; wi++) {
        document.getElementById(workflowIds[wi]).classList.remove('selected');
      }
      var idMap = { init: 'wfInit', plan: 'wfPlan', generate: 'wfGenerate', record: 'wfRecord', replay: 'wfReplay' };
      document.getElementById(idMap[workflowName]).classList.add('selected');
      document.getElementById('step2ConfigureBtn').disabled = false;
    }

    // ── Step 3: Render config fields based on selected workflow ───────────────

    function renderConfigFields() {
      var fieldsContainer = document.getElementById('step3Fields');
      var titleEl         = document.getElementById('step3Title');

      fieldsContainer.innerHTML = '';

      if (selectedWorkflow === 'init') {
        titleEl.textContent = 'Configure: Generate Spec';
        fieldsContainer.innerHTML =
          buildTextField('configSource', 'Source Directory', './src', '') +
          buildTextField('configOutput', 'Output File', './eztest-spec.md', '') +
          buildCheckbox('configDryRun', 'Dry run — print spec without writing to disk', false);

      } else if (selectedWorkflow === 'plan') {
        titleEl.textContent = 'Configure: Preview Test Plan';
        fieldsContainer.innerHTML =
          buildTextField('configSource', 'Source Directory', './src', '') +
          buildTextField('configUrl',    'Application URL',  'http://localhost:3000', '') +
          buildTextField('configOutput', 'Save plan to file (optional)', '', './test-plan.md');

      } else if (selectedWorkflow === 'generate') {
        titleEl.textContent = 'Configure: Generate Tests';
        fieldsContainer.innerHTML =
          buildTextField('configSource', 'Source Directory', './src', '') +
          buildTextField('configUrl',    'Application URL',  'http://localhost:3000', '') +
          buildTextField('configOutput', 'Output Directory', './tests/generated', '') +
          buildCheckbox('configRunAndFix', 'Run tests after generation and auto-fix selector failures (recommended)', true) +
          buildCheckbox('configNoReview',  'Skip behavioral assertion review pass (faster, fewer API calls)', false);

      } else if (selectedWorkflow === 'record') {
        titleEl.textContent = 'Configure: Record Session';
        fieldsContainer.innerHTML =
          buildTextField('configUrl',    'Application URL',  'http://localhost:3000', '') +
          buildTextField('configOutput', 'Output Directory', './bug-reports', '');

      } else if (selectedWorkflow === 'replay') {
        titleEl.textContent = 'Configure: Replay & Fix';
        fieldsContainer.innerHTML =
          buildTextField('configReport', 'Bug Report File', '', './bug-reports/bug-report-abc123.json') +
          buildTextField('configSource', 'Source Directory', './src', '');
      }
    }

    function buildTextField(fieldId, labelText, defaultValue, placeholderText) {
      return '<div class="config-field">'
        + '<label for="' + fieldId + '">' + labelText + '</label>'
        + '<input type="text" id="' + fieldId + '"'
        + ' value="' + defaultValue + '"'
        + ' placeholder="' + placeholderText + '" />'
        + '</div>';
    }

    function buildCheckbox(fieldId, labelText, isChecked) {
      return '<div class="config-field config-checkbox">'
        + '<label>'
        + '<input type="checkbox" id="' + fieldId + '"' + (isChecked ? ' checked' : '') + ' />'
        + ' ' + labelText
        + '</label>'
        + '</div>';
    }

    // ── Step 4: Start run ─────────────────────────────────────────────────────

    function startRun() {
      goToStep(4);
      clearTerminal();
      showRunning();

      var config = { workflow: selectedWorkflow };

      var sourceEl       = document.getElementById('configSource');
      var urlEl          = document.getElementById('configUrl');
      var outputEl       = document.getElementById('configOutput');
      var reportEl       = document.getElementById('configReport');
      var runAndFixEl    = document.getElementById('configRunAndFix');
      var noReviewEl     = document.getElementById('configNoReview');
      var dryRunEl       = document.getElementById('configDryRun');

      if (sourceEl)    { config.source    = sourceEl.value; }
      if (urlEl)       { config.url       = urlEl.value; }
      if (outputEl)    { config.output    = outputEl.value; }
      if (reportEl)    { config.report    = reportEl.value; }
      if (runAndFixEl) { config.runAndFix = runAndFixEl.checked; }
      if (noReviewEl)  { config.noReview  = noReviewEl.checked; }
      if (dryRunEl)    { config.dryRun    = dryRunEl.checked; }

      socket.emit('run:start', config);
    }

    function cancelRun() {
      socket.emit('run:cancel');
    }

    function showRunning() {
      document.getElementById('runSpinner').classList.remove('hidden');
      document.getElementById('runStatusText').textContent = 'Running…';
      document.getElementById('stopBtn').style.display = 'inline-flex';
      document.getElementById('runAgainBtn').style.display = 'none';
      document.getElementById('chooseWorkflowBtn').style.display = 'none';
    }

    function showRunComplete(exitCode) {
      document.getElementById('runSpinner').classList.add('hidden');
      var isSuccess = exitCode === 0;
      document.getElementById('runStatusText').textContent =
        isSuccess ? '\u2705 Completed successfully' : '\u274C Finished with errors (exit code ' + exitCode + ')';
      document.getElementById('stopBtn').style.display = 'none';
      document.getElementById('runAgainBtn').style.display = 'inline-flex';
      document.getElementById('chooseWorkflowBtn').style.display = 'inline-flex';
    }

    // ── Terminal helpers ───────────────────────────────────────────────────────

    function clearTerminal() {
      document.getElementById('terminalPane').innerHTML = '';
    }

    function appendLog(level, message) {
      var terminalPaneEl = document.getElementById('terminalPane');
      var lineEl = document.createElement('p');
      lineEl.className = 'log-line log-' + level;
      lineEl.textContent = message;
      terminalPaneEl.appendChild(lineEl);
      // Auto-scroll to newest log line
      terminalPaneEl.scrollTop = terminalPaneEl.scrollHeight;
    }

    // ── Socket.io events ──────────────────────────────────────────────────────

    socket.on('run:log', function(payload) {
      appendLog(payload.level, payload.message);
    });

    socket.on('run:done', function(payload) {
      showRunComplete(payload.exitCode);
    });

    // ── Bootstrap ─────────────────────────────────────────────────────────────

    loadStatus();
  </script>
</body>
</html>`;
}
