# Changelog — EZTest

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.3] - 2026-04-25

### Changed
- **Launcher update mechanism — no more PowerShell** — `TryApplyPendingUpdate` now performs the staged update using pure .NET `File.Move` / `File.Copy` / `Directory.Move` operations. The previous approach wrote a `.ps1` script to `%TEMP%` and executed it with `powershell.exe -ExecutionPolicy Bypass`, which triggered Windows Defender and other AV heuristics. The new implementation is zero-script: it renames existing items to `.rollback`, installs new items from the staged bundle, launches the new EZTest.exe, and exits. Rollbacks are cleaned up on the next launch.
- **ZIP extraction — no more PowerShell** — The in-app update downloader (`extractPortableArchive`) now uses the Windows built-in `tar.exe` (available since Windows 10 1803) instead of `powershell Expand-Archive -ExecutionPolicy Bypass`.
- **Windows application manifest embedded in EZTest.exe** — the launcher is now compiled with `/win32manifest:EZTest.manifest`. The manifest declares `requestedExecutionLevel="asInvoker"`, Windows 10/11 OS compatibility GUIDs, and DPI awareness settings. These are standard legitimacy signals that AV engines use to reduce suspicion of unsigned binaries.
- **Assembly metadata embedded** — EZTest.exe now carries `AssemblyTitle`, `AssemblyDescription`, `AssemblyCompany`, `AssemblyProduct`, `AssemblyCopyright`, `AssemblyVersion`, and `AssemblyFileVersion` attributes, visible in Windows Explorer → Properties → Details.
- **Version set to `0.1.3`** in `package.json`, `package-lock.json`, `src/cli/index.ts`, `src/mcp/server.ts`, and `launcher/EZTestLauncher.cs`.

## [0.1.2] - 2026-04-16

### Added
- **Portable Windows release bundle** — `build:portable` now creates `release/EZTest-windows-portable.zip`, a self-contained Windows bundle that includes `EZTest.exe`, the compiled `dist/` runtime, `node_modules/`, `package.json`, docs, and a bundled `node.exe`. Users can extract it anywhere and launch EZTest without cloning the repo or installing Node globally.
- **Pure portable-release helper module + unit tests** — release asset selection and semver comparison now live in `src/shared/portableRelease.ts`, covered by `tests/unit/portableRelease.spec.ts`.

### Changed
- **Version set to `0.1.2`** in `package.json`, `package-lock.json`, `src/cli/index.ts`, and `src/mcp/server.ts`.
- **`EZTest.exe` launcher now targets a portable bundle instead of a repo layout** — it validates the extracted bundle, prefers a bundled `node.exe`, waits for the local UI server to become ready before opening the browser, and supports extracted folders anywhere on disk.
- **In-app updates now stage the next portable bundle** — the dashboard update flow no longer runs `git pull` / `npm install`. It downloads `EZTest-windows-portable.zip` from GitHub releases, extracts it into `updates/pending-portable-update`, and applies it on the next app launch.

### Fixed
- **"EZTest.exe must be inside the project directory" launch failure** — the launcher no longer assumes a source-repo folder structure, so users can keep EZTest on the Desktop, in Downloads, or any other extracted directory.

## [0.1.1] - 2026-04-13

### Added
- **"Set Up EZTest In My IDE" card on the main page** — a fifth dashboard card that opens a plain-English MCP helper for VS Code, Cursor, Windsurf, and Claude Code. Users now get copy-ready setup snippets with the exact local Node.js and EZTest MCP paths already filled in, so IDE setup is reduced to: pick your IDE → copy → paste → save.

### Changed
- **Version set to `0.1.1`** in `package.json`, `package-lock.json`, `src/cli/index.ts`, and `src/mcp/server.ts`.
- **Generate / Preview / Run Tests now require a real app URL in the UI** — EZTest prompts for the browser URL before starting these workflows instead of silently falling back to unusable guesses like `http://localhost:3000` or relative Jira paths.

### Fixed
- **Forge app navigation URLs** — relative Jira paths are now resolved against the configured app URL before they reach generated tests, preventing invalid `page.goto('/jira/...')` navigations.

## [0.1.0] - 2026-04-13

