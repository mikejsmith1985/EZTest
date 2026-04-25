/**
 * EZTest MCP Server.
 *
 * Exposes EZTest's three core engines — AI Test Synthesizer, Smart Session Recorder,
 * and Autonomous Feedback Loop — as Model Context Protocol tools. Any MCP-capable IDE
 * (VS Code Copilot, Cursor, Claude Code, Windsurf, etc.) can call these tools directly,
 * letting the IDE's AI agent orchestrate testing workflows conversationally.
 *
 * Transport: stdio (JSON-RPC 2.0 over stdin/stdout — the MCP standard).
 * All EZTest log output is redirected to stderr so it never corrupts the stdio stream.
 *
 * Tools exposed:
 *   analyze_source     — AST-scan a source directory and summarize interactive elements
 *   generate_tests     — Full pipeline: source → flows → Playwright test files
 *   start_recording    — Launch a browser with the annotation overlay (async, non-blocking)
 *   get_recording      — Poll a recording session for status and completed bug reports
 *   reproduce_bug      — Generate + run a failing Playwright test from a bug report
 *   fix_and_validate   — Full autonomous loop: reproduce → AI fix → validation suite
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { loadConfig } from '../shared/config.js';
import { AiClient } from '../shared/aiClient.js';
import { redirectLoggingToStderr, logInfo, logError } from '../shared/logger.js';
import type { BugReport } from '../shared/types.js';

import { analyzeSourceDirectory } from '../synthesizer/codeAnalyzer.js';
import { mapComponentAnalysesToUserFlows } from '../synthesizer/flowMapper.js';
import { generateTestsForFlows } from '../synthesizer/testGenerator.js';
import { detectAndReadAppSpec } from '../synthesizer/appSpecReader.js';

import { startRecordingSession } from '../recorder/sessionRecorder.js';

import { generateAndRunReproductionTest } from '../agentLoop/testReproducer.js';
import { analyzeAndApplyCodeFix } from '../agentLoop/codeFixAgent.js';
import { generateAndRunValidationSuite } from '../agentLoop/validationSuite.js';

import {
  createRecordingSession,
  getRecordingSession,
  markSessionCompleted,
  markSessionFailed,
} from './sessionStore.js';

// ── Constants ──────────────────────────────────────────────────────────────

const SERVER_NAME = 'eztest';
const SERVER_VERSION = '0.1.3';

/** Default cap for component analysis — keeps AI costs predictable. */
const DEFAULT_MAX_COMPONENTS = 50;

// ── Tool Definitions ───────────────────────────────────────────────────────

/**
 * All tools this MCP server advertises to clients.
 * inputSchema uses JSON Schema draft-07 — the MCP standard.
 */
