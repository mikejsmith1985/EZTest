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
import type { ComponentAnalysis, ForgeAppContext, UserFlow, UserFlowStep } from '../shared/types.js';
import type { AiClient } from '../shared/aiClient.js';
import {
  buildComponentIntentPrompt,
  buildUserFlowGenerationPrompt,
} from './promptTemplates.js';
import { logDebug, logWarning } from '../shared/logger.js';
import pLimit from 'p-limit';
import {
  parseFlowsFromAiResponse,
  parseComponentIntentFromAiResponse,
} from './aiResponseSchemas.js';
import type { AiGeneratedFlow, ComponentIntentResponse } from './aiResponseSchemas.js';

// ── Dynamic Batch Sizing ───────────────────────────────────────────────────

/**
 * Target output token budget per batch — 90% of the model's output cap, leaving
 * a margin for AI response verbosity. This DEFAULT is for GitHub Models (4 096 tokens).
 *
 * The actual value used at runtime is driven by the provider via AiClient.flowBatchOutputBudget:
 *   - GitHub Models:  ~3 600 tokens → typically 6–8 components per batch
 *   - Copilot API:   ~14 745 tokens → typically 20–26 components per batch (often 1 call total)
 *   - OpenAI/Anthropic: scales with their configured maxTokensPerCall
 */
const DEFAULT_BATCH_OUTPUT_TOKENS = 3600;

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
 * stays within the given targetOutputTokens budget.
 *
 * Unlike a fixed batch size, this adapts to component complexity:
 *   - A component with 1 element generates ~3 flow variants ≈ 660 tokens → fits 5 per batch
 *   - A component with 10 elements generates ~15 flow variants ≈ 3300 tokens → 1 per batch
 *
 * The budget is provider-specific:
 *   - GitHub Models (4K output cap):  targetOutputTokens ≈ 3 600  → ~6–8 components/batch
 *   - Copilot API   (16K output cap): targetOutputTokens ≈ 14 745 → all 26 often fit in 1 batch
 *
 * A component that alone exceeds the budget is placed in its own batch — we cannot
 * split a single component further without losing cross-element flow context.
 */
