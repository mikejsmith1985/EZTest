/**
 * Unified AI client that abstracts over OpenAI and Anthropic.
 * All AI calls in EZTest go through here, giving us consistent retry logic,
 * error handling, token tracking, and the ability to swap providers without
 * changing any other code.
 */
import type { AiMessage, AiResponse } from './types.js';
import type { AiConfig } from './config.js';
import { getDefaultModelForProvider } from './config.js';
import { logDebug, logWarning } from './logger.js';

// ── Provider Client Interfaces ─────────────────────────────────────────────

/** Internal interface that each provider adapter must implement. */
interface ProviderAdapter {
  sendMessages(messages: AiMessage[], modelName: string, maxTokens: number): Promise<AiResponse>;
}

// ── OpenAI Adapter ─────────────────────────────────────────────────────────

/**
 * Adapter for the OpenAI API.
 * Uses dynamic import to avoid bundling the SDK when using Anthropic instead.
 */
async function createOpenAiAdapter(apiKey: string): Promise<ProviderAdapter> {
  const { default: OpenAI } = await import('openai');
  // Disable the OpenAI SDK's built-in retry — EZTest has its own retry wrapper with
  // exponential backoff and retry-after header support. Double-retrying compounds
  // the wait time from GitHub Models rate-limit cooldowns from seconds to minutes.
  const openAiClient = new OpenAI({ apiKey, maxRetries: 0 });

  return {
    async sendMessages(messages, modelName, maxTokens) {
      const response = await openAiClient.chat.completions.create({
        model: modelName,
        messages,
        max_tokens: maxTokens,
      });

      const firstChoice = response.choices[0];
      if (!firstChoice?.message.content) {
        throw new Error('OpenAI returned an empty response');
      }

      return {
        content: firstChoice.message.content,
        tokensUsed: response.usage?.total_tokens ?? 0,
        modelUsed: response.model,
      };
    },
  };
}

// ── GitHub Copilot Adapter ─────────────────────────────────────────────────

/** Base URL for the GitHub Models API — compatible with the OpenAI chat completions spec. */
const GITHUB_MODELS_BASE_URL = 'https://models.inference.ai.azure.com';

/**
 * Adapter for the GitHub Models API (used by GitHub Copilot subscribers).
 * Reuses the OpenAI SDK since GitHub Models is OpenAI-spec compatible.
 * Authentication is a GitHub Personal Access Token with the `models:read` scope.
 */
async function createGitHubCopilotAdapter(githubToken: string): Promise<ProviderAdapter> {
  const { default: OpenAI } = await import('openai');

  // The OpenAI SDK accepts a custom baseURL + any token format in apiKey —
  // GitHub Models validates the Bearer token server-side, not the SDK itself.
  // maxRetries: 0 — EZTest's own retry wrapper handles retries with retry-after support.
  const githubModelsClient = new OpenAI({
    apiKey: githubToken,
    baseURL: GITHUB_MODELS_BASE_URL,
    maxRetries: 0,
  });

  return {
    async sendMessages(messages, modelName, maxTokens) {
      const response = await githubModelsClient.chat.completions.create({
        model: modelName,
        messages,
        max_tokens: maxTokens,
      });

      const firstChoice = response.choices[0];
      if (!firstChoice?.message.content) {
        throw new Error('GitHub Models API returned an empty response');
      }

      return {
        content: firstChoice.message.content,
        tokensUsed: response.usage?.total_tokens ?? 0,
        modelUsed: response.model,
      };
    },
  };
}

// ── Anthropic Adapter ──────────────────────────────────────────────────────

/**
 * Adapter for the Anthropic API.
 * Handles the Anthropic message format difference (system message is a top-level field).
 */
async function createAnthropicAdapter(apiKey: string): Promise<ProviderAdapter> {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const anthropicClient = new Anthropic({ apiKey });

  return {
    async sendMessages(messages, modelName, maxTokens) {
      // Anthropic separates the system message from the conversation messages
      const systemMessage = messages.find(message => message.role === 'system');
      const conversationMessages = messages.filter(message => message.role !== 'system');

      const response = await anthropicClient.messages.create({
        model: modelName,
        max_tokens: maxTokens,
        system: systemMessage?.content,
        messages: conversationMessages.map(message => ({
          role: message.role as 'user' | 'assistant',
          content: message.content,
        })),
      });

      const firstContentBlock = response.content[0];
      if (!firstContentBlock || firstContentBlock.type !== 'text') {
        throw new Error('Anthropic returned an empty or non-text response');
      }

      return {
        content: firstContentBlock.text,
        tokensUsed: response.usage.input_tokens + response.usage.output_tokens,
        modelUsed: response.model,
      };
    },
  };
}

