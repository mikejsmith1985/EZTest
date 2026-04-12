/**
 * User Flow Mapper — second stage of the AI Test Synthesizer pipeline.
 *
 * Takes the raw ComponentAnalysis results from the CodeAnalyzer and uses AI to:
 * 1. Understand the user-facing purpose of each component
 * 2. Identify how components connect into complete user journeys
 * 3. Produce UserFlow objects that span multiple pages/components
 *
 * The key insight: individual components don't tell the whole story.
 * A "checkout" button in a cart component leads to a payment form component
 * which leads to a confirmation page. The FlowMapper connects these dots.
 */
import type { ComponentAnalysis, UserFlow, UserFlowStep } from '../shared/types.js';
import type { AiClient } from '../shared/aiClient.js';
import {
  buildComponentIntentPrompt,
  buildUserFlowGenerationPrompt,
} from './promptTemplates.js';
import { logDebug, logWarning } from '../shared/logger.js';

// ── Batching Constants ─────────────────────────────────────────────────────

/**
 * Maximum number of components to include in a single flow-generation API call.
 *
 * The GitHub Models API (free tier) limits request bodies to ~8000 input tokens.
 * With the reduced source excerpt in buildUserFlowGenerationPrompt:
 *   - ~1100 tokens: prompt overhead (system prompt + user instructions)
 *   - ~155 tokens per component: name + element list + 400-char source excerpt
 *   - 20 components × 155 = 3100 + 1100 overhead = 4200 tokens ✅ well under limit
 *   - 40 components × 155 = 6200 + 1100 overhead = 7300 tokens ✅ still under limit
 *
 * A batch size of 40 means most projects (< 40 UI components) are handled in ONE
 * API call, avoiding rate-limit 429 waits that occur with many small calls.
 * For projects with > 40 components, it still batches efficiently.
 */
const FLOW_MAPPING_BATCH_SIZE = 40;

// ── Batch Helpers ──────────────────────────────────────────────────────────

/**
 * Splits an array into chunks of at most chunkSize elements.
 * Used to batch component analyses so no single API call exceeds the token limit.
 */
function splitIntoBatches<ItemType>(items: ItemType[], chunkSize: number): ItemType[][] {
  const batches: ItemType[][] = [];
  for (let startIndex = 0; startIndex < items.length; startIndex += chunkSize) {
    batches.push(items.slice(startIndex, startIndex + chunkSize));
  }
  return batches;
}

// ── AI Response Parsing ────────────────────────────────────────────────────

/** The shape of the AI's response to the component intent analysis prompt. */
interface ComponentIntentResponse {
  componentPurpose: string;
  userActions: Array<{
    actionName: string;
    description: string;
    triggerElement: string;
    expectedOutcome: string;
    canFail: boolean;
    failureOutcome?: string;
  }>;
  requiredSetup: string;
}

/** The shape of a single user flow in the AI's flow generation response. */
interface AiGeneratedFlow {
  flowName: string;
  startingRoute: string;
  flowKind: 'happy-path' | 'error-case' | 'edge-case';
  steps: Array<{
    stepDescription: string;
    targetElementDescription: string;
    expectedOutcome: string;
    isNavigation: boolean;
  }>;
  involvedComponents: string[];
  testPriority: 'critical' | 'high' | 'medium';
}

/**
 * Parses a JSON response from the AI, with graceful error handling.
 * Returns null if parsing fails — the caller decides how to handle missing data.
 */
function parseAiJsonResponse<ParsedType>(
  aiResponseContent: string,
  operationDescription: string,
): ParsedType | null {
  // Strip any accidental markdown fences the AI might include despite instructions
  const cleanedContent = aiResponseContent
    .replace(/^```(?:json)?\s*/m, '')
    .replace(/\s*```\s*$/m, '')
    .trim();

  try {
    return JSON.parse(cleanedContent) as ParsedType;
  } catch (parseError) {
    logWarning(`Could not parse AI JSON response for "${operationDescription}": ${String(parseError)}`);
    logDebug(`Raw AI response: ${aiResponseContent.slice(0, 500)}`);
    return null;
  }
}

// ── Component Intent Analysis ──────────────────────────────────────────────

/**
 * Uses AI to analyze a single component and understand its user-facing purpose.
 * Returns a structured description of what users can do with this component.
 *
 * @param appSpec - Optional plain-English app description injected into the prompt
 *   so the AI understands the business context while analyzing the component.
 */
async function analyzeComponentIntent(
  componentAnalysis: ComponentAnalysis,
  aiClient: AiClient,
  appSpec?: string,
): Promise<ComponentIntentResponse | null> {
  const promptMessages = buildComponentIntentPrompt(componentAnalysis, appSpec);

  const aiResponse = await aiClient.chat(
    promptMessages,
    `component intent: ${componentAnalysis.componentName}`,
  );

  return parseAiJsonResponse<ComponentIntentResponse>(
    aiResponse.content,
    `component intent for ${componentAnalysis.componentName}`,
  );
}