### Added
- **`eztest mcp` command** — starts the EZTest MCP server over stdio, exposing all three EZTest engines as Model Context Protocol tools. Any MCP-capable IDE (VS Code GitHub Copilot, Cursor, Claude Code, Windsurf) can now invoke EZTest capabilities directly without leaving the editor.
- **`eztest-mcp` binary** — dedicated standalone entry point (`npx eztest-mcp`) for IDE MCP client configuration. IDEs launch this as a subprocess; it handles the stdio JSON-RPC transport automatically.
- **`src/mcp/server.ts`** — MCP Server implementation using `@modelcontextprotocol/sdk`. Registers and handles all six tools. All EZTest log output is redirected to stderr on startup to prevent JSON-RPC stream corruption.
- **`src/mcp/sessionStore.ts`** — in-memory recording session store. Tracks the lifecycle (`running → completed | error`) of browser recording sessions started via the `start_recording` MCP tool, enabling the non-blocking `start_recording` / `get_recording` handshake pattern.
- **`src/mcp/index.ts`** — standalone entry point for the `eztest-mcp` binary.
- **`src/cli/commands/mcp.ts`** — CLI command registration for `eztest mcp`.
- **`redirectLoggingToStderr()` in `logger.ts`** — new export that switches all `logInfo` / `logSuccess` / `logDebug` output from stdout to stderr. Required for MCP stdio mode where stdout is reserved for JSON-RPC messages.
- **Six MCP tools**:
  | Tool | Description |
  |---|---|
  | `analyze_source` | AST-scan a source directory; returns component + element summary |
  | `generate_tests` | Full pipeline: source → user flows → Playwright `.spec.ts` files |
  | `start_recording` | Launch browser with annotation overlay (non-blocking, returns sessionId) |
  | `get_recording` | Poll recording session for status and completed bug reports |
  | `reproduce_bug` | Generate + run a failing Playwright test from a bug report |
  | `fix_and_validate` | Full autonomous loop: reproduce → AI fix → validation suite |

### Changed
- **Version set to `0.1.0`** in `package.json`, `src/cli/index.ts`, and `src/mcp/server.ts`.
- **`logInfo` / `logSuccess` / `logDebug`** now route through an internal `writeLog()` helper that writes to stderr when `redirectLoggingToStderr()` has been called (MCP mode), otherwise to stdout (CLI mode as before). `logWarning` / `logError` already wrote to stderr and are unchanged in behavior.

### Fixed
- **Shallow "smoke test" generation** — generated tests were trivially asserting that pages load without crashing instead of testing real user behavior. Root cause: the test code generation prompt received only text descriptions of flow steps but no element metadata (aria-labels, testIds, handler names, source code). The AI had to guess selectors, so it fell back to the safest possible assertion: "page is visible." Three fixes applied:
  1. **`targetElementDescription` preserved** — `normalizeAiGeneratedFlow()` in `flowMapper.ts` now passes through the AI's text description of target elements instead of discarding it
  2. **Element context injected into test generation prompt** — `buildTestCodeGenerationPrompt()` in `promptTemplates.ts` now accepts and formats `involvedComponentAnalyses` with full element metadata (role, text, aria-label, testId, handler, classes) and a truncated source excerpt per component, giving the AI concrete selectors to write against
  3. **Anti-smoke-test instructions** — the prompt now explicitly forbids tests that only navigate + check visibility, forbids catch-all regex matchers, and requires every test to interact with elements and assert on specific outcomes
- **Component analyses threaded to test generation** — `generateTestsForFlows()` in `testGenerator.ts` now accepts optional `componentAnalyses` and builds a per-flow lookup map to resolve `involvedComponents` names to their full `ComponentAnalysis` data. Both the CLI (`generate.ts`) and MCP server (`server.ts`) pass component analyses through.
- **Quota-aware assertion review** — when running on the GitHub Models free tier (`github` provider), the `generate` command now estimates total API calls before test generation starts. If the assertion review pass would push remaining calls above 45 (the HIGH-tier daily quota), review is auto-disabled to avoid cascading through multiple model quotas. Users see a clear warning explaining the savings and can force-enable review with explicit flags.
- **Pre-flight API call estimation** — the `generate` command now logs estimated remaining API calls (test generation + optional review) before starting, so users on free tiers can anticipate quota usage and rotation.
- **Improved quota-exhaustion error messages** — both the flow-mapping catch block and the all-models-exhausted error in `aiClient.ts` now suggest actionable options: `--no-review`, `--max-flows`, `EZTEST_AI_PROVIDER=copilot` (for Copilot Pro users), and paid provider configuration.
- **Fixed `.env` misconfiguration** — changed `EZTEST_AI_PROVIDER=openai` to `github`. The previous value caused config resolution to look for a non-existent `OPENAI_API_KEY`, then fall through to the `github` provider silently. The explicit value now matches the actual provider used.

