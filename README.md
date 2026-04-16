# EZTest

> AI-powered behavioral testing companion for Playwright.
> Tests that validate what users **see and experience** — not what functions get called.

---

## The Problem

Most AI-generated tests look like this:

```ts
expect(mockSubmitHandler).toHaveBeenCalledWith({ name: 'Alice' }); // ❌ Tests code, not behavior
```

EZTest generates tests that look like this:

```ts
await page.getByRole('button', { name: 'Submit' }).click();
await expect(page.getByRole('alert')).toHaveText('Order placed!'); // ✅ Tests what users see
```

---

## How It Works

EZTest has two engines and a feedback loop:

```
┌──────────────────────┐    ┌──────────────────────────────┐
│  AI Test Synthesizer │    │  Smart Session Recorder      │
│                      │    │                              │
│  Source code →       │    │  Playwright browser +        │
│  user flow analysis →│    │  injected annotation UI →    │
│  Playwright .spec.ts │    │  structured BugReport JSON   │
└──────────────────────┘    └──────────┬───────────────────┘
                                       ↓
                            ┌──────────────────────────────┐
                            │  Agent Feedback Loop         │
                            │                              │
                            │  BugReport → failing test    │
                            │  → AI code fix               │
                            │  → positive + negative suite │
                            └──────────────────────────────┘
```

---

## Installation

### Windows portable app

Download **`EZTest-windows-portable.zip`** from the latest GitHub release, extract it anywhere you want, and launch **`EZTest.exe`** from that extracted folder.

**Portable bundle requirements:**
- No repo checkout required
- No special folder name required
- No system-wide Node.js install required

### npm / npx

```bash
npm install -g eztest
# or use locally
npx eztest --help
```

**CLI requirements:**
- Node.js 18+
- An OpenAI or Anthropic API key
- A Playwright-compatible app running locally

---

## Quick Start

### Option A — Double-click portable app (no terminal required)

Open the extracted portable folder and double-click **`EZTest.exe`**. It will:
1. Start the EZTest local UI server
2. Open your browser automatically
3. Keep its own settings inside the extracted bundle folder

When EZTest offers an update, it downloads the next portable bundle for you and applies it on the next launch.

### Option B — Command line

Point EZTest at your source code and a running app URL. It reads your components, infers what users can do, and writes Playwright tests:

```bash
eztest generate --source ./src --url http://localhost:3000 --output ./tests/e2e
```

**Output:** One `.spec.ts` file per user flow. Each file contains behavioral assertions — no mocks, no implementation coupling.

### 2. Record a session and flag unexpected behavior

Open your app in an EZTest-instrumented browser. A floating 🚩 button appears. Work normally. When something unexpected happens, click 🚩 and describe what you expected:

```bash
eztest record --url http://localhost:3000 --source ./src
```

This creates a `BugReport` JSON file in your project with:
- The full interaction history (clicks, inputs, navigation)
- DOM state before/after each action
- A screenshot at the moment you flagged the issue
- Your description of the expected behavior

### 3. Run the autonomous fix loop

Give EZTest the bug report and let it work:

```bash
eztest replay --report ./bug-reports/bug-report-abc123.json \
              --source ./src \
              --url http://localhost:3000
```

EZTest will:
1. **Reproduce** — generate a Playwright test that fails (confirming the bug)
2. **Fix** — analyze your source code and apply a targeted AI-generated fix
3. **Validate** — run a positive + negative test suite to confirm the fix is complete

---

## Configuration

Create `eztest.config.json` in your project root (all fields optional):

```json
{
  "ai": {
    "provider": "openai",
    "modelOverride": "gpt-4o",
    "maxTokensPerCall": 4096,
    "maxRetryAttempts": 3
  },
  "globalExcludePatterns": [
    "**/node_modules/**",
    "**/dist/**",
    "**/*.test.*"
  ],
  "maxComponentCount": 50,
  "forgeTerminalWebhookUrl": "http://localhost:3001/webhook/eztest"
}
```

