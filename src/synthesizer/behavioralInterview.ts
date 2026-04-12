/**
 * Behavioral Interview Module — generates targeted questions about expected user-visible
 * outcomes and merges the confirmed answers back into eztest-spec.md.
 *
 * This is the mechanism that closes the gap from 90% to 95% confidence by capturing
 * human intent for edge cases that no static analysis can infer. The AI reads source
 * code, identifies ambiguous outcomes, and asks the developer directly what users
 * should experience in specific scenarios.
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve, join, relative } from 'node:path';
import { glob } from 'glob';
import { logDebug, logInfo, logWarning } from '../shared/logger.js';
import type { AiMessage, AiResponse } from '../shared/types.js';
import {
  buildInterviewQuestionsPrompt,
  buildInterviewAnswerPrompt,
} from './promptTemplates.js';

// ── Public Interfaces ──────────────────────────────────────────────────────

/**
 * A single AI-generated question targeted at a specific behavioral ambiguity
 * in the application that cannot be resolved by static analysis alone.
 */
export interface InterviewQuestion {
  id: string;
  feature: string;
  question: string;
  context: string;
  answerType: 'text' | 'url' | 'message' | 'navigation' | 'visibility';
}

/**
 * A developer's confirmed answer to one interview question.
 * These answers are treated as ground truth and merged into the spec.
 */
export interface InterviewAnswer {
  question: string;
  answer: string;
  feature: string;
}

/**
 * Minimal interface that any AI client must satisfy to be used by this module.
 * Structurally compatible with the AiClient class in shared/aiClient.ts.
 */
export interface AiClientInterface {
  chat(messages: AiMessage[], operationDescription: string): Promise<AiResponse>;
}

/** Options for generating behavioral interview questions. */
export interface BehavioralInterviewOptions {
  /** The source code directory to scan for application context. */
  sourceDirectory: string;
  /** The project root where package.json and eztest-spec.md live. */
  projectRootDirectory: string;
  /** Initialized AI client to use for question generation. */
  aiClient: AiClientInterface;
  /** Maximum number of source files to read. Default: 12. */
  maxSourceFiles?: number;
  /** Maximum characters to read per source file. Default: 3000. */
  maxCharsPerFile?: number;
}

// ── Constants ──────────────────────────────────────────────────────────────

/** Hard cap on source files included in the interview prompt to bound token usage. */
const DEFAULT_MAX_SOURCE_FILES = 12;

/** Characters per file — enough for meaningful context without blowing the token budget. */
const DEFAULT_MAX_CHARS_PER_FILE = 3000;

/** Extensions the interview scanner will attempt to read. */
const PARSEABLE_FILE_EXTENSIONS = ['.tsx', '.jsx', '.ts', '.js'];

/** The canonical spec file name EZTest reads and writes. */
const SPEC_FILE_NAME = 'eztest-spec.md';

/** Glob patterns to exclude from source scanning (same as the code analyzer). */
const SOURCE_SCAN_EXCLUDE_PATTERNS = [
  '**/node_modules/**',
  '**/dist/**',
  '**/*.test.*',
  '**/*.spec.*',
  '**/__tests__/**',
  '**/coverage/**',
];

// ── Private Helpers ────────────────────────────────────────────────────────

/**
 * Discovers source files in the given directory and returns truncated excerpts
 * suitable for inclusion in an AI prompt without exceeding the token budget.
 */
async function readSourceFileExcerpts(
  sourceDirectory: string,
  maxFileCount: number,
  maxCharsPerFile: number,
): Promise<Array<{ filePath: string; excerpt: string }>> {
  const resolvedDirectory = resolve(sourceDirectory);

  // glob requires forward slashes even on Windows
  const normalizedDirectory = resolvedDirectory.replace(/\\/g, '/');
  const globPattern = `${normalizedDirectory}/**/*{${PARSEABLE_FILE_EXTENSIONS.join(',')}}`;

  const discoveredFiles = await glob(globPattern, {
    ignore: SOURCE_SCAN_EXCLUDE_PATTERNS,
    absolute: true,
  });

  const filesToRead = discoveredFiles.slice(0, maxFileCount);
  logDebug(`Reading ${filesToRead.length} of ${discoveredFiles.length} source files for interview`);

  const fileExcerpts: Array<{ filePath: string; excerpt: string }> = [];

  for (const absoluteFilePath of filesToRead) {
    try {
      const rawContent = readFileSync(absoluteFilePath, 'utf-8');
      const excerpt = rawContent.slice(0, maxCharsPerFile);
      const relativeFilePath = relative(resolvedDirectory, absoluteFilePath);
      fileExcerpts.push({ filePath: relativeFilePath, excerpt });
    } catch (readError) {
      logDebug(`Could not read ${absoluteFilePath}: ${String(readError)}`);
    }
  }

  return fileExcerpts;
}