const EZTEST_TOOLS: Tool[] = [
  {
    name: 'analyze_source',
    description:
      'Scans a source code directory using Babel AST analysis and returns a structured ' +
      'summary of all interactive UI elements found (buttons, forms, inputs, links, etc.). ' +
      'Use this to understand what a codebase does before generating tests. ' +
      'Supports React, JSX, TypeScript, and TSX files.',
    inputSchema: {
      type: 'object',
      properties: {
        sourceDir: {
          type: 'string',
          description: 'Absolute or relative path to the source code directory to analyze.',
        },
        maxComponents: {
          type: 'number',
          description: `Maximum number of component files to analyze. Defaults to ${DEFAULT_MAX_COMPONENTS}.`,
        },
        excludePatterns: {
          type: 'array',
          items: { type: 'string' },
          description: 'Additional glob patterns to exclude from analysis (e.g., ["**/legacy/**"]).',
        },
      },
      required: ['sourceDir'],
    },
  },
  {
    name: 'generate_tests',
    description:
      'Runs the full EZTest pipeline: scans source code, uses AI to map components into ' +
      'user flows, then generates Playwright behavioral test files (.spec.ts). ' +
      'Tests assert on what users SEE and EXPERIENCE — not on internal function calls. ' +
      'Returns the list of generated test file paths and a summary of assertions.',
    inputSchema: {
      type: 'object',
      properties: {
        sourceDir: {
          type: 'string',
          description: 'Path to the source code directory to analyze.',
        },
        appUrl: {
          type: 'string',
          description: 'URL where the target application is running (e.g., http://localhost:3000).',
        },
        outputDir: {
          type: 'string',
          description: 'Directory to write generated test files. Defaults to ./tests/e2e.',
        },
        appSpec: {
          type: 'string',
          description:
            'Plain-English description of what the application does. ' +
            'Auto-detected from README.md or eztest-spec.md when omitted. ' +
            'Providing this significantly improves test quality.',
        },
        includeEdgeCases: {
          type: 'boolean',
          description: 'Whether to generate error and edge-case tests (default: true).',
        },
        maxComponents: {
          type: 'number',
          description: `Maximum components to analyze. Defaults to ${DEFAULT_MAX_COMPONENTS}.`,
        },
        dryRun: {
          type: 'boolean',
          description: 'When true, returns generated test code without writing files to disk.',
        },
      },
      required: ['sourceDir', 'appUrl'],
    },
  },
  {
    name: 'start_recording',
    description:
      'Opens the target application in a Playwright browser with the EZTest annotation ' +
      'overlay injected. A 🚩 button appears in the corner — clicking it captures a bug ' +
      'report with full interaction history, DOM state, and a screenshot. ' +
      'Returns a sessionId immediately (non-blocking). ' +
      'Call get_recording with the sessionId to retrieve completed bug reports after ' +
      'the user closes the browser.',
    inputSchema: {
      type: 'object',
      properties: {
        appUrl: {
          type: 'string',
          description: 'URL to open in the recording browser.',
        },
        outputDir: {
          type: 'string',
          description: 'Directory to save bug report JSON files. Defaults to ./bug-reports.',
        },
      },
      required: ['appUrl'],
    },
  },
  {
    name: 'get_recording',
    description:
      'Polls a recording session for its current status. ' +
      'Returns "running" while the browser is still open, or "completed" with the ' +
      'full bug report JSON when the user has closed the browser. ' +
      'Call this periodically after start_recording until status is "completed" or "error".',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: {
          type: 'string',
          description: 'The sessionId returned by start_recording.',
        },
      },
      required: ['sessionId'],
    },
  },
  {
    name: 'reproduce_bug',
    description:
      'Takes a bug report (from get_recording or a saved JSON file) and generates a ' +
      'Playwright test that reproduces the bug. Runs the test to confirm it fails ' +
      '(proving the bug is real). Returns the test code and run output. ' +
      'This is phase 1 of the autonomous fix loop.',
    inputSchema: {
      type: 'object',
      properties: {
        bugReportJson: {
          type: 'string',
          description:
            'The full bug report JSON string, or an absolute file path to a bug report JSON file.',
        },
        projectRoot: {
          type: 'string',
          description: 'Root directory of the project (where playwright.config.ts lives).',
        },
        appUrl: {
          type: 'string',
          description: 'URL where the target application is running.',
        },
      },
      required: ['bugReportJson', 'projectRoot', 'appUrl'],
    },
  },
  {
    name: 'fix_and_validate',
    description:
      'Runs the full autonomous EZTest feedback loop from a bug report: ' +
      '1) Generates a failing reproduction test (confirms the bug), ' +
      '2) Analyzes source code and applies an AI-generated fix, ' +
      '3) Re-runs the reproduction test (confirms the fix works), ' +
      '4) Generates and runs a positive + negative validation suite. ' +
      'Returns a complete summary of what was changed and whether all tests pass.',
    inputSchema: {
      type: 'object',
      properties: {
        bugReportJson: {
          type: 'string',
          description:
            'The full bug report JSON string, or an absolute file path to a bug report JSON file.',
        },
        projectRoot: {
          type: 'string',
          description: 'Root directory of the project (where playwright.config.ts lives).',
        },
        appUrl: {
          type: 'string',
          description: 'URL where the target application is running.',
        },
        sourceDir: {
          type: 'string',
          description:
            'Source code directory to scan for the fix. ' +
            'Defaults to the sourceDirectory field inside the bug report.',
        },
      },
      required: ['bugReportJson', 'projectRoot', 'appUrl'],
    },
  },
];

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Parses a bug report from either a JSON string or a file path.
 * Accepts the raw JSON content OR an absolute path to a .json file.
 */
