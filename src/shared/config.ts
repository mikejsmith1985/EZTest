/**
 * Configuration loader for EZTest.
 * Reads eztest.config.ts (or .js/.json) from the working directory and merges
 * with environment variables and CLI flag overrides. This is the single source
 * of truth for all runtime settings.
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createRequire } from 'node:module';
import type { AiProviderName } from './types.js';

// ── Config Shape ───────────────────────────────────────────────────────────

/** Complete EZTest configuration. All fields have sensible defaults. */
export interface EZTestConfig {
  ai: AiConfig;
  /** Default source directory when --source is not provided */
  defaultSourceDirectory: string;
  /** Default output directory for generated tests */
  defaultOutputDirectory: string;
  /** Default target app URL when --url is not provided */
  defaultTargetUrl: string;
  /** Port for the annotation server during recording sessions */
  annotationServerPort: number;
  /** File patterns to always exclude from code analysis */
  globalExcludePatterns: string[];
  /** Whether to write verbose logs to stdout */
  isVerboseLogging: boolean;
  /** Forge Terminal webhook URL for agent feedback loop integration */
  forgeTerminalWebhookUrl?: string;
  /** Forge Terminal MCP server URL (preferred over webhook when set) */
  forgeMcpUrl?: string;
  /** Bearer token for the Forge Terminal MCP server (from ~/.forge/mcp-token) */
  forgeMcpToken?: string;
}

/** AI provider configuration. */
export interface AiConfig {
  provider: AiProviderName;
  /** Model name override — EZTest chooses a sensible default per provider */
  modelOverride?: string;
  /** API key — always read from environment, never from config file (security) */
  apiKey: string;
  /** Maximum tokens to allow per AI call */
  maxTokensPerCall: number;
  /** Number of times to retry a failed AI call before giving up */
  maxRetryAttempts: number;
}

// ── Default Values ─────────────────────────────────────────────────────────

/** The annotation server port. Above 1024 avoids needing elevated privileges. */
const DEFAULT_ANNOTATION_SERVER_PORT = 7432;

/** How many tokens we allow per AI call — balances cost vs. completeness. */
const DEFAULT_MAX_TOKENS_PER_CALL = 4096;

/**
 * Number of retry attempts for transient AI API failures.
 * Set to 5 because the Copilot API intermittently returns 403 under load and
 * typically succeeds within 2-4 retries with exponential backoff.
 */
const DEFAULT_MAX_RETRY_ATTEMPTS = 5;

const DEFAULT_CONFIG: EZTestConfig = {
  ai: {
    provider: 'openai',
    apiKey: '',
    maxTokensPerCall: DEFAULT_MAX_TOKENS_PER_CALL,
    maxRetryAttempts: DEFAULT_MAX_RETRY_ATTEMPTS,
  },
  defaultSourceDirectory: './src',
  defaultOutputDirectory: './tests/e2e',
  defaultTargetUrl: 'http://localhost:3000',
  annotationServerPort: DEFAULT_ANNOTATION_SERVER_PORT,
  globalExcludePatterns: [
    '**/*.test.*',
    '**/*.spec.*',
    '**/*.stories.*',
    '**/*.story.*',
    '**/*.d.ts',
    '**/*.min.js',
    '**/node_modules/**',
    '**/dist/**',
    '**/build/**',
    '**/out/**',
    '**/.next/**',
    '**/.turbo/**',
    '**/coverage/**',
    '**/__tests__/**',
    '**/__mocks__/**',
    '**/__fixtures__/**',
    '**/fixtures/**',
    '**/mocks/**',
    '**/vendor/**',
    '**/storybook-static/**',
    '**/migrations/**',
  ],
  isVerboseLogging: false,
};

// ── Config File Discovery ──────────────────────────────────────────────────

/** Config file names EZTest checks for, in order of preference. */
const CONFIG_FILE_CANDIDATES = [
  'eztest.config.ts',
  'eztest.config.js',
  'eztest.config.json',
] as const;

/**
 * Searches for an EZTest config file starting from the given directory.
 * Returns the resolved path if found, or null if none exists.
 */
function findConfigFilePath(searchDirectory: string): string | null {
  for (const candidateFilename of CONFIG_FILE_CANDIDATES) {
    const candidatePath = join(searchDirectory, candidateFilename);
    if (existsSync(candidatePath)) {
      return resolve(candidatePath);
    }
  }
  return null;
}

