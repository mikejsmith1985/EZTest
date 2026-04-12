/**
 * Unit tests for the AiClient model rotation feature.
 * Verifies that quota-exhausted models are automatically bypassed and the next
 * model in the free-tier rotation list is tried, enabling uninterrupted test generation.
 */
import { test, expect } from '@playwright/test';
import { AiClient, ModelQuotaExhaustedError } from '../../src/shared/aiClient.js';
import { GITHUB_FREE_MODEL_ROTATION, type AiConfig } from '../../src/shared/config.js';
import type { AiMessage } from '../../src/shared/types.js';

// ── Test Fixtures ──────────────────────────────────────────────────────────

/** A minimal single-turn conversation used as input across all AiClient tests. */
const SAMPLE_CONVERSATION: AiMessage[] = [
  { role: 'user', content: 'Write a Playwright test for the login form.' },
];

/**
 * Seconds until a GitHub Models daily quota resets (~23 hours).
 * This value exceeds the 300-second MAX_RETRYABLE_DELAY_MS threshold,
 * which is how EZTest detects quota exhaustion versus a short rate limit.
 */
const GITHUB_DAILY_QUOTA_RESET_SECONDS = 82_800;

/**
 * Builds a minimal AiConfig for the GitHub Copilot provider.
 * Sets maxRetryAttempts to 0 so retry delays never slow down unit tests.
 */
function createGitHubProviderConfig(overrides: Partial<AiConfig> = {}): AiConfig {
  return {
    provider: 'github',
    apiKey: 'fake-github-pat',
    maxTokensPerCall: 4096,
    maxRetryAttempts: 0,
    ...overrides,
  };
}

/** Builds a minimal AiConfig for the OpenAI provider. */
function createOpenAiProviderConfig(overrides: Partial<AiConfig> = {}): AiConfig {
  return {
    provider: 'openai',
    apiKey: 'sk-fake-openai-key',
    maxTokensPerCall: 4096,
    maxRetryAttempts: 0,
    ...overrides,
  };
}

/** Builds a minimal AiConfig for the Anthropic provider. */
function createAnthropicProviderConfig(overrides: Partial<AiConfig> = {}): AiConfig {
  return {
    provider: 'anthropic',
    apiKey: 'sk-ant-fake-key',
    maxTokensPerCall: 4096,
    maxRetryAttempts: 0,
    ...overrides,
  };
}

/**
 * Creates an error that simulates a GitHub Models 429 response whose retry-after
 * header signals daily quota exhaustion (value far exceeds the 5-minute threshold).
 */
function createQuotaExhaustedApiError(
  retryAfterSeconds: number = GITHUB_DAILY_QUOTA_RESET_SECONDS,
): Error {
  return Object.assign(new Error('Rate limit exceeded'), {
    status: 429,
    // Plain object headers — matches the Record<string, string> branch in hasRetryAfterHeader
    headers: { 'retry-after': String(retryAfterSeconds) },
  });
}

/**
 * Creates a mock provider adapter whose every sendMessages call succeeds.
 * The response echoes back the modelName that was passed in.
 */
function createSucceedingMockAdapter(responseContent: string = 'mock AI response') {
  return {
    sendMessages: async (_messages: unknown, modelName: string, _maxTokens: unknown) => ({
      content: responseContent,
      tokensUsed: 10,
      modelUsed: modelName,
    }),
  };
}

/**
 * Creates a mock provider adapter that always throws a daily-quota-exhausted error.
 * Used to exercise the "all models exhausted" code path.
 */
function createExhaustAllModelsMockAdapter() {
  return {
    sendMessages: async () => {
      throw createQuotaExhaustedApiError();
    },
  };
}

// ── ModelQuotaExhaustedError ───────────────────────────────────────────────