### Added
- **GitHub Copilot Chat API provider (`EZTEST_AI_PROVIDER=copilot`)** — new provider that calls `api.githubcopilot.com` instead of the GitHub Models API. Delivers 16 384 output tokens per call (4× the GitHub Models free-tier cap) using only 0x-premium models, eliminating most dynamic batch-splitting overhead.
- **`AiClient.rotationSize` and `AiClient.hasFreeTierQuotaLimits` getters** — expose model rotation metadata so the `generate` command can make quota-aware decisions (e.g., auto-disabling review) without coupling to provider internals.
- **`GITHUB_FREE_TIER_QUOTA_THRESHOLD` constant in `generate.ts`** — set to 45, used by the quota-aware review logic to decide when auto-disabling review would prevent quota churn.
- **`src/shared/copilotAuth.ts`** — Copilot OAuth token manager: calls `gh auth token` to read the keyring-stored OAuth token (with `copilot` scope), caches it for 30 minutes to avoid repeated subprocess spawns. All helpers are exported for testability; the injected `tokenFetcher` parameter enables unit tests without the real `gh` CLI.
- **`COPILOT_FREE_MODEL_ROTATION`** in `config.ts` — ordered model rotation for Copilot Pro/Pro+: `['gpt-4.1', 'gpt-5-mini', 'gpt-5.4-mini', 'claude-sonnet-4.6']`. Prioritizes 0x-premium models first, then cost-efficient fallbacks.
- **2-model rotation for copilot provider** — `buildModelRotationList()` now branches on `provider === 'copilot'` the same way it does for `provider === 'github'`, so `gpt-4.1` exhaustion automatically falls back to `gpt-5-mini`.
- **Copilot provider in `.env.example`** — documents `EZTEST_AI_PROVIDER=copilot` with setup instructions (`gh auth login`) and a note that no separate API key is needed.
- **11 new unit tests in `copilotAuth.spec.ts`** — covers `parseTokenResponse` (valid, missing fields, invalid JSON), `getCopilotSessionToken` (cache hit, cache miss, near-expiry refresh, expired token refresh, error propagation), and `clearCopilotTokenCache` (forces re-fetch).
- **"Run Your Tests" card on main page** — persistent 4th card in the action grid so tests can be run at any time without re-generating. Spawns `npx playwright test` in the project root, streams results live to the terminal modal.
- **"Open last report" link on Run Tests card** — appears after any test run and stays visible after the modal closes, so the Playwright HTML report is always one click away.
- **Run Tests from UI** — after a successful test generation, a "▶ Run Tests" button appears in the modal done bar.
- **Open Playwright HTML Report button** — after a test run completes (pass or fail), a "📊 Open Report" button appears. Clicking it calls `POST /api/open-report` which opens `playwright-report/index.html` in the default browser via `cmd /c start`.
- **`spawnAndStreamProcess()` helper in `uiServer.ts`** — shared streaming infrastructure used by both EZTest CLI runs and Playwright test runs, eliminating duplicate spawn/stream logic.
- **`run-tests` workflow in `RunConfig`** — the run config union type now includes `'run-tests'` and an optional `workingDir` field so the server knows which project root to use for Playwright.
- **Progress bar in run modal** — live progress indicator with per-stage labels (`Analyzing source code` → `Mapping N/M batches` → `Writing test N/M`) and a live countdown timer during API rate-limit retries.
- **Per-flow write logging in `testGenerator.ts`** — `logInfo("Writing test N/M: flowName")` fires before each AI call so the progress bar advances steadily through the generation phase.
- **Dynamic token-aware batch splitting in `flowMapper.ts`** — `splitIntoDynamicBatches()` replaces the old fixed-size batch splitter. Each batch is sized based on the estimated number of output tokens the AI will produce, keeping every API call under 90% of the 4096-token Copilot Pro output cap.
- **`estimateComponentOutputTokens()` helper** — estimates output tokens per component: `max(1, ceil(elements/2)) × 3 variants × 220 tokens/variant`. Both functions are exported and unit-tested.
- **Per-batch token budget logging** — each batch logs its component count and estimated output tokens so users can see why components were grouped together.
- **10 new unit tests in `flowMapper.spec.ts`** covering `estimateComponentOutputTokens` and `splitIntoDynamicBatches`.

