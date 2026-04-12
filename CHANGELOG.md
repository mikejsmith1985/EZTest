# Changelog — EZTest

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