### Environment Variables

| Variable | Description |
|---|---|
| `OPENAI_API_KEY` | OpenAI API key (auto-selects OpenAI provider) |
| `ANTHROPIC_API_KEY` | Anthropic API key (auto-selects Anthropic provider) |
| `EZTEST_AI_PROVIDER` | Override provider: `openai` or `anthropic` |
| `EZTEST_AI_MODEL` | Override model (e.g., `gpt-4o-mini`, `claude-3-haiku-20240307`) |

---

## MCP Server — IDE Integration

EZTest exposes all three engines as [Model Context Protocol](https://modelcontextprotocol.io) tools. Any MCP-capable IDE can call them directly, letting the IDE's AI agent orchestrate your testing workflow conversationally.

If you launched EZTest in the browser UI, click **Set Up EZTest In My IDE** on the home screen. EZTest will show a copy-ready setup snippet for VS Code, Cursor, Windsurf, or Claude Code with the correct local paths already filled in.

### Available Tools

| Tool | What it does |
|---|---|
| `analyze_source` | AST-scan a source directory and return a structured UI element summary |
| `generate_tests` | Full pipeline: source code → user flows → Playwright `.spec.ts` files |
| `start_recording` | Open your app in a recording browser with the 🚩 annotation overlay (non-blocking) |
| `get_recording` | Poll a recording session for status and retrieve completed bug reports |
| `reproduce_bug` | Generate + run a failing Playwright test from a bug report |
| `fix_and_validate` | Full autonomous loop: reproduce bug → AI fix → validation suite |

### IDE Setup

**VS Code (GitHub Copilot)**

Add to `.vscode/mcp.json` in your project:

```json
{
  "servers": {
    "eztest": {
      "type": "stdio",
      "command": "npx",
      "args": ["eztest-mcp"]
    }
  }
}
```

**Cursor / Windsurf**

Add to your global `~/.cursor/mcp.json` (or `~/.windsurf/mcp.json`):

```json
{
  "mcpServers": {
    "eztest": {
      "command": "npx",
      "args": ["eztest-mcp"]
    }
  }
}
```

**Claude Code**

```bash
claude mcp add eztest -- npx eztest-mcp
```

**Local install (faster cold start)**

```bash
npm install -g eztest
# then use "eztest-mcp" instead of "npx eztest-mcp" in the config above
```

### Example IDE Conversation

Once configured, you can ask your IDE agent:

> *"Analyze my ./src directory and tell me what user flows exist"*
> *"Generate Playwright tests for my app at http://localhost:3000"*
> *"Start a recording session so I can flag a bug I found"*
> *"Take the bug report I just flagged and fix it automatically"*

The agent calls the appropriate EZTest tools, feeds you progress updates, and delivers the results — no terminal required.

---

## Commands

### `eztest mcp`

Start the EZTest MCP server over stdio (for IDE integration).

```
# Typically launched automatically by your IDE — see IDE Setup above.
# To start manually for testing:
eztest mcp
```

---


### `eztest generate`

Analyze source code and generate Playwright behavioral tests.

**Important:** always provide the real browser URL for your app. For Jira Forge apps, use the full Atlassian page URL, not a relative `/jira/...` path.

```
Options:
  -s, --source <dir>          Source code directory (default: ./src)
  -u, --url <url>             App URL (default: http://localhost:3000)
  -o, --output <dir>          Output directory (default: ./tests/e2e)
  --no-edge-cases             Only generate happy-path tests
  --max-components <n>        Limit components analyzed (default: 50)
  --dry-run                   Print generated tests to stdout, don't write files
  -v, --verbose               Enable debug logging
```

### `eztest record`

Open your app in a recording session with the annotation overlay injected.

```
Options:
  -u, --url <url>             App URL (default: http://localhost:3000)
  -s, --source <dir>          Source code directory for fix context
  -o, --output <dir>          Where to save bug reports (default: ./bug-reports)
  -v, --verbose               Enable debug logging
```

### `eztest replay`

Run the full reproduce → fix → validate loop from a saved bug report.

```
Options:
  -r, --report <path>         Path to BugReport JSON file (required)
  -s, --source <dir>          Source code directory (default: ./src)
  -u, --url <url>             App URL (default: http://localhost:3000)
  --working-dir <dir>         Project root with playwright.config.ts (default: .)
  --skip-fix                  Only reproduce, do not fix
  --skip-validation           Fix but skip the validation suite
  -v, --verbose               Enable debug logging
```

---

## AI Capabilities and Limitations

### What AI Does Well Here
- Inferring user intent from aria labels, text content, handler names
- Generating Playwright code once given a clear user-flow description
- Root cause analysis when given a failing test + source code context
- Generating edge cases once the main scenario is understood

### Known Limitations (and Mitigations)

| Limitation | How EZTest Handles It |
|---|---|
| Can't verify visual correctness | Screenshot captured at flag moment for context |
| Doesn't know business rules | User describes expected behavior in annotation |
| Stateful flows are hard to reconstruct | Full interaction history recorded, not just the bug moment |
| AI may generate wrong selectors | Tests use accessible role/label selectors by default |
| Fix may not be complete on first try | Validation suite catches regressions |

---

## Supported Frameworks

EZTest's code analyzer uses Babel's AST parser and supports:

| Framework | Status |
|---|---|
| React / JSX | ✅ Full support |
| TypeScript / TSX | ✅ Full support |
| Next.js (file-based routing) | ✅ Works via React support |
| Vue (`.vue` files) | 🔜 Planned |
| Angular | 🔜 Planned |
| Svelte | 🔜 Planned |

---

## Forge Terminal Integration

EZTest is designed to work alongside [Forge Terminal](https://forge.dev). When a recording session produces a bug report:

1. If `forgeTerminalWebhookUrl` is configured, EZTest POSTs the bug report directly to your Forge Terminal instance
2. Otherwise, EZTest writes a structured agent prompt to `.forge/pending-tasks/` which Forge Terminal monitors automatically

The agent prompt includes step-by-step instructions: write failing test → fix code → run validation → summarize.

---

## Architecture

```
src/
├── synthesizer/          # Phase 1: AI Test Synthesizer
│   ├── codeAnalyzer.ts   # Babel AST → interactive element extraction
│   ├── flowMapper.ts     # AI-powered component → user journey mapping
│   ├── promptTemplates.ts # All AI prompts (carefully engineered for behavioral QA)
│   └── testGenerator.ts  # Writes Playwright .spec.ts files
├── recorder/             # Phase 2: Smart Session Recorder
│   ├── sessionRecorder.ts # Playwright browser + CDP recording
│   ├── annotationServer.ts # Local Express + Socket.io server
│   ├── overlay/          # Vanilla JS overlay injected into target app
│   └── bugReportBuilder.ts # Assembles BugReport from session data
├── agentLoop/            # Phase 3: Autonomous Feedback Loop
│   ├── testRunner.ts     # Programmatic Playwright test execution
│   ├── testReproducer.ts # Generates + runs reproduction test
│   ├── codeFixAgent.ts   # AI code fix analysis and application
│   ├── validationSuite.ts # Post-fix positive + negative test suite
│   └── forgeIntegration.ts # Delivers reports to Forge Terminal
├── cli/
│   ├── commands/         # generate, record, replay commands
│   └── index.ts          # CLI entry point (Commander)
└── shared/
    ├── types.ts           # All domain types
    ├── config.ts          # Config loader (file + env vars)
    ├── aiClient.ts        # Unified OpenAI/Anthropic adapter with retry
    └── logger.ts          # Structured logger
```

---

## License

MIT