### Changed
- **`FLOW_MAPPING_BATCH_SIZE` constant removed** — replaced by `TARGET_BATCH_OUTPUT_TOKENS = 3600`, `BATCH_RESPONSE_OVERHEAD_TOKENS = 200`, and `ESTIMATED_TOKENS_PER_FLOW_VARIANT = 220`.

- **Automatic model rotation on quota exhaustion** — when a GitHub Models model exhausts its daily quota, EZTest automatically rotates to the next model in the `GITHUB_FREE_MODEL_ROTATION` list instead of failing. Test generation continues uninterrupted across up to 19 different free-tier models (OpenAI gpt-4.1/4o/mini/nano, Meta Llama 4 Scout/Maverick/3.3-70B/405B, DeepSeek-V3, Mistral Medium/Small/Codestral, AI21 Jamba, Cohere, Phi-4, and gpt-5-mini for Copilot Pro users).
- **`GITHUB_FREE_MODEL_ROTATION` constant in `config.ts`** — ordered list of all non-premium GitHub Models model IDs, arranged by quality tier (HIGH 50/day before LOW 150/day) with clear comments explaining the reasoning for each model's position.
- **`ModelQuotaExhaustedError` class in `aiClient.ts`** — exported error type thrown by `executeWithRetry` when quota exhaustion is detected. Carries `exhaustedModelName` and `secondsUntilReset` for precise UI messaging. `AiClient.chat()` catches this internally; callers only see it if all 19 models are exhausted.
- **`extractRetryAfterSeconds()` helper** — extracts the raw seconds value from the retry-after header without filtering, enabling `ModelQuotaExhaustedError` to show users an accurate reset countdown.
- **`buildModelRotationList()` helper** — constructs the model rotation array from `AiConfig`: full rotation for GitHub provider, single-model list for OpenAI/Anthropic. If a `modelOverride` is set, the rotation starts at that model's position and falls through.

### Changed
- **`getDefaultModelForProvider('github')`** now returns `GITHUB_FREE_MODEL_ROTATION[0]` (`gpt-4.1`) instead of the hard-coded `'gpt-4o'`, keeping the default in sync with the rotation list priority order.
- **`AiClient` class** replaces `resolvedModelName: string` with `modelRotationList: readonly string[]` + `activeModelIndex: number`. The `modelName` getter now returns the currently active model (which changes as models are rotated).
- **`executeWithRetry`** now accepts a `currentModelName: string` parameter and throws `ModelQuotaExhaustedError` on quota exhaustion instead of `break`-ing out of the retry loop and re-throwing a raw API error.
- **Quota exhaustion warning message** in `extractRetryAfterDelayMs` updated from "Switch to a different AI provider" to "EZTest will automatically try the next available model in the free-tier rotation."

- **`DEFAULT_MAX_FLOW_COUNT = 10` in `generate.ts`** — caps the number of user flows to generate tests for (default: 10). GitHub Models free tier allows ~10 requests/minute; without this cap, 30+ flows generate 30+ sequential API calls and can take 15+ minutes to complete.
- **`FLOW_MAPPING_BATCH_SIZE = 40` in `flowMapper.ts`** — all components are sent in one batch for flow generation (down from many small batches), dramatically reducing the number of API calls per run.
- **`FLOW_GENERATION_SYSTEM_PROMPT`** — compact ~150-token system prompt specifically for the flow-mapping stage, replacing the full `BEHAVIORAL_QA_SYSTEM_PROMPT` (~875 tokens) that was causing GitHub Models 8K token limit failures when combined with 20+ component element lists.
- **Quota exhaustion detection in `aiClient.ts`** — when GitHub Models returns a `retry-after` header greater than 5 minutes (indicating the daily free-tier quota is exhausted), EZTest immediately fails with an actionable error message. Previously would wait 23 hours.
- **`hasRetryAfterHeader()` helper** — distinguishes between "no retry info" (use exponential backoff) and "quota exhausted" (fail fast with guidance).
- **`MAX_RETRYABLE_DELAY_MS = 300_000`** — 5-minute ceiling for retry-after values; anything longer signals daily quota exhaustion.
- **Extended `isTransientApiError`** to include GitHub Models 413 `tokens_limit_reached` as retryable.
- **Smart priority-based file selection in `analyzeSourceDirectory`**— files are now scored and sorted by UI importance before the `maxFileCount` limit is applied, so the most valuable files (pages, routes, dashboards, login screens, forms) are always analyzed first instead of relying on arbitrary filesystem order.
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
