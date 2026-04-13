/**
 * Unit tests for the Configuration loader.
 * Verifies that config defaults, environment variable overrides, and
 * provider defaults all behave correctly.
 */
import { test, expect } from '@playwright/test';
import { loadConfig, getDefaultModelForProvider } from '../../src/shared/config.js';

// ── Env helpers ──────────────────────────────────────────────────────────────

/** All environment variable keys EZTest reads for AI configuration. */
const AI_ENV_KEYS = [
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'EZTEST_GITHUB_TOKEN',
  'GITHUB_MODELS_TOKEN',
  'EZTEST_AI_PROVIDER',
  'EZTEST_AI_MODEL',
] as const;

/**
 * Saves all AI env vars, deletes them, runs the test function, then restores them.
 * Ensures each test starts with a clean slate so tests do not leak state.
 */
async function withCleanEnv(testFn: () => void | Promise<void>): Promise<void> {
  const savedValues: Record<string, string | undefined> = {};
  for (const key of AI_ENV_KEYS) {
    savedValues[key] = process.env[key];
    delete process.env[key];
  }
  try {
    await testFn();
  } finally {
    for (const key of AI_ENV_KEYS) {
      const savedValue = savedValues[key];
      if (savedValue !== undefined) {
        process.env[key] = savedValue;
      } else {
        delete process.env[key];
      }
    }
  }
}

// ── loadConfig ───────────────────────────────────────────────────────────────

test.describe('loadConfig', () => {
  test('returns defaults when no config file or environment variables are set', async () => {
    await withCleanEnv(() => {
      const config = loadConfig('/tmp/nonexistent-directory-eztest-test');

      expect(config.defaultSourceDirectory).toBe('./src');
      expect(config.defaultOutputDirectory).toBe('./tests/e2e');
      expect(config.defaultTargetUrl).toBe('http://localhost:3000');
      expect(config.annotationServerPort).toBe(7432);
      expect(config.isVerboseLogging).toBe(false);
      expect(config.ai.provider).toBe('openai');
      expect(config.ai.maxTokensPerCall).toBe(4096);
      expect(config.ai.maxRetryAttempts).toBe(5);
    });
  });

  test('reads OpenAI API key from OPENAI_API_KEY environment variable', async () => {
    await withCleanEnv(() => {
      process.env['OPENAI_API_KEY'] = 'sk-test-openai-key';

      const config = loadConfig('/tmp/nonexistent-directory-eztest-test');

      expect(config.ai.apiKey).toBe('sk-test-openai-key');
      expect(config.ai.provider).toBe('openai');
    });
  });

  test('reads Anthropic API key and sets provider to anthropic', async () => {
    await withCleanEnv(() => {
      process.env['ANTHROPIC_API_KEY'] = 'sk-ant-test-key';

      const config = loadConfig('/tmp/nonexistent-directory-eztest-test');

      expect(config.ai.apiKey).toBe('sk-ant-test-key');
      expect(config.ai.provider).toBe('anthropic');
    });
  });

  test('GitHub token sets provider to github and takes precedence over OpenAI key', async () => {
    await withCleanEnv(() => {
      process.env['OPENAI_API_KEY'] = 'sk-openai-key';
      process.env['EZTEST_GITHUB_TOKEN'] = 'github_pat_testtoken';

      const config = loadConfig('/tmp/nonexistent-directory-eztest-test');

      expect(config.ai.provider).toBe('github');
      expect(config.ai.apiKey).toBe('github_pat_testtoken');
    });
  });

  test('EZTEST_AI_PROVIDER selects between providers when both keys are present', async () => {
    await withCleanEnv(() => {
      process.env['OPENAI_API_KEY'] = 'sk-openai-key';
      process.env['ANTHROPIC_API_KEY'] = 'sk-ant-key';
      process.env['EZTEST_AI_PROVIDER'] = 'openai';

      const config = loadConfig('/tmp/nonexistent-directory-eztest-test');

      // Explicit provider override is respected when the matching key exists
      expect(config.ai.provider).toBe('openai');
      expect(config.ai.apiKey).toBe('sk-openai-key');
    });
  });

  test('stale EZTEST_AI_PROVIDER=openai does NOT override GitHub token when no OpenAI key exists', async () => {
    // Regression: user had EZTEST_AI_PROVIDER=openai (stale, from a previous UI config session)
    // AND EZTEST_GITHUB_TOKEN (valid). The old logic overrode the provider to openai, which then
    // called the OpenAI API with no key -> auth error -> process.exit(1) while the SDK had open
    // sockets -> libuv assertion crash (exit code 3221226505).
    await withCleanEnv(() => {
      process.env['EZTEST_GITHUB_TOKEN'] = 'github_pat_testtoken';
      process.env['EZTEST_AI_PROVIDER'] = 'openai'; // stale — no OPENAI_API_KEY present

      const config = loadConfig('/tmp/nonexistent-directory-eztest-test');

      // EZTEST_AI_PROVIDER=openai must be ignored; GitHub token wins
      expect(config.ai.provider).toBe('github');
      expect(config.ai.apiKey).toBe('github_pat_testtoken');
    });
  });

  test('stale EZTEST_AI_PROVIDER=anthropic does NOT override OpenAI key when no Anthropic key exists', async () => {
    await withCleanEnv(() => {
      process.env['OPENAI_API_KEY'] = 'sk-openai-key';
      process.env['EZTEST_AI_PROVIDER'] = 'anthropic'; // stale — no ANTHROPIC_API_KEY present

      const config = loadConfig('/tmp/nonexistent-directory-eztest-test');

      // No Anthropic key — provider override ignored, falls back to openai
      expect(config.ai.provider).toBe('openai');
      expect(config.ai.apiKey).toBe('sk-openai-key');
    });
  });

  test('EZTEST_AI_PROVIDER=github works when GITHUB_MODELS_TOKEN fallback is used', async () => {
    await withCleanEnv(() => {
      process.env['GITHUB_MODELS_TOKEN'] = 'ghmodels_testtoken';
      process.env['EZTEST_AI_PROVIDER'] = 'github';

      const config = loadConfig('/tmp/nonexistent-directory-eztest-test');

      expect(config.ai.provider).toBe('github');
      expect(config.ai.apiKey).toBe('ghmodels_testtoken');
    });
  });

  test('global exclude patterns include node_modules, dist, test files, and spec files', async () => {
    await withCleanEnv(() => {
      const config = loadConfig('/tmp/nonexistent-directory-eztest-test');

      expect(config.globalExcludePatterns).toContain('**/node_modules/**');
      expect(config.globalExcludePatterns).toContain('**/dist/**');
      expect(config.globalExcludePatterns).toContain('**/*.test.*');
      expect(config.globalExcludePatterns).toContain('**/*.spec.*');
    });
  });
});

// ── getDefaultModelForProvider ────────────────────────────────────────────────

test.describe('getDefaultModelForProvider', () => {
  test('returns gpt-4o for openai provider', () => {
    expect(getDefaultModelForProvider('openai')).toBe('gpt-4o');
  });

  test('returns gpt-4.1 for github provider (first model in free-tier rotation)', () => {
    expect(getDefaultModelForProvider('github')).toBe('gpt-4.1');
  });

  test('returns claude-3-5-sonnet for anthropic provider', () => {
    const model = getDefaultModelForProvider('anthropic');
    expect(model).toContain('claude');
    expect(model).toContain('sonnet');
  });
});