function parseBugReport(bugReportJson: string): BugReport {
  const trimmed = bugReportJson.trim();

  // If it looks like a file path rather than JSON, read the file
  if (!trimmed.startsWith('{')) {
    const fileContent = readFileSync(resolve(trimmed), 'utf-8');
    return JSON.parse(fileContent) as BugReport;
  }

  return JSON.parse(trimmed) as BugReport;
}

/**
 * Formats a text response for MCP tool results.
 * All tool results are returned as text content — the IDE AI agent reads and
 * interprets the result conversationally.
 */
function textResult(content: string): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text' as const, text: content }] };
}

// ── Tool Handlers ──────────────────────────────────────────────────────────

/**
 * Handles the `analyze_source` tool call.
 * Returns a human-readable summary of interactive UI elements found in source code.
 */
async function handleAnalyzeSource(args: Record<string, unknown>): Promise<string> {
  const sourceDir = resolve(String(args['sourceDir']));
  const maxComponents = typeof args['maxComponents'] === 'number'
    ? args['maxComponents']
    : DEFAULT_MAX_COMPONENTS;
  const extraExcludePatterns = Array.isArray(args['excludePatterns'])
    ? (args['excludePatterns'] as string[])
    : [];

  const config = loadConfig();
  const excludePatterns = [...config.globalExcludePatterns, ...extraExcludePatterns];

  logInfo(`[MCP] analyze_source: scanning ${sourceDir}`);

  const componentAnalyses = await analyzeSourceDirectory({
    sourceDirectory: sourceDir,
    excludePatterns,
    maxFileCount: maxComponents,
  });

  if (componentAnalyses.length === 0) {
    return `No React/TypeScript components found in ${sourceDir}. Check the path or exclude patterns.`;
  }

  // Build a human-readable summary — not the raw analysis (too large for a tool result)
  const frameworkCounts: Record<string, number> = {};
  let totalElements = 0;

  for (const comp of componentAnalyses) {
    frameworkCounts[comp.detectedFramework] = (frameworkCounts[comp.detectedFramework] ?? 0) + 1;
    totalElements += comp.interactiveElements.length;
  }

  const componentLines = componentAnalyses.map((comp) => {
    const elementSummary = comp.interactiveElements
      .slice(0, 5)
      .map((el) => `${el.elementKind}${el.textContent ? ` "${el.textContent}"` : el.ariaLabel ? ` [${el.ariaLabel}]` : ''}`)
      .join(', ');
    const moreCount = comp.interactiveElements.length > 5
      ? ` + ${comp.interactiveElements.length - 5} more`
      : '';
    return `  • ${comp.componentName} (${comp.interactiveElements.length} elements): ${elementSummary}${moreCount}`;
  });

  const frameworkSummary = Object.entries(frameworkCounts)
    .map(([framework, count]) => `${framework} (${count})`)
    .join(', ');

  return [
    `✅ Analyzed ${componentAnalyses.length} components in ${sourceDir}`,
    `   Frameworks detected: ${frameworkSummary}`,
    `   Total interactive elements: ${totalElements}`,
    '',
    'Components:',
    ...componentLines,
  ].join('\n');
}

/**
 * Handles the `generate_tests` tool call.
 * Runs the full synthesizer pipeline and returns a summary of generated files.
 */
