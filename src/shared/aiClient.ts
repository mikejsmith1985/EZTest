/**
 * Unified AI client that abstracts over OpenAI and Anthropic.
 * All AI calls in EZTest go through here, giving us consistent retry logic,
 * error handling, token tracking, and the ability to swap providers without
 * changing any other code.
 */
import type { AiMessage, AiResponse } from './types.js';
import type { AiConfig } from './config.js';
import { getDefaultModelForProvider, GITHUB_FREE_MODEL_ROTATION, COPILOT_FREE_MODEL_ROTATION } from './config.js';
import { logDebug, logWarning } from './logger.js';
import { getCopilotSessionToken } from './copilotAuth.js';

// ── Quota Exhaustion Error ─────────────────────────────────────────────────

/**
 * Thrown by executeWithRetry when an AI model's daily free-tier quota is exhausted.
 * AiClient.chat() catches this error internally and rotates to the next model in
 * the rotation list — callers only see this if ALL models are exhausted.
 */
export class ModelQuotaExhaustedError extends Error {
  /** The model name whose daily quota was exhausted. */
  public readonly exhaustedModelName: string;
  /** Approximate seconds until this model's quota resets (from the retry-after header). */
  public readonly secondsUntilReset: number;

  constructor(exhaustedModelName: string, secondsUntilReset: number) {
    const resetHours = Math.round(secondsUntilReset / 3600);
    const resetMinutes = Math.round((secondsUntilReset % 3600) / 60);
    super(
      `Model "${exhaustedModelName}" daily quota exhausted. ` +
      `Resets in approximately ${resetHours}h ${resetMinutes}m.`,
    );
    this.name = 'ModelQuotaExhaustedError';
    this.exhaustedModelName = exhaustedModelName;
    this.secondsUntilReset = secondsUntilReset;
  }
}

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

// ── GitHub Copilot Chat API Adapter ───────────────────────────────────────

/** Base URL for the GitHub Copilot Chat API — separate from the GitHub Models endpoint. */
const COPILOT_API_BASE_URL = 'https://api.githubcopilot.com';

/**
 * Maximum output tokens supported by the Copilot API for the free (0x) models.
 * This is 4× the GitHub Models free-tier cap of 4 096 tokens, meaning no dynamic
 * batch splitting is needed for the vast majority of real-world component sets.
 */
const COPILOT_MAX_OUTPUT_TOKENS = 16_384;

/**
 * Headers the Copilot API expects to identify the calling editor.
 * These mirror what VS Code Copilot Chat sends; the server uses them for
 * routing and telemetry but does not enforce a specific client version.
 */
const COPILOT_EDITOR_HEADERS = {
  'Editor-Version':         'vscode/1.99.0',
  'Editor-Plugin-Version':  'copilot-chat/0.26.0',
  'Copilot-Integration-Id': 'vscode-chat',
  'User-Agent':             'GitHubCopilotChat/0.26.0',
} as const;

/**
 * Minimum delay (in milliseconds) between consecutive Copilot API calls.
 * The Copilot API aggressively rate-limits with intermittent 403 responses.
 * A 1.5-second cooldown between calls dramatically reduces the 403 rate,
 * making the overall pipeline faster than rapid-fire calls + retry backoff.
 */
const COPILOT_INTER_REQUEST_DELAY_MS = 1_500;

/** Timestamp of the last successful or attempted Copilot API call. */
let lastCopilotRequestTimestamp = 0;

/**
 * Adapter for the GitHub Copilot Chat API (api.githubcopilot.com).
 *
 * Benefits over the GitHub Models free tier:
 *   - 16 384 output tokens vs 4 096 — eliminates most batch-splitting overhead
 *   - No per-model daily request quotas (gpt-4.1 and gpt-5-mini are 0x premium)
 *   - OAuth token auto-fetched via `gh auth token` — no separate API key required
 *
 * Auth uses the gh CLI's keyring-stored OAuth token (with `copilot` scope).
 * The token is cached by `getCopilotSessionToken()` to avoid spawning a
 * subprocess on every API call.
 */