/**
 * Loads user-defined config overrides from a JSON config file.
 * We only support JSON loading here to avoid needing ts-node for TS config files at runtime.
 */
function loadJsonConfigOverrides(configFilePath: string): Partial<EZTestConfig> {
  try {
    const rawContent = readFileSync(configFilePath, 'utf-8');
    return JSON.parse(rawContent) as Partial<EZTestConfig>;
  } catch (loadError) {
    console.warn(`[EZTest] Warning: Could not parse config file at ${configFilePath}:`, loadError);
    return {};
  }
}

/**
 * Loads user-defined config overrides from a CommonJS config file.
 * Supports both .js and (compiled) .ts files.
 */
function loadCommonJsConfigOverrides(configFilePath: string): Partial<EZTestConfig> {
  try {
    const requireFromDirectory = createRequire(configFilePath);
    const loadedModule = requireFromDirectory(configFilePath) as { default?: Partial<EZTestConfig> } | Partial<EZTestConfig>;
    // Support both `module.exports = {...}` and `export default {...}`
    if ('default' in loadedModule && loadedModule.default) {
      return loadedModule.default;
    }
    return loadedModule as Partial<EZTestConfig>;
  } catch (loadError) {
    console.warn(`[EZTest] Warning: Could not load config file at ${configFilePath}:`, loadError);
    return {};
  }
}

// ── Environment Variable Reading ───────────────────────────────────────────

/**
 * Maps each AI provider name to the environment variable that holds its API key.
 * Used for both key lookup and provider validation.
 */
const PROVIDER_KEY_ENV_VARS: Record<AiProviderName, string> = {
  openai:    'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  github:    'EZTEST_GITHUB_TOKEN',
  // Copilot provider uses the same GitHub token — the difference is the endpoint
  // (api.githubcopilot.com instead of models.inference.ai.azure.com) and auth flow.
  copilot:   'EZTEST_GITHUB_TOKEN',
};

/**
 * Returns the API key value for a given provider, or null if not set.
 * Also checks GITHUB_MODELS_TOKEN as a fallback for the github provider.
 */
function resolveApiKeyForProvider(provider: AiProviderName): string | null {
  if (provider === 'github') {
    return process.env['EZTEST_GITHUB_TOKEN'] ?? process.env['GITHUB_MODELS_TOKEN'] ?? null;
  }
  const envVarName = PROVIDER_KEY_ENV_VARS[provider];
  return process.env[envVarName] ?? null;
}

/**
 * Reads AI configuration from environment variables.
 *
 * Priority order (later wins):
 *   1. OPENAI_API_KEY present → provider=openai
 *   2. ANTHROPIC_API_KEY present → provider=anthropic
 *   3. EZTEST_GITHUB_TOKEN / GITHUB_MODELS_TOKEN present → provider=github
 *   4. EZTEST_AI_PROVIDER explicit → ONLY applied when the matching API key is also set.
 *      This prevents a stale EZTEST_AI_PROVIDER=openai from overriding a live GitHub token
 *      when the user has no OpenAI key configured.
 */