async function handleGenerateTests(args: Record<string, unknown>): Promise<string> {
  const sourceDir = resolve(String(args['sourceDir']));
  const appUrl = String(args['appUrl']);
  const outputDir = resolve(String(args['outputDir'] ?? './tests/e2e'));
  const includeEdgeCases = args['includeEdgeCases'] !== false;
  const maxComponents = typeof args['maxComponents'] === 'number'
    ? args['maxComponents']
    : DEFAULT_MAX_COMPONENTS;
  const shouldWriteFilesToDisk = args['dryRun'] !== true;

  const config = loadConfig();
  const aiClient = new AiClient(config.ai);
  await aiClient.initialize();

  // Auto-detect or use provided app spec for better AI context
  const appSpec = typeof args['appSpec'] === 'string'
    ? args['appSpec']
    : detectAndReadAppSpec(process.cwd());

  logInfo(`[MCP] generate_tests: ${sourceDir} → ${outputDir} (appUrl: ${appUrl})`);

  const componentAnalyses = await analyzeSourceDirectory({
    sourceDirectory: sourceDir,
    excludePatterns: config.globalExcludePatterns,
    maxFileCount: maxComponents,
  });

  if (componentAnalyses.length === 0) {
    return `No components found in ${sourceDir}. Cannot generate tests.`;
  }

  const userFlows = await mapComponentAnalysesToUserFlows(componentAnalyses, aiClient, {
    targetAppUrl: appUrl,
    shouldAnalyzeIndividualComponents: componentAnalyses.length <= 10,
    appSpec: appSpec ?? undefined,
  });

  if (userFlows.length === 0) {
    return `AI could not identify any user flows in ${sourceDir}. Try providing an appSpec describing what the app does.`;
  }

  const result = await generateTestsForFlows(userFlows, aiClient, {
    targetAppUrl: appUrl,
    outputDirectory: outputDir,
    shouldWriteFilesToDisk,
    appSpec: appSpec ?? undefined,
    shouldReviewAssertions: true,
    componentAnalyses,
  });

  const fileLines = result.generatedFiles.map(
    (file) => `  • ${file.suggestedOutputPath} (${file.assertionSummary.length} assertions)`,
  );

  const label = shouldWriteFilesToDisk ? 'Written to disk' : 'Dry run — not written';
  return [
    `✅ Generated ${result.generatedFiles.length} test files (${result.totalAssertionCount} total assertions)`,
    `   ${label} | ${result.failedFlowCount} flows failed to generate`,
    '',
    'Test files:',
    ...fileLines,
    '',
    'Run them with: npx playwright test',
  ].join('\n');
}

/**
 * Handles the `start_recording` tool call.
 * Launches the recording browser asynchronously and returns a sessionId immediately.
 */
async function handleStartRecording(args: Record<string, unknown>): Promise<string> {
  const appUrl = String(args['appUrl']);
  const outputDir = resolve(String(args['outputDir'] ?? './bug-reports'));
  const config = loadConfig();

  const session = createRecordingSession(appUrl, outputDir);
  logInfo(`[MCP] start_recording: session ${session.sessionId} → ${appUrl}`);

  // Launch recording in the background — do NOT await.
  // The session store is updated when the browser closes.
  startRecordingSession({
    targetUrl: appUrl,
    annotationServerPort: config.annotationServerPort,
    bugReportOutputDirectory: outputDir,
    shouldShowBrowser: true,
  })
    .then((bugReports) => markSessionCompleted(session.sessionId, bugReports))
    .catch((err: unknown) =>
      markSessionFailed(session.sessionId, String(err instanceof Error ? err.message : err)),
    );

  return [
    `✅ Recording session started`,
    `   Session ID: ${session.sessionId}`,
    `   Browser opening: ${appUrl}`,
    `   Bug reports will be saved to: ${outputDir}`,
    '',
    'A browser window has opened with the EZTest annotation overlay.',
    'Use the app normally. When you see unexpected behavior, click the 🚩 button',
    'and describe what you expected. You can flag multiple bugs in one session.',
    '',
    `When you are done, close the browser and call:`,
    `  get_recording with sessionId: "${session.sessionId}"`,
  ].join('\n');
}

/**
 * Handles the `get_recording` tool call.
 * Returns the current state of a recording session.
 */