async function createCopilotChatApiAdapter(): Promise<ProviderAdapter> {
  const { default: OpenAI } = await import('openai');

  return {
    async sendMessages(messages, modelName, maxTokens) {
      // Proactive cooldown: wait between consecutive requests to avoid
      // triggering the Copilot API's aggressive 403 rate limiter
      const elapsedSinceLastRequest = Date.now() - lastCopilotRequestTimestamp;
      if (elapsedSinceLastRequest < COPILOT_INTER_REQUEST_DELAY_MS) {
        await new Promise(resolve =>
          setTimeout(resolve, COPILOT_INTER_REQUEST_DELAY_MS - elapsedSinceLastRequest),
        );
      }

      // Refresh the session token if it is near expiry — typically a no-op due to caching
      const sessionToken = await getCopilotSessionToken();

      const copilotClient = new OpenAI({
        apiKey:         sessionToken,
        baseURL:        COPILOT_API_BASE_URL,
        maxRetries:     0,
        defaultHeaders: COPILOT_EDITOR_HEADERS,
      });

      // Respect the caller's configured maxTokens but cap at the Copilot API's limit
      const effectiveMaxTokens = Math.min(maxTokens, COPILOT_MAX_OUTPUT_TOKENS);

      lastCopilotRequestTimestamp = Date.now();
      const response = await copilotClient.chat.completions.create({
        model:      modelName,
        messages,
        max_tokens: effectiveMaxTokens,
      });

      const firstChoice = response.choices[0];
      if (!firstChoice?.message.content) {
        throw new Error('GitHub Copilot API returned an empty response');
      }

      return {
        content:    firstChoice.message.content,
        tokensUsed: response.usage?.total_tokens ?? 0,
        modelUsed:  response.model,
      };
    },
  };
}

// ── Anthropic Adapter ──────────────────────────────────────────────────────

/**
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
const RETRYABLE_STATUS_CODES = new Set([403, 429, 500, 502, 503, 504]);

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
 * The Copilot API (api.githubcopilot.com) intermittently returns 403 "forbidden"
 * under rate-limiting conditions instead of the standard 429 — we treat these as
 * transient and retry with backoff.
 */
function isTransientApiError(error: unknown): boolean {
  if (error instanceof Error) {
    const errorMessage = error.message.toLowerCase();
    // Rate limits, token limits, server errors, and Copilot API transient 403s
    if (
      errorMessage.includes('rate limit') ||
      errorMessage.includes('overloaded') ||
      errorMessage.includes('tokens_limit_reached') ||
      errorMessage.includes('too many requests') ||
      errorMessage.includes('access to this endpoint is forbidden')
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
        `Daily limit reached. EZTest will automatically try the next available model in the free-tier rotation.`
      );
      return null;
    }
    return delayMs;
  }
  return null;
}

/**
 * Extracts the raw retry-after value in seconds from an API error.
 * Unlike extractRetryAfterDelayMs, this never filters out large values — it is
 * used to populate ModelQuotaExhaustedError with the actual reset time so the UI
 * can display a human-readable countdown to the user.
 */
function extractRetryAfterSeconds(error: unknown): number {
  if (typeof error !== 'object' || error === null) return 0;
  const errorWithHeaders = error as { headers?: Headers | Record<string, string> };
  if (!errorWithHeaders.headers) return 0;

  let retryAfterValue: string | null | undefined;
  if (errorWithHeaders.headers instanceof Headers) {
    retryAfterValue = errorWithHeaders.headers.get('retry-after');
  } else {
    retryAfterValue = (errorWithHeaders.headers as Record<string, string>)['retry-after'];
  }

  if (!retryAfterValue) return 0;
  const retryAfterSeconds = parseFloat(retryAfterValue);
  return isNaN(retryAfterSeconds) ? 0 : Math.max(0, retryAfterSeconds);
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
  currentModelName: string,
): Promise<ReturnType> {
  let lastError: unknown;

  for (let attemptIndex = 0; attemptIndex <= maxRetryAttempts; attemptIndex++) {
    try {
      return await operation();
    } catch (callError) {
      lastError = callError;

      if (isTransientApiError(callError)) {
        // Prefer the server-specified retry-after delay over our own backoff.
        // The GitHub Models API sends a retry-after header that tells us exactly
        // how long its rate-limit window is (often 15-60 seconds). Ignoring it
        // and retrying with a 1-4 second backoff triggers additional penalties.
        const retryAfterDelayMs = extractRetryAfterDelayMs(callError);

        // extractRetryAfterDelayMs returns null for quota-exhaustion delays (> 5 min).
        // This check runs before the retry guard so quota is always detected even when
        // maxRetryAttempts = 0. Throw so AiClient can rotate to the next free-tier model.
        if (retryAfterDelayMs === null && hasRetryAfterHeader(callError)) {
          throw new ModelQuotaExhaustedError(currentModelName, extractRetryAfterSeconds(callError));
        }

        if (attemptIndex < maxRetryAttempts) {
          const backoffDelayMs = RETRY_BASE_DELAY_MS * Math.pow(2, attemptIndex);
          const waitDelayMs = retryAfterDelayMs ?? backoffDelayMs;
          logWarning(
            `AI call failed (attempt ${attemptIndex + 1}/${maxRetryAttempts + 1}) for "${operationDescription}". ` +
            `Retrying in ${Math.round(waitDelayMs / 1000)}s${retryAfterDelayMs ? ' (retry-after)' : ''}...`,
          );
          await new Promise(resolve => setTimeout(resolve, waitDelayMs));
          continue;
        }
      }

      break;
    }
  }

  throw lastError;
}