// ── Retry Logic ────────────────────────────────────────────────────────────

/** HTTP status codes that indicate a transient failure worth retrying. */
const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);

/** Base delay in milliseconds for exponential backoff on retries. */
const RETRY_BASE_DELAY_MS = 1000;

/**
 * Maximum retry-after delay we will actually honor.
 * GitHub Models returns a retry-after equal to the seconds until the DAILY quota
 * resets (~23 hours) when the daily limit is exhausted. Waiting that long makes
 * no sense — we detect it and fail fast with an actionable message instead.
 */
const MAX_RETRYABLE_DELAY_MS = 300_000; // 5 minutes — anything longer signals quota exhaustion

/**
 * Determines whether an error is a transient API failure that should be retried.
 * Token-limit errors (413 tokens_limit_reached) are included because GitHub Models
 * uses them for BOTH per-request size violations and per-minute TPM rate limits.
 */
function isTransientApiError(error: unknown): boolean {
  if (error instanceof Error) {
    const errorMessage = error.message.toLowerCase();
    // Rate limits, token limits, and server errors are worth retrying
    if (
      errorMessage.includes('rate limit') ||
      errorMessage.includes('overloaded') ||
      errorMessage.includes('tokens_limit_reached') ||
      errorMessage.includes('too many requests')
    ) {
      return true;
    }
  }
  // Check for HTTP status-based errors (varies by SDK)
  if (typeof error === 'object' && error !== null && 'status' in error) {
    const httpStatus = (error as { status: number }).status;
    return RETRYABLE_STATUS_CODES.has(httpStatus) || httpStatus === 413;
  }
  return false;
}

/**
 * Extracts the `retry-after` delay in milliseconds from an API error, if present.
 * GitHub Models (and OpenAI) include this header in 429 responses to tell clients
 * exactly how long to wait before retrying. Ignoring it and using a short fixed
 * backoff means we retry too soon and accumulate additional penalties.
 *
 * Returns null if no valid retry-after header is found OR if the value exceeds
 * MAX_RETRYABLE_DELAY_MS (which signals daily quota exhaustion, not a short rate limit).
 */
function extractRetryAfterDelayMs(error: unknown): number | null {
  if (typeof error !== 'object' || error === null) return null;
  const errorWithHeaders = error as { headers?: Headers | Record<string, string> };
  if (!errorWithHeaders.headers) return null;

  let retryAfterValue: string | null | undefined;
  if (errorWithHeaders.headers instanceof Headers) {
    retryAfterValue = errorWithHeaders.headers.get('retry-after');
  } else if (typeof errorWithHeaders.headers === 'object') {
    retryAfterValue = (errorWithHeaders.headers as Record<string, string>)['retry-after'];
  }

  if (!retryAfterValue) return null;

  const retryAfterSeconds = parseFloat(retryAfterValue);
  if (!isNaN(retryAfterSeconds) && retryAfterSeconds > 0) {
    const delayMs = retryAfterSeconds * 1000 + 500;
    // If the server is asking us to wait longer than 5 minutes, it's a quota-exhaustion
    // signal (GitHub Models returns ~23 hours when the daily limit is hit). Return null
    // so the caller falls through to the quota-exhaustion check in executeWithRetry.
    if (delayMs > MAX_RETRYABLE_DELAY_MS) {
      logWarning(
        `API quota exhausted — retry-after is ${Math.round(retryAfterSeconds / 3600)}h ${Math.round((retryAfterSeconds % 3600) / 60)}m. ` +
        `Daily limit reached. Switch to a different AI provider or wait for the quota to reset.`
      );
      return null;
    }
    return delayMs;
  }
  return null;
}

/**
 * Returns true if the error object has any retry-after header, regardless of its value.
 * Used to distinguish between "no rate limit info" (use backoff) vs "quota exhausted"
 * (extractRetryAfterDelayMs returned null because the delay was too long to honor).
 */
function hasRetryAfterHeader(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const errorWithHeaders = error as { headers?: Headers | Record<string, string> };
  if (!errorWithHeaders.headers) return false;
  if (errorWithHeaders.headers instanceof Headers) {
    return errorWithHeaders.headers.has('retry-after');
  }
  return 'retry-after' in (errorWithHeaders.headers as Record<string, string>);
}

/**
 * Executes an AI API call with exponential backoff retry on transient failures.
 * Respects the `retry-after` header when present — GitHub Models and OpenAI send
 * this with 429 responses. Using it prevents compounding rate-limit penalties
 * that would otherwise turn a 15-second cooldown into a multi-minute stall.
 */
