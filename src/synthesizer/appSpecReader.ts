/**
 * App Spec Reader — reads a plain-English description of what the application is designed
 * to do and injects it into every AI prompt as business context.
 *
 * This is the single biggest quality lever for behavioral test generation. The AI cannot
 * know what an app is *supposed* to do from source code alone — it can only see mechanics.
 * A spec file answers "what should the user experience?" not just "what does the code do?"
 *
 * Priority order for spec file discovery:
 *   1. eztest-spec.md — EZTest-specific spec, most focused and highest quality
 *   2. README.md      — Widely present, usually describes the app's purpose
 *   3. AGENTS.md      — Sometimes contains feature specs in AI-first projects
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { logDebug, logInfo, logWarning } from '../shared/logger.js';

// ── Constants ──────────────────────────────────────────────────────────────

/**
 * Maximum characters to read from the spec file.
 * Keeps token usage bounded while preserving meaningful content.
 * Most README files are under this limit; larger ones get their most important
 * sections first since they typically lead with purpose and feature descriptions.
 */
const MAX_SPEC_CHARS = 5000;

/**
 * File names searched in order when auto-detecting the app spec.
 * The first file found wins.
 */
const SPEC_FILE_CANDIDATES = [
  'eztest-spec.md',
  'README.md',
  'readme.md',
  'AGENTS.md',
] as const;

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * The result of reading an app spec file.
 */
export interface AppSpecResult {
  /** The content of the spec file, trimmed to MAX_SPEC_CHARS. */
  specContent: string;
  /** The path of the file that was read. */
  sourceFilePath: string;
  /** Whether the content was truncated to fit within the token limit. */
  wasTruncated: boolean;
}

/**
 * Attempts to read an app spec from a given file path.
 * Returns null if the file does not exist or cannot be read.
 */
export function readAppSpecFromFile(filePath: string): AppSpecResult | null {
  const resolvedPath = resolve(filePath);

  if (!existsSync(resolvedPath)) {
    logWarning(`App spec file not found: ${resolvedPath}`);
    return null;
  }

  let rawContent: string;
  try {
    rawContent = readFileSync(resolvedPath, 'utf-8');
  } catch (readError) {
    logWarning(`Could not read app spec file ${resolvedPath}: ${String(readError)}`);
    return null;
  }

  const isTruncated = rawContent.length > MAX_SPEC_CHARS;
  const specContent = rawContent.slice(0, MAX_SPEC_CHARS).trim();

  logInfo(`Using app spec from: ${resolvedPath}${isTruncated ? ` (truncated from ${rawContent.length} chars)` : ''}`);

  return {
    specContent,
    sourceFilePath: resolvedPath,
    wasTruncated: isTruncated,
  };
}

/**
 * Auto-detects an app spec file by searching common locations relative to the
 * given base directory (typically the source code directory or project root).
 *
 * Searches in order: eztest-spec.md → README.md → readme.md → AGENTS.md
 *
 * Returns the spec content string if found, or null if no spec is available.
 * Returning just the string (not the full result) makes it easy to pass directly
 * to prompt template functions.
 */
export function detectAndReadAppSpec(baseDirectory: string): string | null {
  const resolvedBase = resolve(baseDirectory);

  // Also search the parent directory — the source dir is often src/, but
  // README.md lives at the project root (one level up)
  const searchDirectories = [
    resolvedBase,
    join(resolvedBase, '..'),
  ];

  for (const searchDirectory of searchDirectories) {
    for (const candidateFileName of SPEC_FILE_CANDIDATES) {
      const candidatePath = join(searchDirectory, candidateFileName);

      if (!existsSync(candidatePath)) continue;

      let rawContent: string;
      try {
        rawContent = readFileSync(candidatePath, 'utf-8');
      } catch {
        continue;
      }

      if (rawContent.trim().length < 50) {
        // Skip near-empty files — they add noise without useful signal
        logDebug(`Skipping ${candidatePath}: too short to be useful (${rawContent.trim().length} chars)`);
        continue;
      }

      const specContent = rawContent.slice(0, MAX_SPEC_CHARS).trim();
      const wasTruncated = rawContent.length > MAX_SPEC_CHARS;

      logInfo(
        `Auto-detected app spec: ${candidatePath}` +
        (wasTruncated ? ` (using first ${MAX_SPEC_CHARS} of ${rawContent.length} chars)` : ''),
      );

      return specContent;
    }
  }

  logDebug(
    `No app spec found in ${resolvedBase} or parent. ` +
    `Create an eztest-spec.md to dramatically improve test quality.`,
  );

  return null;
}
