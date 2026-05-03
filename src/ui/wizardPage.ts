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

import { resolve } from 'node:path';

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
 * Builds copy-ready MCP setup presets that already include the local Node.js
 * executable and the compiled EZTest MCP entry point for this machine.
 */
function buildMcpSetupPresets(): Record<string, {
  title: string;
  destination: string;
  searchHint: string;
  snippet: string;
}> {
  const nodeExecutablePath = process.execPath;
  const mcpEntryPointPath = resolve(process.cwd(), 'dist', 'mcp', 'index.js');

  const stdioCommand = {
    command: nodeExecutablePath,
    args:    [mcpEntryPointPath],
  };

  return {
    vscode: {
      title:       'VS Code',
      destination: '.vscode/mcp.json',
      searchHint:  'Open your project in VS Code, then paste this into .vscode/mcp.json.',
      snippet:     JSON.stringify({ servers: { eztest: { type: 'stdio', ...stdioCommand } } }, null, 2),
    },
    cursor: {
      title:       'Cursor',
      destination: '~/.cursor/mcp.json',
      searchHint:  'Paste this into your Cursor MCP config file, then save.',
      snippet:     JSON.stringify({ mcpServers: { eztest: stdioCommand } }, null, 2),
    },
    windsurf: {
      title:       'Windsurf',
      destination: '~/.windsurf/mcp.json',
      searchHint:  'Paste this into your Windsurf MCP config file, then save.',
      snippet:     JSON.stringify({ mcpServers: { eztest: stdioCommand } }, null, 2),
    },
    claude: {
      title:       'Claude Code',
      destination: 'Claude Code terminal',
      searchHint:  'Paste this command into Claude Code once, then press Enter.',
      snippet:     'claude mcp add eztest -- "' + nodeExecutablePath + '" "' + mcpEntryPointPath + '"',
    },
  };
}

/**
 * Returns the full HTML document for the EZTest application as a string.
 * The page is entirely self-contained — all CSS and JavaScript are inlined.
 */