test.describe('ModelQuotaExhaustedError', () => {
  // Verify the custom error class behaves as a proper typed Error subclass so callers can
  // catch it specifically and inspect its properties without parsing message strings.

  /** The name discriminator lets catch blocks distinguish quota errors from generic Errors. */
  test('name property equals ModelQuotaExhaustedError', () => {
    const error = new ModelQuotaExhaustedError('gpt-4.1', GITHUB_DAILY_QUOTA_RESET_SECONDS);
    expect(error.name).toBe('ModelQuotaExhaustedError');
  });

  /** exhaustedModelName lets the rotation loop know which model to skip. */
  test('stores the exhausted model name on exhaustedModelName', () => {
    const error = new ModelQuotaExhaustedError('gpt-4o', 3600);
    expect(error.exhaustedModelName).toBe('gpt-4o');
  });

  /** secondsUntilReset allows the caller to log a precise human-readable countdown. */
  test('stores the seconds until reset on secondsUntilReset', () => {
    const expectedResetSeconds = 7200;
    const error = new ModelQuotaExhaustedError('gpt-4o', expectedResetSeconds);
    expect(error.secondsUntilReset).toBe(expectedResetSeconds);
  });

  /** The model name must appear in the message so users immediately know which model hit the limit. */
  test('message includes the exhausted model name', () => {
    const targetModelName = 'gpt-4.1-mini';
    const error = new ModelQuotaExhaustedError(targetModelName, GITHUB_DAILY_QUOTA_RESET_SECONDS);
    expect(error.message).toContain(targetModelName);
  });

  /** Verify the h/m rounding logic with a value that produces non-zero minutes. */
  test('message formats the reset time as hours and minutes rounded correctly', () => {
    // 3661 seconds → Math.round(3661/3600) = 1h, Math.round(61/60) = 1m
    const secondsForOneHourOneMinute = 3661;
    const error = new ModelQuotaExhaustedError('gpt-4.1', secondsForOneHourOneMinute);
    expect(error.message).toBe(
      'Model "gpt-4.1" daily quota exhausted. Resets in approximately 1h 1m.',
    );
  });

  /** Full message format check against the typical 23-hour GitHub Models quota window. */
  test('message matches the expected format for a 23-hour daily quota window', () => {
    // 82800 seconds = exactly 23h 0m
    const error = new ModelQuotaExhaustedError('gpt-4.1', GITHUB_DAILY_QUOTA_RESET_SECONDS);
    expect(error.message).toBe(
      'Model "gpt-4.1" daily quota exhausted. Resets in approximately 23h 0m.',
    );
  });

  /** instanceof check must work so catch blocks can use `error instanceof ModelQuotaExhaustedError`. */
  test('is an instance of ModelQuotaExhaustedError', () => {
    const error = new ModelQuotaExhaustedError('gpt-4.1', 3600);
    expect(error).toBeInstanceOf(ModelQuotaExhaustedError);
  });

  /** Must also pass the Error instanceof check so generic error handlers still catch it. */
  test('is an instance of Error', () => {
    const error = new ModelQuotaExhaustedError('gpt-4.1', 3600);
    expect(error).toBeInstanceOf(Error);
  });
});

// ── GITHUB_FREE_MODEL_ROTATION ─────────────────────────────────────────────

