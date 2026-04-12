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

// ── Dynamic Batch Sizing ───────────────────────────────────────────────────

/**
 * Target output token budget per batch — 90% of the Copilot Pro 4096-token output cap.
 * Leaving a 10% margin accounts for variation in AI response verbosity.
 * This is the output cap — it applies regardless of which model is active.
 */
const TARGET_BATCH_OUTPUT_TOKENS = 3600;

/**
 * Fixed token overhead per batch response: JSON array brackets, whitespace,
 * and other structural tokens EZTest does not control.
 */
const BATCH_RESPONSE_OVERHEAD_TOKENS = 200;

/**
 * Estimated output tokens for one flow variant (happy-path, error-case, or edge-case).
 * Based on: flowName (10) + startingRoute (5) + flowKind (5) + 4 steps × 40 tokens/step
 * + involvedComponents (15) + testPriority (5) + JSON structure overhead (20) ≈ 220 tokens.
 */
const ESTIMATED_TOKENS_PER_FLOW_VARIANT = 220;

/**
 * Estimates how many output tokens the AI will need to describe all flows for one component.
 * Logic: every 2 interactive elements produce 1 logical user flow, and every logical flow
 * is expanded into 3 variants (happy-path + error-case + edge-case).
 * Minimum of 1 logical flow even for components with 0–1 elements (login button, etc.).
 */
export function estimateComponentOutputTokens(componentAnalysis: ComponentAnalysis): number {
  const elementCount = componentAnalysis.interactiveElements.length;
  const logicalFlowCount = Math.max(1, Math.ceil(elementCount / 2));
  const totalFlowVariants = logicalFlowCount * 3; // happy-path + error-case + edge-case
  return totalFlowVariants * ESTIMATED_TOKENS_PER_FLOW_VARIANT;
}

/**
 * Splits components into batches where each batch's estimated output token cost
 * stays within TARGET_BATCH_OUTPUT_TOKENS (90% of the model's output cap).
 *
 * Unlike a fixed batch size, this adapts to component complexity:
 *   - A component with 1 element generates ~3 flow variants ≈ 660 tokens → fits 5 per batch
 *   - A component with 10 elements generates ~15 flow variants ≈ 3300 tokens → 1 per batch
 *
 * A component that alone exceeds the budget is placed in its own batch — we cannot
 * split a single component further without losing cross-element flow context.
 */
export function splitIntoDynamicBatches(
  componentAnalyses: ComponentAnalysis[],
): ComponentAnalysis[][] {
  const batches: ComponentAnalysis[][] = [];
  let currentBatch: ComponentAnalysis[] = [];
  let currentBatchTokens = BATCH_RESPONSE_OVERHEAD_TOKENS;

  for (const componentAnalysis of componentAnalyses) {
    const componentTokenCost = estimateComponentOutputTokens(componentAnalysis);

    // Start a new batch if adding this component would exceed the token budget.
    // If the current batch is empty, include it anyway — a single very-complex
    // component cannot be split, and the recovery logic handles any overflow.
    if (currentBatch.length > 0 && currentBatchTokens + componentTokenCost > TARGET_BATCH_OUTPUT_TOKENS) {
      batches.push(currentBatch);
      currentBatch = [];
      currentBatchTokens = BATCH_RESPONSE_OVERHEAD_TOKENS;
    }

    currentBatch.push(componentAnalysis);
    currentBatchTokens += componentTokenCost;
  }

  if (currentBatch.length > 0) {
    batches.push(currentBatch);
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
 * Attempts to recover a valid JSON array from a response that was cut off mid-stream
 * because the model hit its output token limit. Tries two strategies in order:
 *   1. Truncate at the last `},` boundary (end of last complete array item)
 *   2. Truncate at the last `}` (catches the final item if it wasn't followed by a comma)
 * Returns null if neither strategy produces a parseable array with at least one item.
 */
function recoverTruncatedJsonArray(truncatedContent: string): unknown[] | null {
  if (!truncatedContent.trim().startsWith('[')) return null;

  // Strategy 1: find the last complete object ending with `},` and close the array
  const lastCommaEnd = truncatedContent.lastIndexOf('},');
  if (lastCommaEnd !== -1) {
    try {
      const candidate = truncatedContent.slice(0, lastCommaEnd + 1) + ']';
      const parsed = JSON.parse(candidate);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    } catch {
      // Fall through to strategy 2
    }
  }

  // Strategy 2: find the last `}` — works when the final object was complete but
  // the closing `]` was never emitted before the token limit was hit
  const lastBrace = truncatedContent.lastIndexOf('}');
  if (lastBrace !== -1) {
    try {
      const candidate = truncatedContent.slice(0, lastBrace + 1) + ']';
      const parsed = JSON.parse(candidate);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    } catch {
      // Truly unrecoverable
    }
  }

  return null;
}

/**
 * Parses a JSON response from the AI, with graceful error handling.
 * Returns null if parsing fails — the caller decides how to handle missing data.
 * For array responses, also attempts truncation recovery when the model hits its
 * output token limit and returns incomplete JSON.
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
    // When the response looks like a truncated JSON array, try to recover whatever
    // complete items were emitted before the token limit cut the response short.
    // This preserves partial flow results instead of discarding the entire batch.
    if (cleanedContent.startsWith('[')) {
      const recoveredItems = recoverTruncatedJsonArray(cleanedContent);
      if (recoveredItems && recoveredItems.length > 0) {
        logWarning(
          `AI response for "${operationDescription}" was truncated at the token limit. ` +
          `Recovered ${recoveredItems.length} item(s) from the partial response.`,
        );
        return recoveredItems as ParsedType;
      }
    }

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

  // Split components into token-aware batches so no single API call exceeds the
  // output token cap. Dynamic batching accounts for component complexity — a form
  // with 10 inputs generates far more flows than a single-button component.
  const componentBatches = splitIntoDynamicBatches(componentAnalyses);
  const totalEstimatedTokens = componentAnalyses.reduce(
    (total, component) => total + estimateComponentOutputTokens(component),
    0,
  );
  logDebug(
    `Generating user flows from ${componentAnalyses.length} components in ` +
    `${componentBatches.length} batch(es) (~${totalEstimatedTokens} estimated output tokens total).`,
  );

  const allAiGeneratedFlows: AiGeneratedFlow[] = [];

  for (let batchIndex = 0; batchIndex < componentBatches.length; batchIndex++) {
    const currentBatch = componentBatches[batchIndex];
    const batchEstimatedTokens = currentBatch.reduce(
      (total, component) => total + estimateComponentOutputTokens(component),
      BATCH_RESPONSE_OVERHEAD_TOKENS,
    );
    const batchLabel = `user flow generation (batch ${batchIndex + 1}/${componentBatches.length})`;
    logDebug(
      `  ${batchLabel}: ${currentBatch.length} components, ~${batchEstimatedTokens} estimated output tokens`,
    );

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
