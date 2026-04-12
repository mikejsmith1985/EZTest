# Changelog — EZTest

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
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