test.describe('GITHUB_FREE_MODEL_ROTATION', () => {
  // Validate the exported rotation list is well-formed so the rotation feature
  // has a sufficient pool of fallback models to survive a multi-model quota exhaustion.

  /** A missing or empty list would make the rotation feature a no-op. */
  test('is a non-empty array', () => {
    expect(Array.isArray(GITHUB_FREE_MODEL_ROTATION)).toBe(true);
    expect(GITHUB_FREE_MODEL_ROTATION.length).toBeGreaterThan(0);
  });

  /** gpt-4.1 must come first because it produces the best test quality on the free tier. */
  test('first entry is gpt-4.1', () => {
    expect(GITHUB_FREE_MODEL_ROTATION[0]).toBe('gpt-4.1');
  });

  /** gpt-4o is the current default model and must be preserved as a strong fallback. */
  test('contains gpt-4o as a fallback', () => {
    expect(GITHUB_FREE_MODEL_ROTATION).toContain('gpt-4o');
  });

  /** gpt-4.1-mini provides a lighter-weight option when heavier models exhaust their quota. */
  test('contains gpt-4.1-mini as a lighter fallback', () => {
    expect(GITHUB_FREE_MODEL_ROTATION).toContain('gpt-4.1-mini');
  });

  /** gpt-4o-mini is the lightest widely-available fallback for free-tier users. */
  test('contains gpt-4o-mini as a lighter fallback', () => {
    expect(GITHUB_FREE_MODEL_ROTATION).toContain('gpt-4o-mini');
  });

  /** Malformed entries (empty strings, nulls) would cause silent API failures. */
  test('all entries are non-empty strings', () => {
    for (const modelId of GITHUB_FREE_MODEL_ROTATION) {
      expect(typeof modelId).toBe('string');
      expect(modelId.length).toBeGreaterThan(0);
    }
  });

  /** Duplicate entries waste quota attempts and could produce confusing rotation logs. */
  test('contains no duplicate model IDs', () => {
    const uniqueModelIds = new Set(GITHUB_FREE_MODEL_ROTATION);
    expect(uniqueModelIds.size).toBe(GITHUB_FREE_MODEL_ROTATION.length);
  });

  /** A meaningful rotation needs enough models to withstand bursts of quota exhaustion. */
  test('contains at least 10 model entries for meaningful rotation coverage', () => {
    expect(GITHUB_FREE_MODEL_ROTATION.length).toBeGreaterThanOrEqual(10);
  });
});

// ── AiClient Model Rotation ────────────────────────────────────────────────