function handleGetRecording(args: Record<string, unknown>): string {
  const sessionId = String(args['sessionId']);
  const session = getRecordingSession(sessionId);

  if (!session) {
    return `❌ No recording session found with ID: ${sessionId}\nMake sure you used the sessionId returned by start_recording.`;
  }

  if (session.status === 'running') {
    return [
      `⏳ Recording session is still running`,
      `   Session ID: ${sessionId}`,
      `   Target URL: ${session.targetUrl}`,
      `   Started: ${session.startedAt}`,
      '',
      'The browser is still open. Close it when you are done flagging bugs,',
      'then call get_recording again to retrieve the results.',
    ].join('\n');
  }

  if (session.status === 'error') {
    return [
      `❌ Recording session failed`,
      `   Session ID: ${sessionId}`,
      `   Error: ${session.errorMessage}`,
    ].join('\n');
  }

  // Completed — return the bug reports
  if (session.bugReports.length === 0) {
    return [
      `✅ Recording session completed — no bugs were flagged`,
      `   Session ID: ${sessionId}`,
      `   The browser was closed without clicking the 🚩 button.`,
    ].join('\n');
  }

  const reportLines = session.bugReports.map((report, index) => [
    `Bug ${index + 1}: ${report.reportId}`,
    `  Flagged at: ${report.observedAtUrl}`,
    `  User expectation: "${report.userExpectation}"`,
    `  Interactions recorded: ${report.interactionHistory.length}`,
    `  Saved to: ${session.outputDirectory}/bug-report-${report.reportId}.json`,
  ].join('\n'));

  return [
    `✅ Recording session completed — ${session.bugReports.length} bug(s) flagged`,
    '',
    ...reportLines,
    '',
    'To run the autonomous fix loop for a bug, call:',
    `  fix_and_validate with the bug report JSON from ${session.outputDirectory}`,
  ].join('\n');
}

/**
 * Handles the `reproduce_bug` tool call.
 * Generates and runs a failing reproduction test from a bug report.
 */
async function handleReproduceBug(args: Record<string, unknown>): Promise<string> {
  const bugReport = parseBugReport(String(args['bugReportJson']));
  const projectRoot = resolve(String(args['projectRoot']));
  const appUrl = String(args['appUrl']);

  const config = loadConfig();
  const aiClient = new AiClient(config.ai);
  await aiClient.initialize();

  logInfo(`[MCP] reproduce_bug: bug ${bugReport.reportId}`);

  const attempt = await generateAndRunReproductionTest(bugReport, aiClient, {
    projectRoot,
    targetAppUrl: appUrl,
  });

  const statusIcon = attempt.wasReproductionSuccessful ? '✅' : '⚠️';
  const statusText = attempt.wasReproductionSuccessful
    ? 'Bug reproduced — test fails as expected (bug is confirmed real)'
    : 'Could not reproduce — test passed (bug may be intermittent or already fixed)';

  return [
    `${statusIcon} Reproduction result for bug ${attempt.bugReportId}`,
    `   Status: ${statusText}`,
    '',
    '── Generated test code ──',
    attempt.reproductionTestCode,
    '',
    '── Test run output ──',
    attempt.testRunOutput,
  ].join('\n');
}

/**
 * Handles the `fix_and_validate` tool call.
 * Runs the full autonomous reproduce → fix → validate loop.
 */
