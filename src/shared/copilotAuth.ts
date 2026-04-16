/**
 * GitHub Copilot authentication for EZTest.
 * Obtains the user's Copilot-scoped OAuth token via the `gh` CLI.
 * The OAuth token (gho_...) works directly as a bearer token against
 * api.githubcopilot.com — no intermediate session token endpoint needed.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// ── Constants ──────────────────────────────────────────────────────────────

/**
 * How long (in milliseconds) to cache the OAuth token before re-fetching
 * from the gh CLI keyring. The OAuth token itself is long-lived, but we
 * re-validate periodically to pick up re-authentication or scope changes.
 */
export const TOKEN_CACHE_TTL_MS = 30 * 60 * 1_000;

// ── Token Cache ────────────────────────────────────────────────────────────

/** Cached OAuth token with a fetch timestamp for TTL-based expiry. */
interface CachedOAuthToken {
  /** The OAuth bearer token (gho_...) to send in Authorization headers. */
  token: string;
  /** Unix epoch milliseconds when this cache entry was created. */
  fetchedAtMs: number;
}

/** Module-level singleton cache — survives across multiple `chat()` calls in one process. */
let cachedToken: CachedOAuthToken | null = null;

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Returns a valid GitHub OAuth token with the `copilot` scope, suitable
 * for bearer authentication against api.githubcopilot.com.
 *
 * The token is obtained by calling `gh auth token` which reads from the
 * gh CLI's keyring-stored credentials. Cached for 30 minutes to avoid
 * spawning a subprocess on every API call.
 *
 * Requirements:
 *   - `gh` CLI installed:     https://cli.github.com
 *   - Authenticated:          `gh auth login` (run once)
 *   - Copilot scope added:    `gh auth refresh -s copilot`
 *   - Copilot Pro/Pro+ active on the authenticated GitHub account
 *
 * @param tokenFetcher Optional override for the token-fetch function.
 *   Injected in unit tests to avoid real `gh` CLI calls.
 *   Defaults to `fetchOAuthTokenFromGhCli` in production.
 * @throws Error with actionable setup instructions if the CLI call fails.
 */
export async function getCopilotSessionToken(
  tokenFetcher: () => Promise<string> = fetchOAuthTokenFromGhCli,
): Promise<string> {
  const nowMs = Date.now();

  // Serve from cache when it hasn't expired yet
  const isCacheValid =
    cachedToken !== null &&
    (nowMs - cachedToken.fetchedAtMs) < TOKEN_CACHE_TTL_MS;

  if (isCacheValid) {
    return cachedToken!.token;
  }

  const oauthToken = await tokenFetcher();

  cachedToken = {
    token:       oauthToken,
    fetchedAtMs: nowMs,
  };

  return cachedToken.token;
}

/**
 * Clears the in-memory token cache.
 * Useful in tests and when the user explicitly re-authenticates.
 */
export function clearCopilotTokenCache(): void {
  cachedToken = null;
}

// ── Internal Helpers ───────────────────────────────────────────────────────

/**
 * Calls `gh auth token` to read the OAuth token from the gh CLI's keyring.
 * The token must have the `copilot` scope to authenticate against
 * api.githubcopilot.com. Users add this scope with `gh auth refresh -s copilot`.
 *
 * @throws Error with setup instructions if the CLI is missing, not authenticated,
 *   or the account doesn't have the copilot scope.
 */
export async function fetchOAuthTokenFromGhCli(): Promise<string> {
  try {
    // Strip GH_TOKEN / GITHUB_TOKEN from the child process environment so
    // that `gh auth token` reads the keyring-stored OAuth token instead of
    // blindly returning a stale or scope-less env-var token.
    const sanitizedEnv = { ...process.env };
    delete sanitizedEnv['GH_TOKEN'];
    delete sanitizedEnv['GITHUB_TOKEN'];

    const { stdout } = await execFileAsync('gh', ['auth', 'token'], {
      env: sanitizedEnv,
    });
    const token = stdout.trim();
    if (!token) {
      throw new Error('gh auth token returned an empty string');
    }
    return token;
  } catch (execError) {
    const causeMessage = execError instanceof Error ? execError.message : String(execError);
    throw new Error(
      'Failed to obtain a GitHub OAuth token via the gh CLI.\n' +
      'Please ensure:\n' +
      '  1. The gh CLI is installed     →  https://cli.github.com\n' +
      '  2. You are authenticated       →  gh auth login\n' +
      '  3. Copilot scope is added      →  gh auth refresh -s copilot\n' +
      '  4. Your GitHub account has an active Copilot Pro or Pro+ subscription\n\n' +
      'Original error: ' + causeMessage,
    );
  }
}

/** @deprecated Kept for backward compatibility with existing unit tests. */
export const fetchTokenFromGhCli = fetchOAuthTokenFromGhCli;

/**
 * Shape of the JSON object returned by the legacy Copilot internal token endpoint.
 * @deprecated Kept for backward compatibility with existing unit tests.
 */
export interface CopilotTokenResponse {
  /** Short-lived bearer token for api.githubcopilot.com requests. */
  token: string;
  /** ISO-8601 timestamp when this token expires. */
  expires_at: string;
}

/**
 * Parses the raw JSON from the legacy Copilot token endpoint.
 * @deprecated Kept for backward compatibility with existing unit tests.
 */
export function parseTokenResponse(rawJson: string): CopilotTokenResponse {
  let parsed: Partial<CopilotTokenResponse>;
  try {
    parsed = JSON.parse(rawJson) as Partial<CopilotTokenResponse>;
  } catch (jsonError) {
    throw new Error(
      'Failed to parse Copilot token response as JSON.\n' +
      'Raw response (first 200 chars): ' + rawJson.slice(0, 200) + '\n' +
      'Parse error: ' + (jsonError instanceof Error ? jsonError.message : String(jsonError)),
    );
  }

  if (!parsed.token) {
    throw new Error(
      'Copilot token response is missing the "token" field.\n' +
      'Raw response (first 200 chars): ' + rawJson.slice(0, 200),
    );
  }
  if (!parsed.expires_at) {
    throw new Error(
      'Copilot token response is missing the "expires_at" field.\n' +
      'Raw response (first 200 chars): ' + rawJson.slice(0, 200),
    );
  }

  return { token: parsed.token, expires_at: parsed.expires_at };
}