test.describe('AiClient model rotation', () => {
  // All tests inject a mock providerAdapter directly via (client as any).providerAdapter,
  // bypassing initialize() to avoid any real network calls during unit testing.
  // This works because the check in chat() is `if (!this.providerAdapter)`, and the
  // injected adapter satisfies that guard.

  /** Baseline: the rotation machinery must not change anything when the first model succeeds. */
  test('uses the first model in the rotation list when that model succeeds', async () => {
    const config = createGitHubProviderConfig();
    const client = new AiClient(config);
    const calledModelNames: string[] = [];

    const trackingAdapter = {
      sendMessages: async (_messages: unknown, modelName: string, _maxTokens: unknown) => {
        calledModelNames.push(modelName);
        return { content: 'success', tokensUsed: 5, modelUsed: modelName };
      },
    };
    (client as any).providerAdapter = trackingAdapter;

    await client.chat(SAMPLE_CONVERSATION, 'baseline-test');

    expect(calledModelNames[0]).toBe(GITHUB_FREE_MODEL_ROTATION[0]);
    expect(client.modelName).toBe(GITHUB_FREE_MODEL_ROTATION[0]);
  });

  /** Core rotation: a quota error on the first model must cause a successful retry on the second. */
  test('rotates to the second model when the first model quota is exhausted', async () => {
    const config = createGitHubProviderConfig();
    const client = new AiClient(config);
    const firstRotationModel = GITHUB_FREE_MODEL_ROTATION[0];
    const secondRotationModel = GITHUB_FREE_MODEL_ROTATION[1];

    const rotationMockAdapter = {
      sendMessages: async (_messages: unknown, modelName: string, _maxTokens: unknown) => {
        if (modelName === firstRotationModel) {
          throw createQuotaExhaustedApiError();
        }
        return { content: 'rotated response', tokensUsed: 8, modelUsed: modelName };
      },
    };
    (client as any).providerAdapter = rotationMockAdapter;

    const response = await client.chat(SAMPLE_CONVERSATION, 'rotation-test');

    expect(response.content).toBe('rotated response');
    expect(response.modelUsed).toBe(secondRotationModel);
  });

  /** The modelName getter must reflect the active model after rotation so logs stay accurate. */
  test('modelName getter returns the newly active model after rotation', async () => {
    const config = createGitHubProviderConfig();
    const client = new AiClient(config);
    const firstRotationModel = GITHUB_FREE_MODEL_ROTATION[0];

    const rotationAdapter = {
      sendMessages: async (_messages: unknown, modelName: string, _maxTokens: unknown) => {
        if (modelName === firstRotationModel) {
          throw createQuotaExhaustedApiError();
        }
        return { content: 'ok', tokensUsed: 5, modelUsed: modelName };
      },
    };
    (client as any).providerAdapter = rotationAdapter;

    // Before any call the active model is the first in the list
    expect(client.modelName).toBe(firstRotationModel);

    await client.chat(SAMPLE_CONVERSATION, 'model-name-test');

    // After rotation, modelName must have advanced to the second model
    expect(client.modelName).not.toBe(firstRotationModel);
    expect(client.modelName).toBe(GITHUB_FREE_MODEL_ROTATION[1]);
  });

  /**
   * Non-quota errors (network failures, auth errors) must bubble up immediately.
   * Rotating models in response to a 401 or a DNS failure would be misleading.
   */
  test('non-quota errors propagate without triggering model rotation', async () => {
    const config = createGitHubProviderConfig();
    const client = new AiClient(config);

    const networkFailureAdapter = {
      // Plain Error with no retry-after header — should NOT trigger rotation
      sendMessages: async () => {
        throw new Error('Connection refused');
      },
    };
    (client as any).providerAdapter = networkFailureAdapter;

    await expect(
      client.chat(SAMPLE_CONVERSATION, 'non-quota-error-test'),
    ).rejects.toThrow('Connection refused');

    // modelName must remain the first model because no rotation occurred
    expect(client.modelName).toBe(GITHUB_FREE_MODEL_ROTATION[0]);
  });

  /**
   * When every model in the list is exhausted, the client must throw a descriptive error
   * rather than silently returning nothing or looping forever.
   * Uses openai (single-model rotation) to keep the test fast — one quota error is enough.
   */
  test('throws error containing "All" and "quota" when every model is exhausted', async () => {
    const config = createOpenAiProviderConfig();
    const client = new AiClient(config);
    (client as any).providerAdapter = createExhaustAllModelsMockAdapter();

    let thrownError: Error | undefined;
    try {
      await client.chat(SAMPLE_CONVERSATION, 'all-exhausted-test');
    } catch (caughtError) {
      thrownError = caughtError as Error;
    }

    expect(thrownError).toBeDefined();
    expect(thrownError!.message).toMatch(/all/i);
    expect(thrownError!.message).toMatch(/quota/i);
  });

  /**
   * Same "all exhausted" scenario but exercised through the multi-model github rotation path.
   * The rotation list is overridden to 2 fake models so the test does not iterate all 20+.
   */
  test('github provider throws All+quota error after exhausting a multi-model rotation list', async () => {
    const config = createGitHubProviderConfig();
    const client = new AiClient(config);

    // Override to a tiny rotation list so the test does not iterate all 20+ real models
    (client as any).modelRotationList = ['gpt-fake-alpha', 'gpt-fake-beta'];
    (client as any).providerAdapter = createExhaustAllModelsMockAdapter();

    let thrownError: Error | undefined;
    try {
      await client.chat(SAMPLE_CONVERSATION, 'github-all-exhausted-test');
    } catch (caughtError) {
      thrownError = caughtError as Error;
    }

    expect(thrownError).toBeDefined();
    expect(thrownError!.message).toMatch(/all/i);
    expect(thrownError!.message).toMatch(/quota/i);
  });

  /**
   * Non-github providers do not have a meaningful rotation pool — they have one model each.
   * The rotation list must have exactly one entry so the "all exhausted" path triggers on the
   * first quota error instead of silently trying nonexistent models.
   */
  test('openai provider rotation list contains exactly one model', () => {
    const config = createOpenAiProviderConfig();
    const client = new AiClient(config);
    const rotationList = (client as any).modelRotationList as string[];

    expect(Array.isArray(rotationList)).toBe(true);
    expect(rotationList).toHaveLength(1);
  });

  /** Same single-model constraint applies to the Anthropic provider. */
  test('anthropic provider rotation list contains exactly one model', () => {
    const config = createAnthropicProviderConfig();
    const client = new AiClient(config);
    const rotationList = (client as any).modelRotationList as string[];

    expect(Array.isArray(rotationList)).toBe(true);
    expect(rotationList).toHaveLength(1);
  });

  /**
   * The active model index must persist between calls so a rotated model is used for
   * all subsequent calls in the same session — not just the one that triggered the rotation.
   * Without this, every call would re-try the exhausted model and generate spurious log noise.
   */
  test('subsequent calls after rotation start from the rotated model, not the exhausted one', async () => {
    const config = createGitHubProviderConfig();
    const client = new AiClient(config);
    const firstRotationModel = GITHUB_FREE_MODEL_ROTATION[0];
    const calledModelNames: string[] = [];

    const persistenceCheckAdapter = {
      sendMessages: async (_messages: unknown, modelName: string, _maxTokens: unknown) => {
        calledModelNames.push(modelName);
        if (modelName === firstRotationModel) {
          throw createQuotaExhaustedApiError();
        }
        return { content: 'ok', tokensUsed: 5, modelUsed: modelName };
      },
    };
    (client as any).providerAdapter = persistenceCheckAdapter;

    // First call rotates away from the exhausted first model
    await client.chat(SAMPLE_CONVERSATION, 'first-call');
    const activeModelAfterRotation = client.modelName;

    // Clear the tracked calls so we only observe the second chat() call
    calledModelNames.length = 0;

    // Second call should begin directly at the rotated model — skipping the exhausted one
    await client.chat(SAMPLE_CONVERSATION, 'second-call');

    expect(calledModelNames).not.toContain(firstRotationModel);
    expect(calledModelNames[0]).toBe(activeModelAfterRotation);
  });

  /**
   * When a modelOverride is set for the github provider and the model is NOT in the
   * standard rotation list, it should be prepended so the user's preferred model is
   * tried first, then exhaustion falls through to the full free-tier rotation list.
   */
  test('github provider with unknown modelOverride prepends that model to the rotation list', () => {
    // 'o3-mini' is not in GITHUB_FREE_MODEL_ROTATION, so it gets prepended
    const customModelName = 'o3-mini-custom-not-in-rotation';
    const config = createGitHubProviderConfig({ modelOverride: customModelName });
    const client = new AiClient(config);
    const rotationList = (client as any).modelRotationList as string[];

    // The custom model must be at index 0 (tried first)
    expect(rotationList[0]).toBe(customModelName);
    // The standard rotation models should follow as fallbacks
    expect(rotationList.length).toBeGreaterThan(1);
    expect(rotationList).toContain(GITHUB_FREE_MODEL_ROTATION[0]);
  });

  /**
   * When a modelOverride matches a model that IS in GITHUB_FREE_MODEL_ROTATION, the
   * rotation list starts at that model's position so exhaustion falls through naturally.
   */
  test('github provider with known modelOverride slices the rotation list from that model onward', () => {
    // gpt-4o-mini is in GITHUB_FREE_MODEL_ROTATION — use it as an override
    const knownOverrideModel = 'gpt-4o-mini';
    const config = createGitHubProviderConfig({ modelOverride: knownOverrideModel });
    const client = new AiClient(config);
    const rotationList = (client as any).modelRotationList as string[];

    // Must start at the override model
    expect(rotationList[0]).toBe(knownOverrideModel);
    // Must not include models that appear BEFORE it in GITHUB_FREE_MODEL_ROTATION
    const overrideIndexInFullList = GITHUB_FREE_MODEL_ROTATION.indexOf(knownOverrideModel);
    const modelsBeforeOverride = GITHUB_FREE_MODEL_ROTATION.slice(0, overrideIndexInFullList);
    for (const precedingModel of modelsBeforeOverride) {
      expect(rotationList).not.toContain(precedingModel);
    }
  });
});