// ── Model Rotation Builder ─────────────────────────────────────────────────

/**
 * Builds the ordered model rotation list for an AiConfig.
 *
 * - github provider:  returns the full free-tier rotation (18 models), sliced to start
 *                     at the configured model when a modelOverride is present.
 * - copilot provider: returns the 2-model 0x-premium rotation; custom override goes first.
 * - other providers:  single-element list (no rotation needed).
 */
function buildModelRotationList(aiConfig: AiConfig): readonly string[] {
  if (aiConfig.provider === 'github') {
    const configuredModel = aiConfig.modelOverride;
    if (!configuredModel) {
      return GITHUB_FREE_MODEL_ROTATION;
    }
    const configuredModelPosition = GITHUB_FREE_MODEL_ROTATION.indexOf(configuredModel);
    if (configuredModelPosition >= 0) {
      return GITHUB_FREE_MODEL_ROTATION.slice(configuredModelPosition);
    }
    return [configuredModel, ...GITHUB_FREE_MODEL_ROTATION];
  }

  if (aiConfig.provider === 'copilot') {
    const configuredModel = aiConfig.modelOverride;
    if (!configuredModel) {
      return COPILOT_FREE_MODEL_ROTATION;
    }
    const configuredModelPosition = COPILOT_FREE_MODEL_ROTATION.indexOf(configuredModel);
    if (configuredModelPosition >= 0) {
      return COPILOT_FREE_MODEL_ROTATION.slice(configuredModelPosition);
    }
    // Custom model not in the 0x list — honour it, then fall back to the 0x rotation
    return [configuredModel, ...COPILOT_FREE_MODEL_ROTATION];
  }

  // For OpenAI and Anthropic a single model is used — no free-tier rotation needed
  const singleModelName = aiConfig.modelOverride ?? getDefaultModelForProvider(aiConfig.provider);
  return [singleModelName];
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * The EZTest AI client. Holds a configured provider adapter and exposes a
 * single `chat()` method that all modules use for AI calls.
 * For GitHub Models provider, automatically rotates through 18+ free-tier
 * models when the active model's daily quota is exhausted.
 */
export class AiClient {
  private readonly aiConfig: AiConfig;
  /** Ordered list of model IDs to try. GitHub uses the full free-tier rotation. */
  private readonly modelRotationList: readonly string[];
  /** Index into modelRotationList pointing at the currently active model. */
  private activeModelIndex: number;
  private providerAdapter: ProviderAdapter | null = null;

  constructor(aiConfig: AiConfig) {
    this.aiConfig = aiConfig;
    this.activeModelIndex = 0;
    this.modelRotationList = buildModelRotationList(aiConfig);
  }

  /**
   * Initializes the underlying provider SDK client.
   * Must be called once before any `chat()` calls.
   */
  async initialize(): Promise<void> {
    if (!this.aiConfig.apiKey) {
      throw new Error(
        `No AI API key found. Please set one of the following in your .env file:\n` +
        `  EZTEST_GITHUB_TOKEN=<your GitHub PAT>  (GitHub Models or Copilot API — free tier)\n` +
        `    then optionally: EZTEST_AI_PROVIDER=copilot  (to use the Copilot Chat API endpoint)\n` +
        `  OPENAI_API_KEY=<your OpenAI key>        (OpenAI GPT models)\n` +
        `  ANTHROPIC_API_KEY=<your Anthropic key>  (Anthropic Claude models)\n\n` +
        `Create a free GitHub PAT at: https://github.com/settings/tokens?type=beta\n` +
        `(Account permissions → Models → Read-only)`
      );
    }

    if (this.aiConfig.provider === 'github') {
      this.providerAdapter = await createGitHubCopilotAdapter(this.aiConfig.apiKey);
    } else if (this.aiConfig.provider === 'copilot') {
      // Copilot Chat API — auth comes from gh CLI, apiKey is just the GitHub token
      // used to validate the user has a Copilot subscription; the session token is
      // fetched and refreshed internally by createCopilotChatApiAdapter().
      this.providerAdapter = await createCopilotChatApiAdapter();
    } else if (this.aiConfig.provider === 'openai') {
      this.providerAdapter = await createOpenAiAdapter(this.aiConfig.apiKey);
    } else {
      this.providerAdapter = await createAnthropicAdapter(this.aiConfig.apiKey);
    }

    logDebug(
      `AI client initialized: provider=${this.aiConfig.provider}, ` +
      `model=${this.modelName}, rotation_size=${this.modelRotationList.length}`,
    );
  }

  /**
   * Sends a conversation to the AI and returns the response.
   * Retries on transient failures. For GitHub provider, automatically rotates
   * to the next free-tier model when the active model's daily quota is exhausted.
   */
  async chat(messages: AiMessage[], operationDescription: string): Promise<AiResponse> {
    if (!this.providerAdapter) {
      throw new Error('AiClient.initialize() must be called before chat()');
    }

    // Iterate through models until one succeeds or all are exhausted.
    // Non-quota errors always propagate immediately without trying other models.
    while (this.activeModelIndex < this.modelRotationList.length) {
      const currentModel = this.modelRotationList[this.activeModelIndex];

      try {
        return await executeWithRetry(
          () => this.providerAdapter!.sendMessages(messages, currentModel, this.aiConfig.maxTokensPerCall),
          this.aiConfig.maxRetryAttempts,
          operationDescription,
          currentModel,
        );
      } catch (callError) {
        if (!(callError instanceof ModelQuotaExhaustedError)) {
          throw callError; // Non-quota errors always propagate immediately
        }

        const nextModelIndex = this.activeModelIndex + 1;
        if (nextModelIndex >= this.modelRotationList.length) {
          const providerLabel = this.aiConfig.provider === 'copilot'
            ? 'Copilot API 0x-premium'
            : 'GitHub Models free-tier';
          throw new Error(
            `All ${this.modelRotationList.length} models in the ${providerLabel} rotation ` +
            `have exhausted their daily quota. Options:\n` +
            `  • Wait for quotas to reset (usually midnight UTC)\n` +
            `  • Use --no-review or --max-flows 5 to reduce API calls per run\n` +
            (this.aiConfig.provider === 'github'
              ? `  • Set EZTEST_AI_PROVIDER=copilot (requires GitHub Copilot Pro — no daily quotas)\n`
              : '') +
            `  • Configure a paid provider: OPENAI_API_KEY or ANTHROPIC_API_KEY in your .env`,
          );
        }

        const nextModelName = this.modelRotationList[nextModelIndex];
        logWarning(
          `Model "${currentModel}" daily quota exhausted. ` +
          `Auto-rotating to "${nextModelName}" ` +
          `(${nextModelIndex + 1}/${this.modelRotationList.length} in rotation).`,
        );
        this.activeModelIndex = nextModelIndex;
      }
    }

    // Unreachable — the while-loop always returns or throws before this point.
    // TypeScript requires an explicit return/throw after the loop.
    throw new Error('Model rotation exhausted all available models unexpectedly');
  }

  /** Returns the currently active model name, for logging and reporting purposes. */
  get modelName(): string {
    return this.modelRotationList[this.activeModelIndex];
  }

  /** Returns the provider name being used. */
  get providerName(): string {
    return this.aiConfig.provider;
  }

  /** Returns the total number of models in the rotation list. */
  get rotationSize(): number {
    return this.modelRotationList.length;
  }

  /**
   * Returns true when the provider uses a daily-capped free-tier model rotation.
   * Callers use this to make quota-aware decisions (e.g., auto-disabling expensive
   * second-pass features when a run would burn through multiple model quotas).
   */
  get hasFreeTierQuotaLimits(): boolean {
    return this.aiConfig.provider === 'github';
  }
}