// ── User Flow Assembly ─────────────────────────────────────────────────────

/**
 * Converts an AI-generated flow object into EZTest's internal UserFlow type.
 * Normalizes the data and fills in defaults for any missing fields.
 */
function normalizeAiGeneratedFlow(
  aiFlow: AiGeneratedFlow,
  baseUrl: string,
): UserFlow {
  const normalizedSteps: UserFlowStep[] = aiFlow.steps.map(step => ({
    actionDescription: step.stepDescription,
    expectedOutcome: step.expectedOutcome,
    isNavigation: step.isNavigation,
    // We don't have a specific InteractiveElement reference here — the AI describes it in text
    targetElement: undefined,
  }));

  return {
    flowName: aiFlow.flowName,
    startingUrl: `${baseUrl}${aiFlow.startingRoute}`,
    steps: normalizedSteps,
    involvedComponents: aiFlow.involvedComponents,
    flowKind: aiFlow.flowKind,
  };
}

// ── Public API ─────────────────────────────────────────────────────────────

/** Options for the flow mapping phase. */
export interface FlowMapperOptions {
  /** The base URL of the target application. */
  targetAppUrl: string;
  /**
   * Whether to run per-component intent analysis before flow generation.
   * More thorough but uses more AI tokens. Recommended for complex apps.
   */
  shouldAnalyzeIndividualComponents: boolean;
  /**
   * Optional plain-English description of what the application is designed to do.
   * Auto-detected from eztest-spec.md, README.md, or AGENTS.md when not provided.
   * This is the single biggest quality lever — it gives the AI the business
   * intent of the app, not just a mechanical reading of the source code.
   */
  appSpec?: string;
}

/**
 * Maps a set of ComponentAnalysis objects into UserFlow objects by using AI
 * to understand the connections between components and the journeys users take.
 *
 * Components are processed in batches to stay within the GitHub Models API
 * 8K-token-per-request limit. Flows from all batches are merged and returned.
 *
 * This is the bridge between raw code analysis and test generation.
 */
export async function mapComponentAnalysesToUserFlows(
  componentAnalyses: ComponentAnalysis[],
  aiClient: AiClient,
  options: FlowMapperOptions,
): Promise<UserFlow[]> {
  const { targetAppUrl, shouldAnalyzeIndividualComponents, appSpec } = options;

  // Optionally run per-component intent analysis to enrich the context.
  // Only run this when the component count is small enough to be worthwhile
  // without burning too many API calls.
  if (shouldAnalyzeIndividualComponents && componentAnalyses.length <= 20) {
    logDebug(`Running per-component intent analysis for ${componentAnalyses.length} components...`);

    for (const componentAnalysis of componentAnalyses) {
      // Pass the app spec so per-component analysis understands the business context
      const intent = await analyzeComponentIntent(componentAnalysis, aiClient, appSpec);
      if (intent) {
        // Attach the inferred purpose to each component's route path for context
        componentAnalysis.routePath = componentAnalysis.routePath ?? intent.requiredSetup;
        logDebug(`  ${componentAnalysis.componentName}: ${intent.componentPurpose}`);
      }
    }
  }

  // Split components into batches so each API call stays under the 8K token limit.
  // See FLOW_MAPPING_BATCH_SIZE comment for the token budget rationale.
  const componentBatches = splitIntoBatches(componentAnalyses, FLOW_MAPPING_BATCH_SIZE);
  logDebug(
    `Generating user flows from ${componentAnalyses.length} components in ${componentBatches.length} batch(es)...`,
  );

  const allAiGeneratedFlows: AiGeneratedFlow[] = [];

  for (let batchIndex = 0; batchIndex < componentBatches.length; batchIndex++) {
    const currentBatch = componentBatches[batchIndex];
    const batchLabel = `user flow generation (batch ${batchIndex + 1}/${componentBatches.length})`;
    logDebug(`  ${batchLabel}: ${currentBatch.map(c => c.componentName).join(', ')}`);

    const flowGenerationMessages = buildUserFlowGenerationPrompt(currentBatch, targetAppUrl, appSpec);
    const flowGenerationResponse = await aiClient.chat(flowGenerationMessages, batchLabel);

    const batchFlows = parseAiJsonResponse<AiGeneratedFlow[]>(
      flowGenerationResponse.content,
      batchLabel,
    );

    if (batchFlows && Array.isArray(batchFlows)) {
      allAiGeneratedFlows.push(...batchFlows);
    } else {
      logWarning(`Batch ${batchIndex + 1} returned no valid flows — skipping.`);
    }
  }

  if (allAiGeneratedFlows.length === 0) {
    logWarning('All flow generation batches returned no valid flows. Check AI responses above.');
    return [];
  }

  logDebug(`AI generated ${allAiGeneratedFlows.length} user flows across all batches`);

  const normalizedFlows = allAiGeneratedFlows.map(aiFlow =>
    normalizeAiGeneratedFlow(aiFlow, targetAppUrl),
  );

  return normalizedFlows;
}