async function handleFixAndValidate(args: Record<string, unknown>): Promise<string> {
  const bugReport = parseBugReport(String(args['bugReportJson']));
  const projectRoot = resolve(String(args['projectRoot']));
  const appUrl = String(args['appUrl']);
  const sourceDir = typeof args['sourceDir'] === 'string'
    ? resolve(args['sourceDir'])
    : bugReport.sourceDirectory;

  const config = loadConfig();
  const aiClient = new AiClient(config.ai);
  await aiClient.initialize();

  logInfo(`[MCP] fix_and_validate: bug ${bugReport.reportId}`);

  // Phase 1 — Reproduce
  const reproduction = await generateAndRunReproductionTest(bugReport, aiClient, {
    projectRoot,
    targetAppUrl: appUrl,
  });

  if (!reproduction.wasReproductionSuccessful) {
    return [
      `⚠️  Could not reproduce bug ${bugReport.reportId}`,
      'The test passed — bug may be intermittent or already fixed.',
      'No fix was applied.',
      '',
      '── Reproduction test code ──',
      reproduction.reproductionTestCode,
    ].join('\n');
  }

  // Phase 2 — Fix
  const fixResult = await analyzeAndApplyCodeFix(reproduction, bugReport, aiClient, {
    projectRoot,
    targetAppUrl: appUrl,
    sourceDirectory: sourceDir,
  });

  // Phase 3 — Validate
  const validationResult = await generateAndRunValidationSuite(
    fixResult,
    bugReport,
    reproduction.reproductionTestCode,
    aiClient,
    { projectRoot, targetAppUrl: appUrl },
  );

  const overallStatus = fixResult.doesReproductionTestPass && validationResult.didAllValidationTestsPass
    ? '✅ Fix complete and validated'
    : '⚠️  Fix applied but some tests failed — review needed';

  const changedFilesList = [...fixResult.changedFiles.keys()]
    .map((filePath) => `  • ${filePath}`)
    .join('\n');

  return [
    `${overallStatus}`,
    `   Bug ID: ${bugReport.reportId}`,
    '',
    '── Root cause and fix ──',
    fixResult.fixDescription,
    '',
    '── Files changed ──',
    changedFilesList || '  (no files changed)',
    '',
    `── Validation suite ──`,
    validationResult.didAllValidationTestsPass
      ? '   All tests passed ✅'
      : '   Some tests failed ⚠️',
    '',
    '── Validation output ──',
    validationResult.testRunOutput,
  ].join('\n');
}

// ── Server Bootstrap ───────────────────────────────────────────────────────

/**
 * Creates and returns a configured MCP Server instance.
 * Does not start the transport — call `startMcpServer()` to connect stdio.
 */
function createServer(): Server {
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } },
  );

  // Advertise available tools to the IDE client
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: EZTEST_TOOLS,
  }));

  // Dispatch tool calls to the appropriate handler
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const toolName = request.params.name;
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;

    try {
      let resultText: string;

      switch (toolName) {
        case 'analyze_source':
          resultText = await handleAnalyzeSource(args);
          break;
        case 'generate_tests':
          resultText = await handleGenerateTests(args);
          break;
        case 'start_recording':
          resultText = await handleStartRecording(args);
          break;
        case 'get_recording':
          resultText = handleGetRecording(args);
          break;
        case 'reproduce_bug':
          resultText = await handleReproduceBug(args);
          break;
        case 'fix_and_validate':
          resultText = await handleFixAndValidate(args);
          break;
        default:
          resultText = `Unknown tool: ${toolName}`;
      }

      return textResult(resultText);
    } catch (handlerError) {
      const errorMessage = handlerError instanceof Error
        ? handlerError.message
        : String(handlerError);
      logError(`[MCP] Tool "${toolName}" failed: ${errorMessage}`, handlerError);
      return textResult(`❌ Error running ${toolName}: ${errorMessage}`);
    }
  });

  return server;
}

/**
 * Starts the EZTest MCP server over stdio.
 *
 * Must be called from a process dedicated to MCP — any other code that writes
 * to stdout will corrupt the JSON-RPC stream. `redirectLoggingToStderr()` is
 * called here to ensure all EZTest log output goes to stderr instead.
 */
export async function startMcpServer(): Promise<void> {
  // Redirect all logging before anything else writes to stdout
  redirectLoggingToStderr();

  const server = createServer();
  const transport = new StdioServerTransport();

  await server.connect(transport);

  // Use stderr for startup confirmation so it shows in IDE debug panels
  process.stderr.write(`[EZTest MCP] Server v${SERVER_VERSION} running on stdio\n`);
  process.stderr.write('[EZTest MCP] Tools: analyze_source, generate_tests, start_recording, get_recording, reproduce_bug, fix_and_validate\n');
}