export function splitIntoDynamicBatches(
  componentAnalyses: ComponentAnalysis[],
  targetOutputTokens: number = DEFAULT_BATCH_OUTPUT_TOKENS,
): ComponentAnalysis[][] {
  const batches: ComponentAnalysis[][] = [];
  let currentBatch: ComponentAnalysis[] = [];
  let currentBatchTokens = BATCH_RESPONSE_OVERHEAD_TOKENS;

  for (const componentAnalysis of componentAnalyses) {
    const componentTokenCost = estimateComponentOutputTokens(componentAnalysis);

    // Start a new batch if adding this component would exceed the token budget.
    // If the current batch is empty, include it anyway — a single very-complex
    // component cannot be split, and the recovery logic handles any overflow.
    if (currentBatch.length > 0 && currentBatchTokens + componentTokenCost > targetOutputTokens) {
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

// AiGeneratedFlow and ComponentIntentResponse types are imported from aiResponseSchemas.ts.
// Zod-validated parsing is handled by parseFlowsFromAiResponse and
// parseComponentIntentFromAiResponse from the same module.

/**
 * Resolves an AI-provided starting route into a usable browser URL.
 * Supports three cases:
 * 1. Absolute URLs returned by the AI — preserved as-is
 * 2. Root-relative paths like `/checkout` or `/jira/...` — resolved against the app origin
 * 3. Empty routes — fall back to the configured base URL
 */
function resolveStartingUrl(startingRoute: string, baseUrl: string): string {
  const normalizedStartingRoute = startingRoute.trim();
  if (!normalizedStartingRoute) {
    return baseUrl;
  }

  try {
    return new URL(normalizedStartingRoute).toString();
  } catch {
    // Continue — this is a relative route, not an absolute URL.
  }

  try {
    return new URL(normalizedStartingRoute, baseUrl).toString();
  } catch {
    return `${baseUrl}${normalizedStartingRoute}`;
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

  return parseComponentIntentFromAiResponse(aiResponse.content);
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
    // Preserve the AI's text description of the target element so the test
    // generation prompt can reference it when building precise selectors.
    targetElementDescription: step.targetElementDescription || undefined,
    targetElement: undefined,
  }));

  return {
    flowName: aiFlow.flowName,
    startingUrl: resolveStartingUrl(aiFlow.startingRoute, baseUrl),
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
  /**
   * When present, the target app is a Jira Forge Custom UI app rendered in an iframe.
   * The generated flows will use iframe navigation patterns instead of direct URL paths.
   */
  forgeAppContext?: ForgeAppContext;
}

/**
 * Maps a set of ComponentAnalysis objects into UserFlow objects by using AI
 * to understand the connections between components and the journeys users take.
 *
 * Components are processed in provider-aware batches. The Copilot API's 16 384-token
 * output cap lets most apps complete flow mapping in a single batch; GitHub Models'
 * 4 096-token cap requires more, smaller batches. Flows from all batches are merged.
 *
 * This is the bridge between raw code analysis and test generation.
 */
export async function mapComponentAnalysesToUserFlows(
  componentAnalyses: ComponentAnalysis[],
  aiClient: AiClient,
  options: FlowMapperOptions,
): Promise<UserFlow[]> {
  const { targetAppUrl, shouldAnalyzeIndividualComponents, appSpec, forgeAppContext } = options;

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

  // Split components into provider-aware token batches. The Copilot API supports
  // 16 384 output tokens vs GitHub Models' 4 096, so the same 26-component app
  // that needs 22 batches on GitHub Models can fit into 5–6 on Copilot.
  const batchOutputBudget = aiClient.flowBatchOutputBudget;
  const componentBatches = splitIntoDynamicBatches(componentAnalyses, batchOutputBudget);
  const totalEstimatedTokens = componentAnalyses.reduce(
    (total, component) => total + estimateComponentOutputTokens(component),
    0,
  );
  logDebug(
    `Generating user flows from ${componentAnalyses.length} components in ` +
    `${componentBatches.length} batch(es) (~${totalEstimatedTokens} estimated output tokens total).`,
  );

  const allAiGeneratedFlows: AiGeneratedFlow[] = [];

  // Create a concurrency limiter with the provider's concurrency setting.
  // GitHub Models and Copilot use limit=1 (sequential) to avoid rate-limit
  // penalties. OpenAI and Anthropic use limit=5 for real throughput gains.
  const batchConcurrencyLimit = pLimit(aiClient.concurrencyLimit);

  const batchPromises = componentBatches.map((currentBatch, batchIndex) =>
    batchConcurrencyLimit(async () => {
      const batchEstimatedTokens = currentBatch.reduce(
        (total, component) => total + estimateComponentOutputTokens(component),
        BATCH_RESPONSE_OVERHEAD_TOKENS,
      );
      const batchLabel = `user flow generation (batch ${batchIndex + 1}/${componentBatches.length})`;
      logDebug(
        `  ${batchLabel}: ${currentBatch.length} components, ~${batchEstimatedTokens} estimated output tokens`,
      );

      const flowGenerationMessages = buildUserFlowGenerationPrompt(currentBatch, targetAppUrl, appSpec, forgeAppContext);

      let flowGenerationResponse;
      try {
        flowGenerationResponse = await aiClient.chat(flowGenerationMessages, batchLabel);
      } catch (batchError) {
        logWarning(
          `Batch ${batchIndex + 1}/${componentBatches.length} failed after all retries — skipping. ` +
          `(${batchError instanceof Error ? batchError.message : String(batchError)})`,
        );
        return null;
      }

      const batchFlows = parseFlowsFromAiResponse(flowGenerationResponse.content, batchLabel);
      if (!batchFlows) {
        logWarning(`Batch ${batchIndex + 1} returned no valid flows — skipping.`);
      }
      return batchFlows;
    }),
  );

  const batchResults = await Promise.all(batchPromises);

  for (const batchFlows of batchResults) {
    if (batchFlows && Array.isArray(batchFlows)) {
      allAiGeneratedFlows.push(...batchFlows);
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