export function buildWizardPageHtml(): string {
  const mcpSetupPresetsJson = JSON.stringify(buildMcpSetupPresets());

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
    .config-card.is-wide { max-width: 760px; }
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
    .mcp-step-list {
      display: grid;
      gap: 10px;
      margin-bottom: 18px;
    }
    .mcp-step-card {
      display: flex;
      gap: 12px;
      align-items: flex-start;
      background: ${COLOR_BG};
      border: 1px solid ${COLOR_BORDER};
      border-radius: 10px;
      padding: 12px 14px;
    }
    .mcp-step-number {
      width: 24px;
      height: 24px;
      border-radius: 999px;
      background: ${COLOR_ACCENT};
      color: #fff;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-size: 0.8rem;
      font-weight: 700;
      flex-shrink: 0;
    }
    .mcp-step-title { font-size: 0.9rem; font-weight: 700; margin-bottom: 3px; }
    .mcp-step-body { font-size: 0.82rem; color: ${COLOR_MUTED}; line-height: 1.5; }
    .mcp-preset-row {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-bottom: 14px;
    }
    .mcp-preset-btn {
      background: #21262d;
      border: 1px solid ${COLOR_BORDER};
      color: ${COLOR_PRIMARY};
      border-radius: 999px;
      padding: 9px 14px;
      font-size: 0.84rem;
      cursor: pointer;
    }
    .mcp-preset-btn.is-active {
      background: ${COLOR_ACCENT}22;
      border-color: ${COLOR_ACCENT};
      color: #fff;
    }
    .mcp-destination-box {
      background: ${COLOR_BG};
      border: 1px solid ${COLOR_BORDER};
      border-radius: 8px;
      color: ${COLOR_PRIMARY};
      padding: 10px 12px;
      font-size: 0.88rem;
      line-height: 1.5;
    }
    .mcp-search-hint {
      margin-top: 6px;
      font-size: 0.78rem;
      color: ${COLOR_MUTED};
      line-height: 1.5;
    }
    .mcp-snippet-box {
      background: ${COLOR_BG};
      border: 1px solid ${COLOR_BORDER};
      border-radius: 8px;
      color: ${COLOR_PRIMARY};
      padding: 14px;
      font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
      font-size: 0.82rem;
      line-height: 1.6;
      white-space: pre-wrap;
      word-break: break-word;
      max-height: 240px;
      overflow: auto;
    }
    .mcp-copy-row {
      display: flex;
      gap: 10px;
      align-items: center;
      margin-top: 14px;
      flex-wrap: wrap;
    }
    .mcp-copy-row .btn-primary { width: auto; padding: 10px 18px; }
    .mcp-copy-status {
      font-size: 0.8rem;
      color: ${COLOR_MUTED};
      line-height: 1.5;
    }

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

    /* ── API Key Settings modal ── */
    .api-key-modal-backdrop {
      position: fixed; inset: 0;
      background: rgba(0,0,0,0.72);
      z-index: 200;
      display: flex; align-items: center; justify-content: center;
      padding: 24px;
    }
    .api-key-modal-card {
      background: ${COLOR_CARD};
      border: 1px solid ${COLOR_BORDER};
      border-radius: 14px;
      padding: 28px 32px;
      width: 100%;
      max-width: 480px;
    }
    .api-key-modal-title {
      font-size: 1.08rem; font-weight: 700; margin-bottom: 6px;
    }
    .api-key-modal-desc {
      font-size: 0.87rem; color: ${COLOR_MUTED}; margin-bottom: 20px; line-height: 1.5;
    }
    /* Status row showing current provider at the top of the modal */
    .api-key-status-row {
      display: flex; align-items: center; gap: 10px;
      background: ${COLOR_BG}; border: 1px solid ${COLOR_BORDER};
      border-radius: 8px; padding: 10px 14px; margin-bottom: 20px;
      font-size: 0.87rem;
    }
    .api-key-status-badge {
      font-size: 0.73rem; font-weight: 600; padding: 2px 9px; border-radius: 10px;
      flex-shrink: 0;
    }
    .api-key-status-badge.is-connected { background: rgba(63,185,80,0.15); color: ${COLOR_SUCCESS}; }
    .api-key-status-badge.is-missing   { background: rgba(248,81,73,0.15);  color: ${COLOR_ERROR};   }
    /* Form fields inside the modal */
    .api-key-modal-form label {
      display: block; font-size: 0.78rem; color: ${COLOR_MUTED}; margin-bottom: 6px;
      text-transform: uppercase; letter-spacing: 0.5px;
    }
    .api-key-modal-form select,
    .api-key-modal-form input[type="password"] {
      width: 100%; background: ${COLOR_BG}; border: 1px solid ${COLOR_BORDER};
      color: ${COLOR_PRIMARY}; border-radius: 6px; padding: 8px 12px;
      font-size: 0.88rem; margin-bottom: 16px;
    }
    .api-key-modal-form select:focus,
    .api-key-modal-form input[type="password"]:focus {
      outline: none; border-color: ${COLOR_ACCENT};
    }
    /* Bottom action row: Remove key (left, danger) + Cancel/Save (right) */
    .api-key-modal-actions {
      display: flex; justify-content: space-between; align-items: center; margin-top: 4px;
    }
    .api-key-modal-primary-actions { display: flex; gap: 8px; }
    .btn-danger {
      background: transparent; border: 1px solid ${COLOR_ERROR}; color: ${COLOR_ERROR};
      border-radius: 6px; padding: 7px 14px; font-size: 0.87rem; font-weight: 600; cursor: pointer;
    }
    .btn-danger:hover { background: rgba(248,81,73,0.12); }
    /* Inline feedback line shown after save or remove */
    .api-key-feedback { font-size: 0.82rem; margin-top: 8px; min-height: 18px; }
    .api-key-feedback.is-success { color: ${COLOR_SUCCESS}; }
    .api-key-feedback.is-error   { color: ${COLOR_ERROR};   }
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

    <!-- Update banner — shown only when a newer EZTest version is available.
         Lives outside the app-bar so it spans the full width above everything. -->
    <div id="update-banner" style="display:none; background: linear-gradient(90deg, #1e1b4b 0%, #312e81 100%); border-bottom: 1px solid #4f46e5; padding: 10px 20px; display: none; align-items: center; gap: 12px; font-size: 0.88rem;">
      <span style="font-size: 1.1em;">&#x1F680;</span>
      <span id="update-banner-text" style="flex:1; color: #c7d2fe;">EZTest update available</span>
      <button id="update-install-btn" style="background: #4f46e5; color: #fff; border: none; border-radius: 6px; padding: 6px 16px; font-size: 0.85rem; font-weight: 600; cursor: pointer;">Update Now</button>
      <button id="update-dismiss-btn" style="background: transparent; color: #818cf8; border: 1px solid #312e81; border-radius: 6px; padding: 6px 12px; font-size: 0.85rem; cursor: pointer;">Later</button>
    </div>

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

        <!-- Card 4: Run Tests -->
        <div class="action-card">
          <div class="action-icon">&#9654;&#xFE0F;</div>
          <div class="action-title">Run Your Tests</div>
          <div class="action-description">
            Execute the Playwright tests that have already been generated for your project.
            Results stream live so you can see exactly what passed, what failed, and why —
            then open the full HTML report in one click.
          </div>
          <div class="action-best-for">
            <strong>Best for:</strong> Verifying your app after a code change without re-generating tests.
          </div>
          <button class="action-btn" id="btn-run-tests">Run Tests &#8594;</button>
          <div class="action-secondary-link" id="btn-open-last-report" style="display:none">Open last report</div>
        </div>

        <!-- Card 5: MCP Setup -->
        <div class="action-card">
          <div class="action-icon">&#x1F9E9;</div>
          <div class="action-title">Set Up EZTest In My IDE</div>
          <div class="action-description">
            Want EZTest inside VS Code, Cursor, Windsurf, or Claude Code?
            We give you the exact setup to copy for this computer — already filled in.
          </div>
          <div class="action-best-for">
            <strong>Best for:</strong> Using EZTest from your IDE without touching the terminal.
          </div>
          <button class="action-btn" id="btn-mcp-setup">Open MCP Setup &#8594;</button>
        </div>

        <!-- Card 6: Manage AI Provider -->
        <div class="action-card">
          <div class="action-icon">&#x1F511;</div>
          <div class="action-title">Manage AI Provider</div>
          <div class="action-description">
            Initialize, update, or remove the API key EZTest uses for AI&#8209;powered
            test generation. Switch between GitHub Copilot, OpenAI, and Anthropic
            — all without touching a config file by hand.
          </div>
          <div class="action-best-for">
            <strong>Best for:</strong> First-time setup or switching to a different AI provider.
          </div>
          <button class="action-btn" id="btn-api-settings">Manage API Key &#8594;</button>
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
       API KEY SETTINGS MODAL
       Lets users initialize, update, or remove their AI provider key at any
       time from the dashboard — no manual .env editing required.
       ───────────────────────────────────────────────────────────────────── -->
  <div id="api-key-overlay" class="api-key-modal-backdrop" style="display:none">
    <div class="api-key-modal-card">

      <div class="api-key-modal-title">&#x1F511; Manage AI Provider</div>
      <div class="api-key-modal-desc">
        Update or remove the API key EZTest uses for AI-powered test generation.
        Changes are saved to your <code style="font-size:0.82em; background:${COLOR_BG}; padding:1px 5px; border-radius:3px;">.env</code>
        file and take effect immediately — no restart needed.
      </div>

      <!-- Current provider status badge — populated by openApiKeySettings() -->
      <div class="api-key-status-row">
        <span id="api-key-status-icon">&#x2753;</span>
        <span id="api-key-status-text" style="flex:1">Checking&hellip;</span>
        <span id="api-key-status-badge" class="api-key-status-badge"></span>
      </div>

      <div class="api-key-modal-form">
        <label>Provider</label>
        <select id="settings-provider-select">
          <option value="github">GitHub Copilot (uses your Copilot subscription)</option>
          <option value="openai">OpenAI (GPT-4o)</option>
          <option value="anthropic">Anthropic (Claude)</option>
          <option value="copilot">Copilot via gh CLI (no key needed)</option>
        </select>

        <!-- Key input is hidden for the copilot provider since it uses the gh CLI -->
        <div id="settings-key-row">
          <label>API Key</label>
          <input type="password" id="settings-api-key"
                 placeholder="Paste your key here"
                 autocomplete="off" />
        </div>
      </div>

      <!-- Inline feedback: success or error message after save / remove -->
      <div id="api-key-feedback" class="api-key-feedback"></div>

      <div class="api-key-modal-actions">
        <!-- Remove is shown only when a key is currently configured -->
        <button class="btn-danger" id="api-key-remove-btn" style="display:none">Remove Key</button>
        <div class="api-key-modal-primary-actions">
          <button class="btn-ghost"    id="api-key-cancel-btn">Cancel</button>
          <button class="btn-primary"  id="api-key-save-btn">Save Changes</button>
        </div>
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

  <!-- ── Update modal — shown when the user clicks "Update Now" in the banner ──
       Separate from the run modal so update output never interferes with
       normal workflow logs. -->
  <div class="run-modal-backdrop" id="update-modal-backdrop" style="display:none">
    <div class="run-modal" style="max-width: 680px; width: 95%">
      <div class="run-modal-header">
        <span class="run-modal-title" id="update-modal-title">&#x1F680; Updating EZTest</span>
        <span id="update-modal-spinner" class="run-status-running">
          <span class="spinner"></span>Working...
        </span>
      </div>
      <div class="run-terminal" id="update-terminal" style="height: 340px; min-height: 200px;"></div>
      <div class="run-done-bar" id="update-done-bar" style="display:none">
        <span id="update-done-msg"></span>
        <div class="run-done-actions">
          <button class="btn-ghost" onclick="closeUpdateModal()">Close</button>
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
    /** Copy-ready MCP setup presets for supported IDEs. */
    var mcpSetupPresets = ${mcpSetupPresetsJson};
    /** The preset currently selected in the MCP setup helper. */
    var activeMcpPresetKey = 'vscode';

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

      // Silently check for updates in the background each time the dashboard opens.
      // The banner is only shown if a newer version is found — never on error.
      checkForUpdates();
    }

    /**
     * Calls the /api/update/check endpoint and shows the update banner
     * if the GitHub releases API reports a newer version is available.
     * Failures are swallowed silently — update checks should never disrupt the UI.
     */
    function checkForUpdates() {
      fetch('/api/update/check')
        .then(function(r) { return r.json(); })
        .then(function(updateResult) {
          if (updateResult.hasUpdate) {
            showUpdateBanner(updateResult.latestVersion);
          }
        })
        .catch(function() {
          // Intentionally silent — no network or GitHub API access is not an error.
        });
    }

    /**
     * Shows the update-available banner above the app bar with the new version number.
     * The banner stays visible until the user clicks "Update Now" or "Later".
     */
    function showUpdateBanner(latestVersion) {
      var bannerEl  = document.getElementById('update-banner');
      var bannerText = document.getElementById('update-banner-text');
      bannerText.innerHTML = "EZTest <strong>v" + escapeHtml(latestVersion) + "</strong> is available \u2014 you're running an older version.";
      bannerEl.style.display = 'flex';
    }

    /** Hides the update banner without installing. */
    function dismissUpdateBanner() {
      document.getElementById('update-banner').style.display = 'none';
    }

    /** Opens the update modal and downloads the next portable bundle in the background. */
    function openUpdateModal() {
      dismissUpdateBanner();
      document.getElementById('update-modal-backdrop').style.display = 'flex';
      document.getElementById('update-terminal').innerHTML = '';
      document.getElementById('update-done-bar').style.display = 'none';
      document.getElementById('update-modal-spinner').style.display = '';
      socket.emit('update:install');
    }

    /** Closes the update modal. */
    function closeUpdateModal() {
      document.getElementById('update-modal-backdrop').style.display = 'none';
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
     * Prompts for the app URL when EZTest needs a real browser entry point.
     * Without this, generated tests fall back to guesses like localhost or
     * relative paths that cannot be opened by Playwright.
     */
    function ensureAppUrlBeforeContinuing(runButtonLabel, onUrlReady) {
      if (appConfig && appConfig.appUrl && appConfig.appUrl.trim()) {
        onUrlReady(appConfig.appUrl.trim());
        return;
      }

      openConfigOverlay(
        'Tell EZTest where your app opens',
        'EZTest needs the real page URL before it can generate or run browser tests. Paste the full URL a user opens in the browser. For Jira Forge apps, use the full Atlassian page URL — not just /jira/...',
        function(container) {
          container.innerHTML =
            '<div class="config-input-row">'
            + '<label>Your app URL</label>'
            + '<div class="config-input-wrap">'
            + '<input class="config-input" type="url" id="cfg-required-app-url" placeholder="https://example.com/app" value="' + escapeAttr((appConfig && appConfig.appUrl) || '') + '" />'
            + '</div>'
            + '</div>';
        },
        function() {
          var configuredAppUrl = document.getElementById('cfg-required-app-url').value.trim();
          if (!configuredAppUrl) {
            document.getElementById('cfg-required-app-url').focus();
            return false;
          }
          fetch('/api/app-config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ appUrl: configuredAppUrl })
          });
          appConfig.appUrl = configuredAppUrl;
          onUrlReady(configuredAppUrl);
          return true;
        },
        { runButtonLabel: runButtonLabel },
      );
    }

    /**
     * Runs the AI test generation workflow using the scanned source directory.
     * A real app URL is required so EZTest does not generate broken browser navigation.
     */
    function handleGenerateTests() {
      if (!appConfig || !appConfig.projectPath) { showOnboarding(1); return; }
      var sourceDir = scanResult ? scanResult.sourceDirectory : appConfig.projectPath;
      // Normalize Windows backslashes so the path separator is consistent before
      // appending the sub-directory — mixed slashes confuse Playwright's file glob.
      var normalizedProjectPath = appConfig.projectPath.replace(/\\\\/g, '/');
      var outputDir = normalizedProjectPath + '/tests/';
      ensureAppUrlBeforeContinuing('Save & Generate', function(configuredAppUrl) {
        startRun('Generating tests\u2026', {
          workflow: 'generate',
          source: sourceDir,
          output: outputDir,
          url: configuredAppUrl,
        });
      });
    }

    /**
     * Runs the AI spec preview — same as generate but dry-run mode
     * so the user can see the plan before any files are written.
     */
    function handlePreviewPlan() {
      if (!appConfig || !appConfig.projectPath) { showOnboarding(1); return; }
      var sourceDir = scanResult ? scanResult.sourceDirectory : appConfig.projectPath;
      ensureAppUrlBeforeContinuing('Save & Preview', function(configuredAppUrl) {
        startRun('Previewing test plan\u2026', {
          workflow: 'generate',
          source: sourceDir,
          url: configuredAppUrl,
          dryRun: true,
        });
      });
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

    /**
     * Runs the Playwright tests that already exist in the project's tests/ directory.
     * This is the persistent entry point on the main page — no re-generation needed.
     * After the run, the "Open last report" link becomes available on the same card.
     */
    function handleRunTestsFromCard() {
      if (!appConfig || !appConfig.projectPath) { showOnboarding(1); return; }
      var projectRoot  = appConfig.projectPath;
      lastTestRunWorkingDir = projectRoot;

      // Use a relative path for the Playwright test directory argument.
      // Playwright on Windows treats absolute paths as regex patterns (not directory
      // paths), so C:/Foo/tests/ finds nothing.  Since workingDir is already the
      // project root, './tests' resolves correctly from that directory.
      var relativeTestsDir = './tests';

      ensureAppUrlBeforeContinuing('Save & Run Tests', function(configuredAppUrl) {
        // Reveal "Open last report" link immediately so it persists even after the modal closes
        document.getElementById('btn-open-last-report').style.display = 'block';
        startRun(
          'Running tests\u2026',
          { workflow: 'run-tests', output: relativeTestsDir, workingDir: projectRoot, appUrl: configuredAppUrl },
        );
      });
    }

    /**
     * Opens a kid-simple MCP setup helper: pick an IDE, copy the ready-made
     * snippet, paste it where the helper tells you, save, and you're done.
     */
    function handleMcpSetup() {
      openConfigOverlay(
        'Set Up EZTest In My IDE',
        'Three easy steps: pick your IDE, click Copy setup, then paste it where EZTest tells you. No command line knowledge required.',
        renderMcpSetupFields,
        function() { return true; },
        { runButtonLabel: 'Done', isWide: true },
      );
    }

    /** Builds the MCP helper content inside the shared overlay. */
    function renderMcpSetupFields(container) {
      container.innerHTML =
        '<div class="mcp-step-list">'
        + '<div class="mcp-step-card"><div class="mcp-step-number">1</div><div><div class="mcp-step-title">Pick your IDE</div><div class="mcp-step-body">Choose the app you use below.</div></div></div>'
        + '<div class="mcp-step-card"><div class="mcp-step-number">2</div><div><div class="mcp-step-title">Copy the setup</div><div class="mcp-step-body">EZTest already filled in the right Node and EZTest paths for this computer.</div></div></div>'
        + '<div class="mcp-step-card"><div class="mcp-step-number">3</div><div><div class="mcp-step-title">Paste and save</div><div class="mcp-step-body">Put it in the file shown below, or run the command if you picked Claude Code.</div></div></div>'
        + '</div>'
        + '<div class="mcp-preset-row">'
        + '<button type="button" class="mcp-preset-btn" id="mcp-preset-vscode" onclick="renderSelectedMcpPreset(&apos;vscode&apos;)">VS Code</button>'
        + '<button type="button" class="mcp-preset-btn" id="mcp-preset-cursor" onclick="renderSelectedMcpPreset(&apos;cursor&apos;)">Cursor</button>'
        + '<button type="button" class="mcp-preset-btn" id="mcp-preset-windsurf" onclick="renderSelectedMcpPreset(&apos;windsurf&apos;)">Windsurf</button>'
        + '<button type="button" class="mcp-preset-btn" id="mcp-preset-claude" onclick="renderSelectedMcpPreset(&apos;claude&apos;)">Claude Code</button>'
        + '</div>'
        + '<div class="config-input-row">'
        + '<label>Paste this into</label>'
        + '<div class="mcp-destination-box" id="mcp-destination-box"></div>'
        + '<div class="mcp-search-hint" id="mcp-search-hint"></div>'
        + '</div>'
        + '<div class="config-input-row">'
        + '<label>Copy this setup</label>'
        + '<pre class="mcp-snippet-box" id="mcp-snippet-box"></pre>'
        + '</div>'
        + '<div class="mcp-copy-row">'
        + '<button type="button" class="btn-primary" onclick="copySelectedMcpPreset()">Copy setup</button>'
        + '<div class="mcp-copy-status" id="mcp-copy-status">Tip: after you paste it, save the file and restart your IDE if it asks.</div>'
        + '</div>';

      renderSelectedMcpPreset(activeMcpPresetKey);
    }

    /** Switches the visible MCP snippet to match the selected IDE. */
    function renderSelectedMcpPreset(presetKey) {
      var selectedPreset = mcpSetupPresets[presetKey];
      if (!selectedPreset) { return; }

      activeMcpPresetKey = presetKey;
      document.getElementById('mcp-destination-box').textContent = selectedPreset.destination;
      document.getElementById('mcp-search-hint').textContent = selectedPreset.searchHint;
      document.getElementById('mcp-snippet-box').textContent = selectedPreset.snippet;
      document.getElementById('mcp-copy-status').textContent = 'Click Copy setup, then paste this into ' + selectedPreset.destination + '.';

      Object.keys(mcpSetupPresets).forEach(function(availablePresetKey) {
        var presetButton = document.getElementById('mcp-preset-' + availablePresetKey);
        if (presetButton) {
          presetButton.classList.toggle('is-active', availablePresetKey === presetKey);
        }
      });
    }

    /** Copies the selected MCP setup snippet to the clipboard and confirms success. */
    function copySelectedMcpPreset() {
      var selectedPreset = mcpSetupPresets[activeMcpPresetKey];
      if (!selectedPreset) { return; }

      navigator.clipboard.writeText(selectedPreset.snippet).then(function() {
        document.getElementById('mcp-copy-status').textContent = 'Copied! Now paste it into ' + selectedPreset.destination + '.';
      }).catch(function() {
        document.getElementById('mcp-copy-status').textContent = 'Copy failed. You can still select the text and copy it by hand.';
      });
    }

    /**
     * Opens the most recent Playwright HTML report for the currently loaded project.
     * Works from the main page card any time after at least one test run has completed.
     */
    function handleOpenLastReport() {
      if (!lastTestRunWorkingDir && appConfig) {
        // Fall back to the current project path if no run has happened this session
        lastTestRunWorkingDir = appConfig.projectPath;
      }
      if (!lastTestRunWorkingDir) { return; }
      fetch('/api/open-report', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ reportDir: lastTestRunWorkingDir }),
      }).catch(function() {});
    }

    // ── Config overlay ────────────────────────────────────────────────────────

    /** Active "run" callback stored while the config overlay is open. */
    var activeConfigRunFn = null;

    /**
     * Opens the action config overlay with a custom title, description,
     * and field-builder function. The onRun callback is called when the
     * user clicks "Run" and should return false to cancel (e.g. validation fail).
     */
    function openConfigOverlay(title, description, buildFields, onRun, overlayOptions) {
      var normalizedOverlayOptions = overlayOptions || {};
      var configCardElement = document.querySelector('#config-overlay .config-card');
      document.getElementById('config-overlay-title').textContent = title;
      document.getElementById('config-overlay-desc').textContent  = description;
      document.getElementById('config-run-btn').textContent = normalizedOverlayOptions.runButtonLabel || 'Run →';
      document.getElementById('config-cancel-btn').textContent = normalizedOverlayOptions.cancelButtonLabel || 'Cancel';
      if (configCardElement) {
        configCardElement.classList.toggle('is-wide', Boolean(normalizedOverlayOptions.isWide));
      }
      buildFields(document.getElementById('config-overlay-fields'));
      activeConfigRunFn = onRun;
      document.getElementById('config-overlay').style.display = 'flex';
    }

    function closeConfigOverlay() {
      document.getElementById('config-overlay').style.display = 'none';
      activeConfigRunFn = null;
    }

    // ── API Key Settings modal ─────────────────────────────────────────────────

    /**
     * Opens the API key settings modal and fetches the current provider status
     * from the server so the status row reflects live .env state.
     */
    function openApiKeySettings() {
      var overlayEl  = document.getElementById('api-key-overlay');
      var feedbackEl = document.getElementById('api-key-feedback');

      // Clear any previous feedback before re-opening
      feedbackEl.textContent = '';
      feedbackEl.className   = 'api-key-feedback';
      overlayEl.style.display = 'flex';

      reloadApiKeyStatus();
    }

    /**
     * Fetches the current provider status from /api/env and updates the status
     * row inside the modal. Called on open and after a successful save/remove.
     */
    function reloadApiKeyStatus() {
      fetch('/api/env')
        .then(function(r) { return r.json(); })
        .then(function(envStatus) {
          var statusIconEl   = document.getElementById('api-key-status-icon');
          var statusTextEl   = document.getElementById('api-key-status-text');
          var statusBadgeEl  = document.getElementById('api-key-status-badge');
          var removeBtnEl    = document.getElementById('api-key-remove-btn');
          var providerSelect = document.getElementById('settings-provider-select');

          if (envStatus.hasKey) {
            statusIconEl.textContent  = '\u2705';
            statusTextEl.textContent  = envStatus.providerLabel + ' is connected';
            statusBadgeEl.textContent = 'Connected';
            statusBadgeEl.className   = 'api-key-status-badge is-connected';
            removeBtnEl.style.display = 'inline-block';
            // Pre-select the active provider so the user sees what is configured
            if (envStatus.provider) { providerSelect.value = envStatus.provider; }
          } else {
            statusIconEl.textContent  = '\u{1F511}';
            statusTextEl.textContent  = 'No API key configured';
            statusBadgeEl.textContent = 'Not connected';
            statusBadgeEl.className   = 'api-key-status-badge is-missing';
            removeBtnEl.style.display = 'none';
          }

          // Reflect the provider selection in the key-input visibility
          updateSettingsKeyRowVisibility();
        })
        .catch(function() {
          document.getElementById('api-key-status-text').textContent = 'Could not load status.';
        });
    }

    /**
     * Shows or hides the API key input field based on the selected provider.
     * The copilot provider authenticates via the gh CLI — no stored key is needed.
     */
    function updateSettingsKeyRowVisibility() {
      var selectedProvider = document.getElementById('settings-provider-select').value;
      var keyRowEl         = document.getElementById('settings-key-row');
      keyRowEl.style.display = selectedProvider === 'copilot' ? 'none' : 'block';
    }

    /**
     * Saves the selected provider and API key by POSTing to /api/env.
     * Updates the status row on success and clears the key input.
     */
    function saveApiKeySettings() {
      var providerSelect   = document.getElementById('settings-provider-select');
      var keyInputEl       = document.getElementById('settings-api-key');
      var feedbackEl       = document.getElementById('api-key-feedback');
      var selectedProvider = providerSelect.value;
      var enteredKey       = keyInputEl.value.trim();

      // The copilot provider uses gh CLI auth — no key to enter or validate
      var isCopilotSelected = selectedProvider === 'copilot';

      if (!isCopilotSelected && !enteredKey) {
        feedbackEl.textContent = 'Please enter an API key for the selected provider.';
        feedbackEl.className   = 'api-key-feedback is-error';
        keyInputEl.focus();
        return;
      }

      feedbackEl.textContent = 'Saving\u2026';
      feedbackEl.className   = 'api-key-feedback';

      // Use a sentinel value for copilot since the backend ignores apiKey for that path
      var requestPayload = {
        provider: selectedProvider,
        apiKey:   isCopilotSelected ? 'copilot-via-gh-cli' : enteredKey,
      };

      fetch('/api/env', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(requestPayload),
      })
        .then(function(r) { return r.json(); })
        .then(function(saveResult) {
          if (saveResult.saved) {
            feedbackEl.textContent = '\u2705 Saved! AI provider updated successfully.';
            feedbackEl.className   = 'api-key-feedback is-success';
            // Sync in-memory status so the dashboard reflects the change immediately
            if (statusData) { statusData.apiKey = { ok: true }; }
            keyInputEl.value = '';
            reloadApiKeyStatus();
          } else {
            feedbackEl.textContent = saveResult.error || 'Save failed. Please try again.';
            feedbackEl.className   = 'api-key-feedback is-error';
          }
        })
        .catch(function() {
          feedbackEl.textContent = 'Network error. Please try again.';
          feedbackEl.className   = 'api-key-feedback is-error';
        });
    }

    /**
     * Removes the current API key after confirming with the user.
     * Sends DELETE /api/env and refreshes the status row on success.
     */
    function removeApiKey() {
      var feedbackEl = document.getElementById('api-key-feedback');
      var shouldRemove = window.confirm(
        'Remove the current API key?\n\n' +
        'EZTest will not be able to generate tests until a new key is added.'
      );
      if (!shouldRemove) { return; }

      feedbackEl.textContent = 'Removing\u2026';
      feedbackEl.className   = 'api-key-feedback';

      fetch('/api/env', { method: 'DELETE' })
        .then(function(r) { return r.json(); })
        .then(function(removeResult) {
          if (removeResult.removed) {
            feedbackEl.textContent = 'API key removed. Add a new key above to re-enable AI features.';
            feedbackEl.className   = 'api-key-feedback is-success';
            // Sync in-memory status so action cards reflect the missing key
            if (statusData) { statusData.apiKey = { ok: false }; }
            reloadApiKeyStatus();
          } else {
            feedbackEl.textContent = removeResult.error || 'Removal failed. Please try again.';
            feedbackEl.className   = 'api-key-feedback is-error';
          }
        })
        .catch(function() {
          feedbackEl.textContent = 'Network error. Please try again.';
          feedbackEl.className   = 'api-key-feedback is-error';
        });
    }

    /** Closes the API key settings modal and clears the key input for security. */
    function closeApiKeySettings() {
      document.getElementById('api-key-overlay').style.display = 'none';
      document.getElementById('settings-api-key').value = '';
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
      // NOTE: All regex escape sequences use double backslash (\\d, \\s, \\/) because
      // this JS lives inside a TypeScript template literal — single backslashes are
      // consumed by the template literal parser before the string reaches the browser.
      var componentsMatch = logMessage.match(/Found (\\d+) component/);
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
      var batchMatch = logMessage.match(/batch\\s+(\\d+)\\/(\\d+)/i);
      if (batchMatch) {
        var batchCurrent = parseInt(batchMatch[1], 10);
        var batchTotal   = parseInt(batchMatch[2], 10);
        var batchPercent = 25 + Math.floor((batchCurrent / batchTotal) * 35);
        updateRunProgress(batchPercent, 'Mapping flows — batch ' + batchCurrent + ' of ' + batchTotal + '…');
        return;
      }

      // Stage: all flows identified
      var flowsMatch = logMessage.match(/Identified (\\d+) user flow/);
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
      var testMatch = logMessage.match(/Writing test\\s+(\\d+)\\/(\\d+)/);
      if (testMatch) {
        var testCurrent = parseInt(testMatch[1], 10);
        var testTotal   = parseInt(testMatch[2], 10);
        var testPercent = 63 + Math.floor((testCurrent / testTotal) * 32);
        updateRunProgress(testPercent, 'Writing tests — ' + testCurrent + ' of ' + testTotal + '…');
        return;
      }

      // Rate-limit retry — start a live countdown so the user knows it's not frozen.
      // The "Retrying in Xs" text is emitted by aiClient.ts's executeWithRetry().
      var retryMatch = logMessage.match(/Retrying in (\\d+)s/);
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
      ensureAppUrlBeforeContinuing('Save & Run Tests', function(configuredAppUrl) {
        startRun(
          'Running tests\u2026',
          {
            workflow:    'run-tests',
            output:      lastGenerateRunConfig.output,
            workingDir:  projectRoot || undefined,
            appUrl:      configuredAppUrl,
          },
        );
      });
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
        // After a successful test run, offer to open the HTML report (in modal and on main card)
        if (currentRunConfig && currentRunConfig.workflow === 'run-tests') {
          lastTestRunWorkingDir = currentRunConfig.workingDir || null;
          document.getElementById('open-report-btn').style.display = 'inline-block';
          document.getElementById('btn-open-last-report').style.display = 'block';
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
        // Even on failure, offer report — partial results are still useful
        if (currentRunConfig && currentRunConfig.workflow === 'run-tests') {
          lastTestRunWorkingDir = currentRunConfig.workingDir || null;
          document.getElementById('open-report-btn').style.display = 'inline-block';
          document.getElementById('btn-open-last-report').style.display = 'block';
        }
      }
    });

    // ── Update socket events ─────────────────────────────────────────────────

    // Streams a single line of update output into the update modal terminal.
    socket.on('update:log', function(data) {
      var terminal = document.getElementById('update-terminal');
      if (!terminal) return;
      var line = document.createElement('div');
      line.style.cssText = 'font-family: monospace; font-size: 0.82rem; color: #c9d1d9; padding: 1px 0; white-space: pre-wrap; word-break: break-all;';
      line.textContent = data.message;
      terminal.appendChild(line);
      terminal.scrollTop = terminal.scrollHeight;
    });

    // Called when the portable bundle download finishes (success or failure).
    socket.on('update:complete', function(data) {
      var spinnerEl = document.getElementById('update-modal-spinner');
      var doneBar   = document.getElementById('update-done-bar');
      var doneMsg   = document.getElementById('update-done-msg');
      if (spinnerEl) spinnerEl.style.display = 'none';
      if (doneBar)   doneBar.style.display   = 'flex';
      if (doneMsg) {
        if (data.success) {
          doneMsg.className   = 'run-result-success';
          doneMsg.textContent = data.message || '\u2705 Update downloaded. Restart EZTest to apply it.';
        } else {
          doneMsg.className   = 'run-result-failure';
          doneMsg.textContent = data.message || '\u274C Update failed — see log above.';
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
      document.getElementById('btn-run-tests').addEventListener('click', handleRunTestsFromCard);
      document.getElementById('btn-mcp-setup').addEventListener('click', handleMcpSetup);
      document.getElementById('btn-open-last-report').addEventListener('click', handleOpenLastReport);

      // API key settings modal
      document.getElementById('btn-api-settings').addEventListener('click', openApiKeySettings);
      document.getElementById('api-key-cancel-btn').addEventListener('click', closeApiKeySettings);
      document.getElementById('api-key-save-btn').addEventListener('click', saveApiKeySettings);
      document.getElementById('api-key-remove-btn').addEventListener('click', removeApiKey);
      document.getElementById('settings-provider-select').addEventListener('change', updateSettingsKeyRowVisibility);
      // Clicking the backdrop (outside the card) closes the modal
      document.getElementById('api-key-overlay').addEventListener('click', function(clickEvent) {
        if (clickEvent.target === this) { closeApiKeySettings(); }
      });

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

      // Update banner buttons
      document.getElementById('update-install-btn').addEventListener('click', openUpdateModal);
      document.getElementById('update-dismiss-btn').addEventListener('click', dismissUpdateBanner);

      // Boot the app
      initApp();
    });
  </script>

</body>
</html>`;
}
