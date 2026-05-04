/**
 * Zod schemas and parser functions for AI-generated JSON responses.
 * Centralizes all AI response validation so every module benefits from
 * type-safe, schema-validated output rather than raw JSON casts.
 */
import { z } from 'zod';
import { logWarning, logDebug } from '../shared/logger.js';

// ── Zod Schemas ────────────────────────────────────────────────────────────

/**
 * Schema for a single step within a user flow.
 * Maps directly to the UserFlowStep type after normalization.
 */
const AiFlowStepSchema = z.object({
  stepDescription: z.string(),
  /** The visible UI element the user interacts with — optional since navigation steps may not have one. */
  targetElementDescription: z.string().optional(),
  expectedOutcome: z.string(),
  isNavigation: z.boolean(),
});

/**
 * Schema for a single AI-generated user flow before normalization.
 * All fields are required so invalid/partial AI responses are caught early.
 */
const AiGeneratedFlowSchema = z.object({
  flowName: z.string(),
  startingRoute: z.string(),
  flowKind: z.enum(['happy-path', 'error-case', 'edge-case']),
  steps: z.array(AiFlowStepSchema),
  involvedComponents: z.array(z.string()),
  testPriority: z.enum(['critical', 'high', 'medium', 'low']),
});

/**
 * Validates the top-level array of flows the AI returns for flow generation.
 * Exported so callers can reuse the schema for custom validation if needed.
 */
export const AiFlowArraySchema = z.array(AiGeneratedFlowSchema);

/**
 * Schema for the AI's component intent analysis response.
 * Describes the user-facing purpose of a single component.
 */
const ComponentIntentResponseSchema = z.object({
  componentPurpose: z.string(),
  userActions: z.array(z.string()),
  /** Optional setup notes (e.g., "user must be authenticated") */
  requiredSetup: z.string().optional(),
});

// ── Exported Types ─────────────────────────────────────────────────────────

/** A single user flow as returned by the AI before normalization into EZTest's UserFlow type. */
export type AiGeneratedFlow = z.infer<typeof AiGeneratedFlowSchema>;

/** The AI's structured description of a component's user-facing purpose and actions. */
export type ComponentIntentResponse = z.infer<typeof ComponentIntentResponseSchema>;

// ── Internal Helpers ───────────────────────────────────────────────────────

/**
 * Attempts to recover a valid JSON array from content that was cut off mid-stream
 * because the model hit its output token limit. Tries three increasingly aggressive
 * strategies to close the truncated JSON structure.
 * Returns null if none of the strategies produce a parseable array.
 */
function recoverTruncatedJsonArray(rawContent: string): unknown[] | null {
  // Strategies ordered from least destructive to most — stop at the first that works
  const recoveryStrategies = [
    rawContent + ']',
    rawContent + '"}]',
    rawContent + '"]}]',
  ];

  for (const recoveryAttempt of recoveryStrategies) {
    try {
      const parsed = JSON.parse(recoveryAttempt);
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed;
      }
    } catch {
      // This strategy didn't work — try the next one
    }
  }

  return null;
}

// ── Public Parsers ─────────────────────────────────────────────────────────

/**
 * Parses and validates the AI's flow generation response into a typed array.
 *
 * Pipeline:
 * 1. Strips any accidental markdown code fences
 * 2. JSON.parses the cleaned content
 * 3. If parse fails and content looks like a truncated array, attempts recovery
 * 4. Validates the parsed value against AiFlowArraySchema via Zod
 *
 * @param rawContent - The raw string returned by the AI model
 * @param operationDescription - Human-readable label for the operation (used in warning logs)
 * @returns The validated array of flows, or null if parsing or validation fails
 */
export function parseFlowsFromAiResponse(
  rawContent: string,
  operationDescription: string,
): AiGeneratedFlow[] | null {
  // Strip markdown fences that the AI may include despite explicit instructions not to
  const cleanedContent = rawContent
    .replace(/^```(?:json)?\s*/m, '')
    .replace(/\s*```\s*$/m, '')
    .trim();

  let parsedValue: unknown = null;
  let parseSucceeded = false;

  try {
    parsedValue = JSON.parse(cleanedContent);
    parseSucceeded = true;
  } catch {
    // Primary parse failed — attempt truncation recovery if it looks like a JSON array
    if (cleanedContent.startsWith('[')) {
      parsedValue = recoverTruncatedJsonArray(cleanedContent);
      if (parsedValue !== null) {
        parseSucceeded = true;
        logWarning(
          `AI response for "${operationDescription}" was truncated. ` +
          `Recovered ${(parsedValue as unknown[]).length} item(s) from the partial response.`,
        );
      }
    }
  }

  if (!parseSucceeded || parsedValue === null) {
    logWarning(`Could not parse AI JSON response for "${operationDescription}".`);
    logDebug(`Raw AI response (first 500 chars): ${rawContent.slice(0, 500)}`);
    return null;
  }

  const validationResult = AiFlowArraySchema.safeParse(parsedValue);
  if (!validationResult.success) {
    logWarning(
      `AI response for "${operationDescription}" failed schema validation: ` +
      validationResult.error.message,
    );
    return null;
  }

  return validationResult.data;
}

/**
 * Parses and validates the AI's component intent analysis response.
 *
 * Uses the same pipeline as parseFlowsFromAiResponse (fence stripping → JSON.parse →
 * Zod validation) but targets the ComponentIntentResponseSchema shape.
 *
 * @param rawContent - The raw string returned by the AI model
 * @returns The validated ComponentIntentResponse, or null if parsing or validation fails
 */
export function parseComponentIntentFromAiResponse(
  rawContent: string,
): ComponentIntentResponse | null {
  const cleanedContent = rawContent
    .replace(/^```(?:json)?\s*/m, '')
    .replace(/\s*```\s*$/m, '')
    .trim();

  let parsedValue: unknown;
  try {
    parsedValue = JSON.parse(cleanedContent);
  } catch {
    logWarning(`Could not parse component intent AI response as JSON.`);
    logDebug(`Raw AI response (first 500 chars): ${rawContent.slice(0, 500)}`);
    return null;
  }

  const validationResult = ComponentIntentResponseSchema.safeParse(parsedValue);
  if (!validationResult.success) {
    logWarning(
      `Component intent AI response failed schema validation: ` +
      validationResult.error.message,
    );
    return null;
  }

  return validationResult.data;
}
