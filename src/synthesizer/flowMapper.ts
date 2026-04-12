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
 */
async function analyzeComponentIntent(
  componentAnalysis: ComponentAnalysis,
  aiClient: AiClient,
): Promise<ComponentIntentResponse | null> {
  const promptMessages = buildComponentIntentPrompt(componentAnalysis);

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
}

/**
 * Maps a set of ComponentAnalysis objects into UserFlow objects by using AI
 * to understand the connections between components and the journeys users take.
 *
 * This is the bridge between raw code analysis and test generation.
 */
export async function mapComponentAnalysesToUserFlows(
  componentAnalyses: ComponentAnalysis[],
  aiClient: AiClient,
  options: FlowMapperOptions,
): Promise<UserFlow[]> {
  const { targetAppUrl, shouldAnalyzeIndividualComponents } = options;

  // Optionally run per-component intent analysis to enrich the context
  // This helps the flow generation prompt produce better-connected journeys
  if (shouldAnalyzeIndividualComponents && componentAnalyses.length <= 20) {
    logDebug(`Running per-component intent analysis for ${componentAnalyses.length} components...`);

    for (const componentAnalysis of componentAnalyses) {
      const intent = await analyzeComponentIntent(componentAnalysis, aiClient);
      if (intent) {
        // Attach the inferred purpose to each component's route path for context
        componentAnalysis.routePath = componentAnalysis.routePath ?? intent.requiredSetup;
        logDebug(`  ${componentAnalysis.componentName}: ${intent.componentPurpose}`);
      }
    }
  }

  // Generate the complete set of user flows from the full component picture
  logDebug(`Generating user flows from ${componentAnalyses.length} components...`);

  const flowGenerationMessages = buildUserFlowGenerationPrompt(componentAnalyses, targetAppUrl);
  const flowGenerationResponse = await aiClient.chat(
    flowGenerationMessages,
    'user flow generation',
  );

  const aiGeneratedFlows = parseAiJsonResponse<AiGeneratedFlow[]>(
    flowGenerationResponse.content,
    'user flow generation',
  );

  if (!aiGeneratedFlows || !Array.isArray(aiGeneratedFlows)) {
    logWarning('Flow generation returned no valid flows. Check AI response above.');
    return [];
  }

  logDebug(`AI generated ${aiGeneratedFlows.length} user flows`);

  const normalizedFlows = aiGeneratedFlows.map(aiFlow =>
    normalizeAiGeneratedFlow(aiFlow, targetAppUrl),
  );

  return normalizedFlows;
}
