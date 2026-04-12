# Changelog — EZTest

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **Smart priority-based file selection in `analyzeSourceDirectory`** — files are now scored and sorted by UI importance before the `maxFileCount` limit is applied, so the most valuable files (pages, routes, dashboards, login screens, forms) are always analyzed first instead of relying on arbitrary filesystem order.
  - New `scoreFileByImportance` function assigns scores 100–10 based on directory name (`pages`, `routes`, `views`, `screens`, `app`), exact component name (`Login`, `Dashboard`, `Cart`, etc.), filename suffix (`Page`, `Screen`, `Form`, `Modal`), and path depth.
  - New `calculatePathDepth` helper breaks ties within the same score tier by preferring shallower files.
- **Extended glob exclude patterns** in `discoverSourceFiles` — Storybook stories, TypeScript declaration stubs, minified bundles, build output directories (`.next`, `build`, `out`, `vendor`, `.turbo`), and mock/fixture directories are now always excluded regardless of project config.
- **Extended `globalExcludePatterns` in `config.ts`** — same additional patterns are also part of the default config so CLI users benefit without any manual configuration.

### Changed
- **`DEFAULT_MAX_COMPONENT_COUNT`** raised from 50 → 400 in `generate.ts` to support large codebases now that priority scoring ensures only the most important files fill the budget.
- **`maxFileCount`** raised from 50 → 200 in `testPlanner.ts` for the same reason.
- **Truncation log message** changed from a `logWarning` ("Analyzing first N files") to a `logInfo` ("prioritized top N files by UI importance") — it is informational, not an error condition.

### Fixed
- **`parseSourceFile` crash on unreadable files** — `readFileSync` was outside the try/catch block, so permission errors, locked files, or overly-long paths on Windows would throw all the way to the caller and abort the entire analysis run. It is now inside the try/catch and produces a graceful warning instead.


- **Blank page on launch** — unescaped apostrophe in handleRecord's description string (pp's) caused a JavaScript syntax error that silently crashed the entire script block before the page could render; fixed by changing the string delimiter to double quotes
- **GitHub Copilot not detected in UI** — dotenv was installed but never called, so .env was never loaded and process.env.EZTEST_GITHUB_TOKEN was always undefined; added import 'dotenv/config' as the very first import in src/cli/index.ts so every module sees the correct environment values on startup

### Changed
- **Complete UI overhaul — EZTest is now an application, not a wizard** — replaced the 4-step wizard with a full app-style interface: persistent app bar with project pill, dashboard with 3 plain-English action cards, native Windows folder picker, and an auto-showing onboarding overlay on first launch (just like any well-designed app)
  - **No typing required** — folder picker and file picker dialogs open natively via Windows Forms; URL fields are pre-filled from the last session
  - **3 action cards with plain-English explanations** — "Write Tests For My App" (AI reads code, writes behavioral tests), "Record a Testing Session" (flag broken things in a live browser), and "Fix a Failing Test" (find + fix + validate); each card explains what it does and when to use it
  - **Auto-onboarding on first launch** — step 1 picks the project folder and immediately shows what EZTest detected (framework, language, file counts); step 2 shows the AI provider already connected or asks for a key; onboarding is skippable on return visits
  - **Project summary bar** — shows project name, framework, language, source file count, and existing test count at the top of every session
  - **`POST /api/browse-folder`** — opens a native Windows FolderBrowserDialog via PowerShell (no SDK required); returns the selected path to the browser
  - **`POST /api/browse-file`** — opens a native Windows OpenFileDialog for selecting report JSON files
  - **`GET|POST /api/app-config`** — persists the user's selected project path and app URL to `app-config.json`; also returns a real-time scan of the selected project (framework detection, file counts) on every GET
  - **`app-config.json`** added to `.gitignore` (stores user-specific project path, never committed)

