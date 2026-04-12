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

/** Number of retry attempts for transient AI API failures. */
const DEFAULT_MAX_RETRY_ATTEMPTS = 3;

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
  };

  // Validate that we have an API key before any AI operation is attempted
  if (!mergedConfig.ai.apiKey) {
    // Don't throw here — let the caller decide if AI is required.
    // The aiClient will throw with a helpful message when an API call is made.
  }

  return mergedConfig;
}

/**
 * Returns the default AI model name for a given provider.
 * These are the best models for code analysis and test generation as of this writing.
 */
export function getDefaultModelForProvider(provider: AiProviderName): string {
  const modelMap: Record<AiProviderName, string> = {
    openai: 'gpt-4o',
    anthropic: 'claude-3-5-sonnet-20241022',
    // GitHub Models API (Copilot subscription) — gpt-4o gives the best behavioral test quality
    github: 'gpt-4o',
  };
  return modelMap[provider];
}
