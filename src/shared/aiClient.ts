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
  const openAiClient = new OpenAI({ apiKey });

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
 * Determines whether an error is a transient API failure that should be retried.
 */
function isTransientApiError(error: unknown): boolean {
  if (error instanceof Error) {
    const errorMessage = error.message.toLowerCase();
    // Rate limits and server errors are worth retrying
    if (errorMessage.includes('rate limit') || errorMessage.includes('overloaded')) {
      return true;
    }
  }
  // Check for HTTP status-based errors (varies by SDK)
  if (typeof error === 'object' && error !== null && 'status' in error) {
    return RETRYABLE_STATUS_CODES.has((error as { status: number }).status);
  }
  return false;
}

/**
 * Executes an AI API call with exponential backoff retry on transient failures.
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
        const delayMs = RETRY_BASE_DELAY_MS * Math.pow(2, attemptIndex);
        logWarning(`AI call failed (attempt ${attemptIndex + 1}/${maxRetryAttempts + 1}) for "${operationDescription}". Retrying in ${delayMs}ms...`);
        await new Promise(resolve => setTimeout(resolve, delayMs));
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
        `No AI API key found. Set OPENAI_API_KEY or ANTHROPIC_API_KEY in your environment, ` +
        `or configure it in eztest.config.json.`
      );
    }

    if (this.aiConfig.provider === 'openai') {
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