/**
 * Reads the project name from package.json in the project root directory.
 * Falls back to the directory name if package.json is absent or unreadable.
 */
function readProjectName(projectRootDirectory: string): string {
  const packageJsonPath = join(resolve(projectRootDirectory), 'package.json');

  if (!existsSync(packageJsonPath)) {
    return resolve(projectRootDirectory).split(/[\\/]/).pop() ?? 'unknown-project';
  }

  try {
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8')) as { name?: string };
    return packageJson.name ?? 'unknown-project';
  } catch {
    return 'unknown-project';
  }
}

/**
 * Reads the existing eztest-spec.md from the project root if present.
 * The spec is passed to the AI so it can avoid re-asking questions the spec already answers.
 */
function readExistingSpec(projectRootDirectory: string): string | null {
  const specFilePath = join(resolve(projectRootDirectory), SPEC_FILE_NAME);

  if (!existsSync(specFilePath)) {
    return null;
  }

  try {
    return readFileSync(specFilePath, 'utf-8');
  } catch (readError) {
    logWarning(`Could not read existing spec at ${specFilePath}: ${String(readError)}`);
    return null;
  }
}

/**
 * Strips markdown code fences from an AI response string.
 * Models sometimes wrap JSON in ```json ... ``` blocks despite being asked not to.
 */
function stripMarkdownCodeFences(rawAiResponse: string): string {
  return rawAiResponse
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .trim();
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Generates 10 targeted behavioral interview questions by reading source files
 * and calling the AI to identify the most important ambiguous user-visible outcomes.
 *
 * Questions focus on things static analysis cannot determine: exact success messages,
 * navigation targets after actions, empty state copy, specific error text, and so on.
 *
 * Returns an empty array (with a logged warning) if the AI response cannot be parsed,
 * so callers can handle gracefully rather than crash.
 */
export async function generateInterviewQuestions(
  options: BehavioralInterviewOptions,
): Promise<InterviewQuestion[]> {
  const {
    sourceDirectory,
    projectRootDirectory,
    aiClient,
    maxSourceFiles = DEFAULT_MAX_SOURCE_FILES,
    maxCharsPerFile = DEFAULT_MAX_CHARS_PER_FILE,
  } = options;

  const projectName = readProjectName(projectRootDirectory);
  const existingSpecContent = readExistingSpec(projectRootDirectory);
  const sourceFileExcerpts = await readSourceFileExcerpts(sourceDirectory, maxSourceFiles, maxCharsPerFile);

  if (existingSpecContent) {
    logInfo('Using existing spec to avoid re-asking covered questions');
  }

  const promptMessages = buildInterviewQuestionsPrompt(
    projectName,
    sourceFileExcerpts,
    existingSpecContent,
  );

  let aiResponseContent: string;
  try {
    const aiResponse = await aiClient.chat(promptMessages, 'generate behavioral interview questions');
    aiResponseContent = aiResponse.content;
  } catch (callError) {
    logWarning(`AI call failed during question generation: ${String(callError)}`);
    return [];
  }

  const cleanedContent = stripMarkdownCodeFences(aiResponseContent);

  try {
    const parsedQuestions = JSON.parse(cleanedContent) as InterviewQuestion[];
    if (!Array.isArray(parsedQuestions)) {
      logWarning('AI returned non-array response for interview questions — using empty list');
      return [];
    }
    return parsedQuestions;
  } catch (parseError) {
    logWarning(
      `Could not parse interview questions JSON from AI response: ${String(parseError)}\n` +
      `Raw response (first 200 chars): ${aiResponseContent.slice(0, 200)}`,
    );
    return [];
  }
}

/**
 * Merges confirmed interview answers back into the existing spec content.
 *
 * The AI treats answers as ground truth — they override any assumption from static
 * analysis and are added as explicit Success Criteria and Failure Cases in the spec.
 * Returns the full updated spec as a string; the caller writes it to disk.
 */
export async function mergeAnswersIntoSpec(
  existingSpec: string,
  answers: InterviewAnswer[],
  aiClient: AiClientInterface,
): Promise<string> {
  const promptMessages = buildInterviewAnswerPrompt(existingSpec, answers);
  const aiResponse = await aiClient.chat(promptMessages, 'merge interview answers into spec');
  return aiResponse.content.trim();
}