### Added
- **`EZTest.exe` — native Windows double-click launcher** — compiled C# WinForms application that starts the EZTest wizard server silently in the background and opens `http://localhost:7433` in your default browser; detects the EZTest root folder automatically by walking up from the exe location; prompts for first-time build if `dist/` is missing; no terminal window, no VBScript, no manual setup; rebuild anytime via `npm run build:launcher` (requires no .NET SDK — uses the .NET Framework compiler built into Windows)
- **`launcher/EZTestLauncher.cs`** — C# source for the launcher; `launcher/build.ps1` — PowerShell build script using `csc.exe` from .NET Framework 4.x
- **`EZTest.vbs` — no-terminal double-click launcher** — opens the wizard in your browser without showing any command-prompt window; handles first-time `npm install + build` automatically with friendly dialogs; validates Node.js is installed before attempting to run
- **GitHub Copilot provider support** — use your existing Copilot subscription instead of paying for a separate API key; set `EZTEST_GITHUB_TOKEN` in `.env` and EZTest routes all AI calls through GitHub Models API (`https://models.inference.ai.azure.com`) using the OpenAI-compatible spec; wizard provider dropdown now lists GitHub Copilot as the recommended option; token auto-detected from `EZTEST_GITHUB_TOKEN` or `GITHUB_MODELS_TOKEN` env vars with highest priority over OpenAI/Anthropic
- **Feedback loop system** (`eztest-feedback.json`) — EZTest now maintains a project learning file that records selector fixes, confirmed expectations, and false positive flags, then injects them into AI prompts at generation time so test quality improves over time
  - `src/synthesizer/feedbackStore.ts` — reads/writes `eztest-feedback.json`; exports `readProjectFeedback`, `writeProjectFeedback`, `recordSelectorFix`, `recordFalsePositive`, `recordConfirmedExpectation`, and `formatFeedbackForPrompt`
  - `buildFeedbackContextSection()` in `promptTemplates.ts` — formats feedback into an AI prompt injection section
  - `feedbackContext` parameter on `buildTestCodeGenerationPrompt()` — allows caller to inject project learnings at test generation time
  - `src/cli/commands/feedback.ts` — `eztest feedback` command with `--show`, `--flag-false-positive`, `--confirm-expectation`, and `--clear` options

### Added
- Enterprise workflow initialized with Forge Terminal Workflow Architect
- **EZTest v0.1.0** — AI-powered behavioral testing companion
  - `eztest generate` — AI Test Synthesizer: reads source code, maps user flows, generates Playwright behavioral tests
  - `eztest record` — Smart Session Recorder: Playwright-driven browser with injected annotation overlay for flagging unexpected results
  - `eztest replay` — Autonomous Agent Feedback Loop: reproduce → AI code fix → validation suite
  - **Session recorder click/input tracking**: overlay now injects `click` and `change` DOM event listeners; interactions are POSTed to `POST /api/interaction` on the annotation server, emitted via Socket.io `interaction:recorded`, and recorded in the session's `interactionHistory` with DOM snapshots
  - Agent Feedback Loop: structured BugReport → Forge Terminal agent integration for autonomous test generation, code fixing, and validation
  - Shared AI client abstraction supporting OpenAI (GPT-4o default) and Anthropic (Claude Sonnet default)
  - Code Analyzer: AST-based interactive element extraction from React/JSX/TSX source files
  - User Flow Mapper: AI-assisted component-to-journey mapping
  - Test Generator: AI prompt templates engineered for behavioral (not implementation) test output
  - Annotation Server: local Express + Socket.io server for browser overlay communication
  - Test Reproducer: generates and runs a Playwright test that fails to confirm a bug is reproducible
  - Code Fix Agent: reads source files, identifies root cause via AI, applies targeted search/replace fix
  - Validation Suite Generator: post-fix positive + negative test suite generation and execution
  - Playwright `e2e` project configuration for reproduction and validation tests
  - 69 unit tests covering: BugReport builder, config loader, code analyzer, test reproducer, code fix agent, flow mapper, test generator, validation suite, and Forge Terminal integration
  - `README.md` with full usage guide, architecture overview, and AI capability assessment

### Changed

### Fixed

### Removed
