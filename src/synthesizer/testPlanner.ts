/**
 * Test Planner — generates a human-readable test plan from source code analysis
 * without writing any Playwright test code. Used by `eztest plan` to let
 * developers preview and approve what will be tested before committing to a
 * full generation run.
 */
import { basename } from 'node:path';
import { analyzeSourceDirectory } from './codeAnalyzer.js';
import { mapComponentAnalysesToUserFlows } from './flowMapper.js';
import { buildTestPlanPrompt } from './promptTemplates.js';
import type { AiClient } from '../shared/aiClient.js';
import type { UserFlow } from '../shared/types.js';
import { loadConfig } from '../shared/config.js';
import { logDebug } from '../shared/logger.js';

// ── Constants ──────────────────────────────────────────────────────────────

/**
 * Emoji markers used in the AI's plan output to count scenario types.
 * These match the OUTPUT FORMAT specified in buildTestPlanPrompt.
 */
const HAPPY_PATH_MARKER = '✅';
const EDGE_CASE_MARKER = '⚠️';
const FAILURE_CASE_MARKER = '❌';

/** Section heading that marks the start of the ambiguous-expectations block. */
const AMBIGUOUS_SECTION_HEADING = '❓';

/** Default target URL used when plan analysis doesn't need a live server. */
const DEFAULT_ANALYSIS_URL = 'http://localhost:3000';

// ── Public Types ───────────────────────────────────────────────────────────

/** Options passed to generateTestPlan. */
export interface TestPlannerOptions {
  /** Path to the source directory to analyze (e.g. "./src"). */
  sourceDirectory: string;
  /** Optional plain-English app spec content, injected for business context. */
  appSpecContent: string | null;
  /** Initialized AI client ready to accept chat requests. */
  aiClient: AiClient;
}

/** The result of a test plan generation run. */
export interface TestPlanResult {
  /** Complete test plan as a markdown string, ready to print or save. */
  planMarkdown: string;
  /** Number of distinct features/flows identified in source analysis. */
  featureCount: number;
  /** Total test scenarios counted across happy-path, edge, and failure cases. */
  scenarioCount: number;
  /**
   * True when the plan contains an "Ambiguous Expectations" section,
   * indicating that `eztest interview` would improve coverage confidence.
   */
  hasAmbiguousFlows: boolean;
}

// ── Flow Summary Helpers ───────────────────────────────────────────────────

/**
 * Derives a plain-English one-sentence description of a flow's purpose from
 * its steps. Falls back to the flow name itself when steps are sparse.
 */
function buildFlowDescription(userFlow: UserFlow): string {
  if (userFlow.steps.length === 0) {
    return userFlow.flowName;
  }

  // Use the first and last step outcomes to describe the full arc of the flow
  const firstStepDescription = userFlow.steps[0]?.actionDescription ?? '';
  const lastStepOutcome = userFlow.steps[userFlow.steps.length - 1]?.expectedOutcome ?? '';

  if (firstStepDescription && lastStepOutcome) {
    return `${firstStepDescription} → ${lastStepOutcome}`;
  }

  return firstStepDescription || lastStepOutcome || userFlow.flowName;
}

/**
 * Converts a UserFlow into the simplified shape that buildTestPlanPrompt expects.
 * Derives all fields from the UserFlow without making additional AI calls.
 */
function summarizeUserFlow(
  userFlow: UserFlow,
): { flowName: string; flowDescription: string; componentCount: number; hasErrorPath: boolean } {
  const hasErrorPath =
    userFlow.flowKind === 'error-case' ||
    // Count as having an error path if any step describes a failure outcome
    userFlow.steps.some(step =>
      /error|fail|invalid|denied|reject/i.test(step.expectedOutcome),
    );

  return {
    flowName: userFlow.flowName,
    flowDescription: buildFlowDescription(userFlow),
    componentCount: userFlow.involvedComponents.length,
    hasErrorPath,
  };
}

// ── Scenario Counting ──────────────────────────────────────────────────────

/**
 * Counts the total number of test scenarios in the markdown plan by scanning
 * for the emoji markers that the AI is instructed to use per OUTPUT FORMAT.
 */