async function executeWithRetry<ReturnType>(
  operation: () => Promise<ReturnType>,
  maxRetryAttempts: number,
  operationDescription: string,
): Promise<ReturnType> {
  let lastError: unknown;

  for (let attemptIndex = 0; attemptIndex <= maxRetryAttempts; attemptIndex++) {
    try {
      return await operation();
    } catch (callError) {
      lastError = callError;

      if (attemptIndex < maxRetryAttempts && isTransientApiError(callError)) {
        // Prefer the server-specified retry-after delay over our own backoff.
        // The GitHub Models API sends a retry-after header that tells us exactly
        // how long its rate-limit window is (often 15-60 seconds). Ignoring it
        // and retrying with a 1-4 second backoff triggers additional penalties.
        const retryAfterDelayMs = extractRetryAfterDelayMs(callError);

        // extractRetryAfterDelayMs returns null for quota-exhaustion delays (> 5 min).
        // When a long retry-after is detected, the warning is already logged; we stop
        // retrying immediately because no amount of waiting will help until the daily
        // quota resets (~23 hours on GitHub Models free tier).
        if (retryAfterDelayMs === null && hasRetryAfterHeader(callError)) {
          break;
        }

        const backoffDelayMs = RETRY_BASE_DELAY_MS * Math.pow(2, attemptIndex);
        const waitDelayMs = retryAfterDelayMs ?? backoffDelayMs;

        logWarning(
          `AI call failed (attempt ${attemptIndex + 1}/${maxRetryAttempts + 1}) for "${operationDescription}". ` +
          `Retrying in ${Math.round(waitDelayMs / 1000)}s${retryAfterDelayMs ? ' (retry-after)' : ''}...`,
        );
        await new Promise(resolve => setTimeout(resolve, waitDelayMs));
      } else {
        break;
      }
    }
  }

  throw lastError;
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * The EZTest AI client. Holds a configured provider adapter and exposes a
 * single `chat()` method that all modules use for AI calls.
 */
export class AiClient {
  private readonly aiConfig: AiConfig;
  private readonly resolvedModelName: string;
  private providerAdapter: ProviderAdapter | null = null;

  constructor(aiConfig: AiConfig) {
    this.aiConfig = aiConfig;
    this.resolvedModelName = aiConfig.modelOverride ?? getDefaultModelForProvider(aiConfig.provider);
  }

  /**
   * Initializes the underlying provider SDK client.
   * Must be called once before any `chat()` calls.
   */
  async initialize(): Promise<void> {
    if (!this.aiConfig.apiKey) {
      throw new Error(
        `No AI API key found. Please set one of the following in your .env file:\n` +
        `  EZTEST_GITHUB_TOKEN=<your GitHub PAT with models:read scope>  (GitHub Copilot)\n` +
        `  OPENAI_API_KEY=<your OpenAI key>                              (OpenAI)\n` +
        `  ANTHROPIC_API_KEY=<your Anthropic key>                        (Anthropic Claude)\n\n` +
        `Create a free GitHub PAT at: https://github.com/settings/tokens?type=beta\n` +
        `(Account permissions → Models → Read-only)`
      );
    }

    if (this.aiConfig.provider === 'github') {
      this.providerAdapter = await createGitHubCopilotAdapter(this.aiConfig.apiKey);
    } else if (this.aiConfig.provider === 'openai') {
      this.providerAdapter = await createOpenAiAdapter(this.aiConfig.apiKey);
    } else {
      this.providerAdapter = await createAnthropicAdapter(this.aiConfig.apiKey);
    }

    logDebug(`AI client initialized: provider=${this.aiConfig.provider}, model=${this.resolvedModelName}`);
  }

  /**
   * Sends a conversation to the AI and returns the response.
   * Retries automatically on transient failures.
   */
  async chat(messages: AiMessage[], operationDescription: string): Promise<AiResponse> {
    if (!this.providerAdapter) {
      throw new Error('AiClient.initialize() must be called before chat()');
    }

    return executeWithRetry(
      () => this.providerAdapter!.sendMessages(messages, this.resolvedModelName, this.aiConfig.maxTokensPerCall),
      this.aiConfig.maxRetryAttempts,
      operationDescription,
    );
  }

  /** Returns the model name being used for logging and reporting purposes. */
  get modelName(): string {
    return this.resolvedModelName;
  }

  /** Returns the provider name being used. */
  get providerName(): string {
    return this.aiConfig.provider;
  }
}
