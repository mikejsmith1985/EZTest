/**
 * GitHub Copilot session token manager for EZTest.
 * Obtains short-lived Copilot API tokens via the `gh` CLI and caches them
 * so we only make a real HTTP call once every ~30 minutes per session.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// ── Constants ──────────────────────────────────────────────────────────────

/**
 * How many milliseconds before the session token expires to proactively refresh it.
 * 5 minutes gives plenty of time to finish in-flight AI calls before the token dies.
 */
export const TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1_000;

// ── Token Cache ────────────────────────────────────────────────────────────

/** Internally cached session token — null until the first successful fetch. */
interface CopilotSessionToken {
  /** The bearer token to send in Authorization headers. */
  token: string;
  /** Unix epoch milliseconds when this token expires. */
  expiresAtMs: number;
}

/** Module-level singleton cache — survives across multiple `chat()` calls in one process. */
let cachedToken: CopilotSessionToken | null = null;

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Returns a valid GitHub Copilot session token, fetching a new one from
 * the `gh` CLI if the cache is empty or the token is within 5 minutes of expiry.
 *
 * The token is obtained by calling:
 *   `gh api /copilot_internal/v2/token`
 *
 * Requirements:
 *   - `gh` CLI installed:     https://cli.github.com
 *   - Authenticated:          `gh auth login` (run once)
 *   - Copilot Pro/Pro+ active on the authenticated GitHub account
 *
 * @param tokenFetcher Optional override for the token-fetch function.
 *   Injected in unit tests to avoid real `gh` CLI calls.
 *   Defaults to `fetchTokenFromGhCli` in production.
 * @throws Error with actionable setup instructions if the CLI call fails.
 */
export async function getCopilotSessionToken(
  tokenFetcher: () => Promise<string> = fetchTokenFromGhCli,
): Promise<string> {
  const nowMs = Date.now();

  // Serve from cache when the token has more than 5 minutes remaining
  const isCacheValid =
    cachedToken !== null &&
    cachedToken.expiresAtMs - TOKEN_REFRESH_BUFFER_MS > nowMs;

  if (isCacheValid) {
    return cachedToken!.token;
  }

  const rawJsonResponse = await tokenFetcher();
  const parsedResponse  = parseTokenResponse(rawJsonResponse);

  cachedToken = {
    token:       parsedResponse.token,
    expiresAtMs: new Date(parsedResponse.expires_at).getTime(),
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
 * Calls `gh api /copilot_internal/v2/token` and returns the raw JSON string.
 * The `gh` CLI uses the stored OAuth credentials from `gh auth login`,
 * so no API key needs to be configured separately.
 *
 * @throws Error with setup instructions if the CLI is missing, not authenticated,
 *   or the account does not have an active Copilot subscription.
 */
export async function fetchTokenFromGhCli(): Promise<string> {
  try {
    const { stdout } = await execFileAsync('gh', ['api', '/copilot_internal/v2/token']);
    return stdout.trim();
  } catch (execError) {
    const causeMessage = execError instanceof Error ? execError.message : String(execError);
    throw new Error(
      'Failed to obtain a GitHub Copilot session token via the gh CLI.\n' +
      'Please ensure:\n' +
      '  1. The gh CLI is installed  →  https://cli.github.com\n' +
      '  2. You are authenticated    →  gh auth login\n' +
      '  3. Your GitHub account has an active Copilot Pro or Pro+ subscription\n\n' +
      'Original error: ' + causeMessage,
    );
  }
}

/** Shape of the JSON object returned by the Copilot internal token endpoint. */
export interface CopilotTokenResponse {
  /** Short-lived bearer token for api.githubcopilot.com requests. */
  token: string;
  /** ISO-8601 timestamp when this token expires (typically ~30 minutes from now). */
  expires_at: string;
}

/**
 * Parses the raw JSON from the Copilot token endpoint and validates the required fields.
 * @throws Error with the raw response excerpt if parsing fails or fields are missing.
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