function countScenariosInPlanMarkdown(planMarkdown: string): number {
  const happyPathCount = (planMarkdown.match(new RegExp(HAPPY_PATH_MARKER, 'g')) ?? []).length;
  const edgeCaseCount = (planMarkdown.match(new RegExp(EDGE_CASE_MARKER, 'g')) ?? []).length;
  const failureCaseCount = (planMarkdown.match(new RegExp(FAILURE_CASE_MARKER, 'g')) ?? []).length;

  logDebug(
    `Scenario counts — happy: ${happyPathCount}, edge: ${edgeCaseCount}, failure: ${failureCaseCount}`,
  );

  return happyPathCount + edgeCaseCount + failureCaseCount;
}

/**
 * Returns true when the plan markdown contains an Ambiguous Expectations
 * section with at least one listed item (non-empty section).
 */
function checkForAmbiguousFlows(planMarkdown: string): boolean {
  const ambiguousHeadingIndex = planMarkdown.indexOf(AMBIGUOUS_SECTION_HEADING);
  if (ambiguousHeadingIndex === -1) return false;

  // Anything after the heading counts as content — the AI only writes the
  // section when it has actual items, per the prompt instructions.
  const contentAfterHeading = planMarkdown.slice(ambiguousHeadingIndex + AMBIGUOUS_SECTION_HEADING.length).trim();
  return contentAfterHeading.length > 0;
}

// ── Project Name Inference ─────────────────────────────────────────────────

/**
 * Derives a human-readable project name from the source directory path.
 * Uses the immediate parent directory name, which is typically the project root.
 */
function inferProjectNameFromSourceDirectory(sourceDirectory: string): string {
  // Walk up one level: if source is "./src", the project root is "."
  const resolvedBase = basename(sourceDirectory) === 'src'
    ? basename(process.cwd())
    : basename(sourceDirectory);

  // Convert kebab-case or snake_case directory names to Title Case
  return resolvedBase
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, char => char.toUpperCase())
    || 'Unknown Project';
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Runs source analysis and flow mapping (the same first two stages as
 * `eztest generate`) then calls the AI once to produce a human-readable
 * test plan instead of generating any test code.
 *
 * Returns a TestPlanResult containing the markdown plan and headline counts
 * that the CLI uses to print a summary and decide whether to show tips.
 */
export async function generateTestPlan(options: TestPlannerOptions): Promise<TestPlanResult> {
  const { sourceDirectory, appSpecContent, aiClient } = options;
  const ezTestConfig = loadConfig();

  // ── Stage 1: Analyze source code ────────────────────────────────────────
  const componentAnalyses = await analyzeSourceDirectory({
    sourceDirectory,
    excludePatterns: ezTestConfig.globalExcludePatterns,
    maxFileCount: 200,
  });

  logDebug(`Test planner: found ${componentAnalyses.length} components`);

  // ── Stage 2: Map components to user flows ────────────────────────────────
  // Deep component analysis is skipped here — we only need flow-level summaries,
  // not per-component intent breakdowns, to produce an accurate plan.
  const userFlows = await mapComponentAnalysesToUserFlows(componentAnalyses, aiClient, {
    targetAppUrl: DEFAULT_ANALYSIS_URL,
    shouldAnalyzeIndividualComponents: false,
    appSpec: appSpecContent ?? undefined,
  });

  logDebug(`Test planner: mapped ${userFlows.length} user flows`);

  // ── Stage 3: Build simplified flow summaries for the plan prompt ─────────
  const flowSummaries = userFlows.map(summarizeUserFlow);
  const projectName = inferProjectNameFromSourceDirectory(sourceDirectory);

  // ── Stage 4: Generate the test plan via AI ───────────────────────────────
  const planPromptMessages = buildTestPlanPrompt(projectName, flowSummaries, appSpecContent);
  const aiPlanResponse = await aiClient.chat(planPromptMessages, 'test plan generation');

  const planMarkdown = aiPlanResponse.content.trim();

  // ── Stage 5: Extract headline metrics from the plan text ─────────────────
  const scenarioCount = countScenariosInPlanMarkdown(planMarkdown);
  const hasAmbiguousFlows = checkForAmbiguousFlows(planMarkdown);

  return {
    planMarkdown,
    featureCount: userFlows.length,
    scenarioCount,
    hasAmbiguousFlows,
  };
}