function readAiConfigFromEnvironment(): Partial<AiConfig> {
  const environmentOverrides: Partial<AiConfig> = {};

  // Step 1–3: Provider inferred from which keys are present
  if (process.env['OPENAI_API_KEY']) {
    environmentOverrides.apiKey = process.env['OPENAI_API_KEY'];
    environmentOverrides.provider = 'openai';
  }
  if (process.env['ANTHROPIC_API_KEY']) {
    environmentOverrides.apiKey = process.env['ANTHROPIC_API_KEY'];
    environmentOverrides.provider = 'anthropic';
  }
  if (process.env['EZTEST_GITHUB_TOKEN'] ?? process.env['GITHUB_MODELS_TOKEN']) {
    // GitHub Copilot (via GitHub Models API) takes highest precedence among key-based detection —
    // most users will have this via their Copilot subscription without needing a paid API key
    environmentOverrides.apiKey = (process.env['EZTEST_GITHUB_TOKEN'] ?? process.env['GITHUB_MODELS_TOKEN'])!;
    environmentOverrides.provider = 'github';
  }

  // Step 4: Explicit provider override — only honoured when the matching key is available.
  // A stale EZTEST_AI_PROVIDER=openai (e.g. written by a previous UI config session) must NOT
  // override a valid GitHub token. If the user truly wants to switch providers they must also
  // have the matching API key present.
  if (process.env['EZTEST_AI_PROVIDER']) {
    const requestedProvider = process.env['EZTEST_AI_PROVIDER'] as AiProviderName;
    const matchingApiKey = resolveApiKeyForProvider(requestedProvider);
    if (matchingApiKey) {
      environmentOverrides.apiKey = matchingApiKey;
      environmentOverrides.provider = requestedProvider;
    }
    // copilot provider authenticates via `gh auth token` — no env var key needed.
    // Set a sentinel apiKey so the AiClient initialize() guard doesn't reject it.
    // Also raise maxTokensPerCall to the Copilot API's 16 384-token output cap so
    // the provider-aware batch budget (flowBatchOutputBudget) can use the full limit.
    if (requestedProvider === 'copilot') {
      environmentOverrides.apiKey          = 'copilot-via-gh-cli';
      environmentOverrides.provider        = 'copilot';
      environmentOverrides.maxTokensPerCall = 16_384;
    }
    // If no matching key exists, silently ignore EZTEST_AI_PROVIDER and keep
    // whatever provider/key was detected from the keys that ARE present.
  }

  if (process.env['EZTEST_AI_MODEL']) {
    environmentOverrides.modelOverride = process.env['EZTEST_AI_MODEL'];
  }

  return environmentOverrides;
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Loads the fully-merged EZTest configuration for the given working directory.
 * Merge order (later wins): defaults → config file → environment variables.
 */
export function loadConfig(workingDirectory: string = process.cwd()): EZTestConfig {
  const configFilePath = findConfigFilePath(workingDirectory);
  let fileOverrides: Partial<EZTestConfig> = {};

  if (configFilePath) {
    if (configFilePath.endsWith('.json')) {
      fileOverrides = loadJsonConfigOverrides(configFilePath);
    } else {
      fileOverrides = loadCommonJsConfigOverrides(configFilePath);
    }
  }

  const environmentAiOverrides = readAiConfigFromEnvironment();

  const mergedConfig: EZTestConfig = {
    ...DEFAULT_CONFIG,
    ...fileOverrides,
    ai: {
      ...DEFAULT_CONFIG.ai,
      ...(fileOverrides.ai ?? {}),
      // Environment variables always win over config file for AI settings
      ...environmentAiOverrides,
    },
    // MCP config: environment variables override config file values.
    forgeMcpUrl: process.env['EZTEST_FORGE_MCP_URL'] ?? fileOverrides.forgeMcpUrl,
    forgeMcpToken: process.env['EZTEST_FORGE_MCP_TOKEN'] ?? fileOverrides.forgeMcpToken,
    forgeTerminalWebhookUrl:
      process.env['EZTEST_FORGE_WEBHOOK_URL'] ?? fileOverrides.forgeTerminalWebhookUrl,
  };

  // Validate that we have an API key before any AI operation is attempted
  if (!mergedConfig.ai.apiKey) {
    // Don't throw here — let the caller decide if AI is required.
    // The aiClient will throw with a helpful message when an API call is made.
  }

  return mergedConfig;
}

// ── GitHub Models Free-Tier Rotation ──────────────────────────────────────

/**
 * Ordered list of GitHub Models free-tier model IDs used for automatic rotation.
 * When a model exhausts its daily quota, EZTest automatically tries the next model
 * in this list so test generation can continue uninterrupted.
 *
 * Ordering rationale (quality first, then by tier):
 *   - HIGH tier (50 req/day): OpenAI > Meta Llama > DeepSeek > AI21 > Cohere
 *   - LOW  tier (150 req/day): OpenAI mini/nano > Mistral > Phi
 *   - CUSTOM tier (12 req/day, Copilot Pro only): gpt-5-mini as final OpenAI fallback
 *
 * Excluded: premium `custom` tier models (gpt-5, o1, o3, DeepSeek-R1, Grok-3),
 * embedding-only models, and vision-specialist models unlikely to produce valid JSON.
 *
 * Tip: `low` tier models have 3× the daily quota of `high` tier models, so
 * gpt-4.1-mini and gpt-4o-mini often have quota available when gpt-4.1 and gpt-4o do not.
 */
export const GITHUB_FREE_MODEL_ROTATION: readonly string[] = [
  // ── HIGH tier — OpenAI (50 req/day, best JSON schema adherence) ──────────
  'gpt-4.1',        // newest GPT-4 flagship — best coding + instruction following
  'gpt-4o',         // proven EZTest default — strong behavioral test generation
  // ── LOW tier — OpenAI (150 req/day, generous quota) ─────────────────────
  'gpt-4.1-mini',   // excellent quality-to-quota ratio
  'gpt-4o-mini',    // solid fallback with high request volume
  // ── HIGH tier — Meta Llama (50 req/day, strong instruction following) ────
  'Llama-3.3-70B-Instruct',              // Meta's best instruction model
  'Llama-4-Scout-17B-16E-Instruct',      // 10M token context window
  'Llama-4-Maverick-17B-128E-Instruct-FP8', // strong multimodal reasoning
  'Meta-Llama-3.1-405B-Instruct',        // very large parameter count, highly capable
  // ── HIGH tier — DeepSeek (50 req/day, excellent code generation) ─────────
  'DeepSeek-V3-0324',
  // ── HIGH tier — AI21 Labs (50 req/day, 256K context window) ─────────────
  'AI21-Jamba-1.5-Large',
  // ── HIGH tier — Cohere (50 req/day, optimised for tool use and RAG) ─────
  'Cohere-command-r-plus-08-2024',
  // ── LOW tier — Mistral (150 req/day, code-focused models) ────────────────
  'mistral-medium-2505',   // Mistral Medium 3 — good general purpose
  'Codestral-2501',        // code-specialized model designed for programming tasks
  'mistral-small-2503',    // Mistral Small 3.1 — lightweight and fast
  // ── LOW tier — Cohere (150 req/day) ──────────────────────────────────────
  'cohere-command-a',
  // ── LOW tier — Microsoft Phi (150 req/day, note: Phi-4 has 16K context) ─
  'Phi-4',                 // strong reasoning; context window is 16K (usually adequate)
  'Phi-4-mini-instruct',   // very lightweight fallback
  // ── LOW tier — last resort (150 req/day) ─────────────────────────────────
  'gpt-4.1-nano',
  // ── CUSTOM tier — Copilot Pro only (12 req/day) ──────────────────────────
  // Placed last because the 12 req/day quota is very small; only used when
  // all other models are already exhausted for the day.
  'gpt-5-mini',
] as const;

/**
 * Returns the default AI model name for a given provider.
 * These are the best models for code analysis and test generation as of this writing.
 * For GitHub Models, the default is the first model in the free-tier rotation list.
 */
export function getDefaultModelForProvider(provider: AiProviderName): string {
  const modelMap: Record<AiProviderName, string> = {
    openai:    'gpt-4o',
    anthropic: 'claude-3-5-sonnet-20241022',
    // GitHub Models API — start with gpt-4.1, then rotate through GITHUB_FREE_MODEL_ROTATION
    github:    GITHUB_FREE_MODEL_ROTATION[0],
    // Copilot API — gpt-4.1 is 0x premium requests and has proven JSON reliability
    copilot:   COPILOT_FREE_MODEL_ROTATION[0],
  };
  return modelMap[provider];
}

// ── GitHub Copilot API Free-Tier Rotation ──────────────────────────────────

/**
 * Ordered list of Copilot API model IDs for the model rotation.
 * gpt-4.1 and gpt-5-mini are 0x premium (free) for Copilot Pro/Pro+ subscribers.
 * Additional models consume premium requests but serve as robust fallbacks.
 *
 * Ordering rationale:
 *   - gpt-4.1 first: proven JSON reliability, best code analysis, 0x premium
 *   - gpt-5-mini second: newer architecture, 0x premium
 *   - gpt-5.4-mini third: strong quality at 0.33x premium cost
 *   - claude-sonnet-4.6 fourth: excellent code generation at 1x premium
 */
export const COPILOT_FREE_MODEL_ROTATION: readonly string[] = [
  'gpt-4.1',           // 0x — flagship code model, proven JSON + instruction following
  'gpt-5-mini',        // 0x — newer architecture, good fallback
  'gpt-5.4-mini',      // 0.33x — strong quality, low premium cost
  'claude-sonnet-4.6', // 1x — excellent code generation fallback
] as const;
