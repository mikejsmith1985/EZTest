/**
 * Unit tests for the Copilot authentication module (copilotAuth.ts).
 * Uses dependency injection (tokenFetcher parameter) instead of module mocking
 * so these tests run cleanly under Playwright's test runner without the gh CLI.
 */
import { test, expect } from '@playwright/test';
import {
  getCopilotSessionToken,
  clearCopilotTokenCache,
  parseTokenResponse,
  TOKEN_CACHE_TTL_MS,
  type CopilotTokenResponse,
} from '../../src/shared/copilotAuth.js';

// ── Helpers ────────────────────────────────────────────────────────────────

/** Creates a fake token fetcher that returns a predetermined token string. */
function createFakeFetcher(tokenValue: string): () => Promise<string> {
  return () => Promise.resolve(tokenValue);
}

/** Creates a fake token fetcher that tracks how many times it was called. */
function createCountingFetcher(tokenValue: string): { fetch: () => Promise<string>; callCount: number } {
  const counter = { callCount: 0, fetch: () => Promise.resolve('') };
  counter.fetch = async () => {
    counter.callCount += 1;
    return tokenValue;
  };
  return counter;
}

/** Creates a fake token fetcher that always rejects with the given error message. */
function createFailingFetcher(errorMessage: string): () => Promise<string> {
  return () => Promise.reject(new Error(errorMessage));
}

// ── parseTokenResponse (legacy, kept for backward compatibility) ───────────

test.describe('parseTokenResponse', () => {
  test('returns a parsed response when both required fields are present', () => {
    const expiresAt = new Date(Date.now() + 30 * 60 * 1_000).toISOString();
    const rawJson = JSON.stringify({ token: 'abc123', expires_at: expiresAt });

    const result = parseTokenResponse(rawJson);

    expect(result.token).toBe('abc123');
    expect(result.expires_at).toBe(expiresAt);
  });

  test('throws a descriptive error when the token field is missing', () => {
    const rawJson = JSON.stringify({ expires_at: new Date().toISOString() });

    expect(() => parseTokenResponse(rawJson)).toThrow(/missing the "token" field/);
  });

  test('throws a descriptive error when the expires_at field is missing', () => {
    const rawJson = JSON.stringify({ token: 'abc123' });

    expect(() => parseTokenResponse(rawJson)).toThrow(/missing the "expires_at" field/);
  });

  test('throws a descriptive error when the input is not valid JSON', () => {
    const invalidJson = 'this is not json';

    expect(() => parseTokenResponse(invalidJson)).toThrow(/Failed to parse Copilot token response as JSON/);
  });

  test('includes a raw response excerpt in the error message for easier debugging', () => {
    const rawJson = '{"wrong_field": "value"}';
    let thrownError: Error | undefined;

    try {
      parseTokenResponse(rawJson);
    } catch (caughtError) {
      thrownError = caughtError as Error;
    }

    expect(thrownError?.message).toContain('wrong_field');
  });
});

// ── getCopilotSessionToken ─────────────────────────────────────────────────

test.describe('getCopilotSessionToken', () => {
  test.beforeEach(() => {
    // Clear the module-level cache before every test so tests are isolated
    clearCopilotTokenCache();
  });

  test('fetches a new token via the injected fetcher when the cache is empty', async () => {
    const fetcher = createCountingFetcher('gho_test-oauth-token');

    const returnedToken = await getCopilotSessionToken(fetcher.fetch);

    expect(fetcher.callCount).toBe(1);
    expect(returnedToken).toBe('gho_test-oauth-token');
  });

  test('returns the cached token on the second call without invoking the fetcher again', async () => {
    const fetcher = createCountingFetcher('gho_cached-token');

    const firstToken  = await getCopilotSessionToken(fetcher.fetch);
    const secondToken = await getCopilotSessionToken(fetcher.fetch);

    expect(fetcher.callCount).toBe(1); // fetcher called only once — second call served from cache
    expect(firstToken).toBe(secondToken);
  });

  test('TOKEN_CACHE_TTL_MS is 30 minutes', () => {
    expect(TOKEN_CACHE_TTL_MS).toBe(30 * 60 * 1_000);
  });

  test('propagates fetcher errors to the caller', async () => {
    const failingFetcher = createFailingFetcher('gh: command not found');

    await expect(getCopilotSessionToken(failingFetcher)).rejects.toThrow('gh: command not found');
  });
});

// ── clearCopilotTokenCache ─────────────────────────────────────────────────

test.describe('clearCopilotTokenCache', () => {
  test.beforeEach(() => {
    clearCopilotTokenCache();
  });

  test('forces the next getCopilotSessionToken call to fetch from the fetcher', async () => {
    const fetcher = createCountingFetcher('gho_clearable-token');

    // Populate the cache
    await getCopilotSessionToken(fetcher.fetch);
    expect(fetcher.callCount).toBe(1);

    // Clear it — next call must go back to the fetcher
    clearCopilotTokenCache();
    await getCopilotSessionToken(fetcher.fetch);

    expect(fetcher.callCount).toBe(2);
  });
});

