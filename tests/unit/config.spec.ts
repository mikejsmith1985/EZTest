/**
 * Unit tests for the Configuration loader.
 * Verifies that config defaults, environment variable overrides, and
 * provider defaults all behave correctly.
 */
import { test, expect } from '@playwright/test';
import { loadConfig, getDefaultModelForProvider } from '../../src/shared/config.js';

test.describe('loadConfig', () => {
  test('returns defaults when no config file or environment variables are set', () => {
    // Clear any accidental env leakage from the test runner
    const savedOpenAiKey = process.env['OPENAI_API_KEY'];
    const savedAnthropicKey = process.env['ANTHROPIC_API_KEY'];
    delete process.env['OPENAI_API_KEY'];
    delete process.env['ANTHROPIC_API_KEY'];

    const config = loadConfig('/tmp/nonexistent-directory-eztest-test');

    expect(config.defaultSourceDirectory).toBe('./src');
    expect(config.defaultOutputDirectory).toBe('./tests/e2e');
    expect(config.defaultTargetUrl).toBe('http://localhost:3000');
    expect(config.annotationServerPort).toBe(7432);
    expect(config.isVerboseLogging).toBe(false);
    expect(config.ai.provider).toBe('openai');
    expect(config.ai.maxTokensPerCall).toBe(4096);
    expect(config.ai.maxRetryAttempts).toBe(3);

    // Restore env
    if (savedOpenAiKey) process.env['OPENAI_API_KEY'] = savedOpenAiKey;
    if (savedAnthropicKey) process.env['ANTHROPIC_API_KEY'] = savedAnthropicKey;
  });

  test('reads OpenAI API key from OPENAI_API_KEY environment variable', () => {
    process.env['OPENAI_API_KEY'] = 'sk-test-openai-key';
    delete process.env['ANTHROPIC_API_KEY'];

    const config = loadConfig('/tmp/nonexistent-directory-eztest-test');

    expect(config.ai.apiKey).toBe('sk-test-openai-key');
    expect(config.ai.provider).toBe('openai');

    delete process.env['OPENAI_API_KEY'];
  });

  test('reads Anthropic API key and sets provider to anthropic', () => {
    delete process.env['OPENAI_API_KEY'];
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-test-key';

    const config = loadConfig('/tmp/nonexistent-directory-eztest-test');

    expect(config.ai.apiKey).toBe('sk-ant-test-key');
    expect(config.ai.provider).toBe('anthropic');

    delete process.env['ANTHROPIC_API_KEY'];
  });

  test('EZTEST_AI_PROVIDER environment variable overrides provider detection', () => {
    process.env['OPENAI_API_KEY'] = 'sk-test-key';
    process.env['EZTEST_AI_PROVIDER'] = 'anthropic';

    const config = loadConfig('/tmp/nonexistent-directory-eztest-test');

    // Provider override should take effect even when OpenAI key is set
    expect(config.ai.provider).toBe('anthropic');

    delete process.env['OPENAI_API_KEY'];
    delete process.env['EZTEST_AI_PROVIDER'];
  });

  test('global exclude patterns include node_modules and dist', () => {
    const config = loadConfig('/tmp/nonexistent-directory-eztest-test');

    expect(config.globalExcludePatterns).toContain('**/node_modules/**');
    expect(config.globalExcludePatterns).toContain('**/dist/**');
    expect(config.globalExcludePatterns).toContain('**/*.test.*');
    expect(config.globalExcludePatterns).toContain('**/*.spec.*');
  });
});

test.describe('getDefaultModelForProvider', () => {
  test('returns gpt-4o for openai provider', () => {
    expect(getDefaultModelForProvider('openai')).toBe('gpt-4o');
  });

  test('returns claude-3-5-sonnet for anthropic provider', () => {
    const model = getDefaultModelForProvider('anthropic');
    expect(model).toContain('claude');
    expect(model).toContain('sonnet');
  });
});
