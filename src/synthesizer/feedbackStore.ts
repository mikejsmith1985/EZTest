/**
 * Feedback Store — reads and writes the eztest-feedback.json project learning file.
 *
 * This is EZTest's memory. Every selector fix, user correction, and confirmed
 * expectation is stored here and injected into future AI prompts so EZTest
 * improves its test generation quality over time for this specific codebase.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { logDebug, logWarning } from '../shared/logger.js';

// ── Constants ──────────────────────────────────────────────────────────────

/** The name of the project feedback file, stored in the project root. */
const FEEDBACK_FILE_NAME = 'eztest-feedback.json';

/** The current schema version for the feedback file — bump when shape changes. */
const FEEDBACK_SCHEMA_VERSION = '1';

// ── Public Interfaces ──────────────────────────────────────────────────────

/** A selector fix recorded during a --run-and-fix pass. */
export interface SelectorFix {
  originalSelector: string;
  fixedSelector: string;
  /** The component this fix was observed in — e.g., "ContactForm". */
  componentHint: string;
  /** ISO 8601 timestamp of when this fix was first recorded. */
  recordedAt: string;
}

/** A test the user confirmed was a false positive (passed when it shouldn't have). */
export interface FalsePositiveRecord {
  testName: string;
  /** Why this test is a false positive — from the user's description. */
  reason: string;
  /** ISO 8601 timestamp of when this record was created. */
  recordedAt: string;
}

/** A confirmed user expectation captured via `eztest interview`. */
export interface ConfirmedExpectation {
  /** The feature area this expectation belongs to — e.g., "contact form". */
  feature: string;
  /** The expectation text — e.g., "After submitting, user sees 'Message sent!'". */
  expectation: string;
  /** ISO 8601 timestamp of when this expectation was confirmed. */
  recordedAt: string;
}

/** The full shape of the eztest-feedback.json file. */
export interface ProjectFeedback {
  /** Schema version — used to detect stale files after future format changes. */
  version: string;
  selectorFixes: SelectorFix[];
  falsePositives: FalsePositiveRecord[];
  confirmedExpectations: ConfirmedExpectation[];
}

// ── Internal Helpers ───────────────────────────────────────────────────────

/**
 * Returns the absolute path to the eztest-feedback.json file in the given project root.
 */
function resolveFeedbackFilePath(projectRootDirectory: string): string {
  return join(projectRootDirectory, FEEDBACK_FILE_NAME);
}

/**
 * Returns true when the given value looks like a valid ProjectFeedback object.
 * Validates that all required array fields are present — guards against corrupted files.
 */
function isValidProjectFeedback(candidate: unknown): candidate is ProjectFeedback {
  if (typeof candidate !== 'object' || candidate === null) return false;
  const obj = candidate as Record<string, unknown>;
  return (
    typeof obj['version'] === 'string' &&
    Array.isArray(obj['selectorFixes']) &&
    Array.isArray(obj['falsePositives']) &&
    Array.isArray(obj['confirmedExpectations'])
  );
}

/**
 * Builds and returns an empty ProjectFeedback object with the current schema version.
 * Used when no feedback file exists yet.
 */
function createEmptyFeedback(): ProjectFeedback {
  return {
    version: FEEDBACK_SCHEMA_VERSION,
    selectorFixes: [],
    falsePositives: [],
    confirmedExpectations: [],
  };
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Reads the eztest-feedback.json file from the project root directory.
 *
 * Returns null if the file does not exist, cannot be read, or fails validation.
 * Callers should treat null as "no prior learnings available" and continue normally.
 */
export function readProjectFeedback(projectRootDirectory: string): ProjectFeedback | null {
  const feedbackFilePath = resolveFeedbackFilePath(projectRootDirectory);

  if (!existsSync(feedbackFilePath)) {
    logDebug(`No feedback file found at ${feedbackFilePath}`);
    return null;
  }

  let rawFileContent: string;
  try {
    rawFileContent = readFileSync(feedbackFilePath, 'utf-8');
  } catch (readError) {
    logWarning(`Could not read feedback file at ${feedbackFilePath}: ${String(readError)}`);
    return null;
  }

  let parsedContent: unknown;
  try {
    parsedContent = JSON.parse(rawFileContent);
  } catch (parseError) {
    logWarning(`Feedback file at ${feedbackFilePath} contains invalid JSON — ignoring: ${String(parseError)}`);
    return null;
  }

  if (!isValidProjectFeedback(parsedContent)) {
    logWarning(`Feedback file at ${feedbackFilePath} has unexpected structure — ignoring.`);
    return null;
  }

  logDebug(`Loaded project feedback: ${parsedContent.selectorFixes.length} selector fixes, ${parsedContent.confirmedExpectations.length} expectations`);
  return parsedContent;
}

/**
 * Writes the given ProjectFeedback object to eztest-feedback.json in the project root.
 *
 * Creates the file if it does not exist. Overwrites the file if it does.
 * Uses 2-space indentation for human readability.
 */
export function writeProjectFeedback(projectRootDirectory: string, feedback: ProjectFeedback): void {
  const feedbackFilePath = resolveFeedbackFilePath(projectRootDirectory);
  const serializedContent = JSON.stringify(feedback, null, 2);
  writeFileSync(feedbackFilePath, serializedContent, 'utf-8');
  logDebug(`Wrote project feedback to ${feedbackFilePath}`);
}

/**
 * Records a selector fix into the project feedback file.
 *
 * Reads the existing feedback (creating empty feedback if none exists), appends the
 * new fix if it is not already present (deduplication by originalSelector + fixedSelector
 * pair), then writes the updated feedback back to disk.
 */
export function recordSelectorFix(
  projectRootDirectory: string,
  fix: Omit<SelectorFix, 'recordedAt'>,
): void {
  const existingFeedback = readProjectFeedback(projectRootDirectory) ?? createEmptyFeedback();

  const isAlreadyRecorded = existingFeedback.selectorFixes.some(
    existingFix =>
      existingFix.originalSelector === fix.originalSelector &&
      existingFix.fixedSelector === fix.fixedSelector,
  );

  if (isAlreadyRecorded) {
    logDebug(`Selector fix already recorded: "${fix.originalSelector}" → "${fix.fixedSelector}"`);
    return;
  }

  const newFix: SelectorFix = { ...fix, recordedAt: new Date().toISOString() };
  existingFeedback.selectorFixes.push(newFix);
  writeProjectFeedback(projectRootDirectory, existingFeedback);
}

/**
 * Records a user-flagged false positive into the project feedback file.
 *
 * Reads the existing feedback (or creates empty), appends the record,
 * then writes back. Does not deduplicate — users may flag different reasons
 * for the same test on different occasions.
 */
export function recordFalsePositive(
  projectRootDirectory: string,
  record: Omit<FalsePositiveRecord, 'recordedAt'>,
): void {
  const existingFeedback = readProjectFeedback(projectRootDirectory) ?? createEmptyFeedback();
  const newRecord: FalsePositiveRecord = { ...record, recordedAt: new Date().toISOString() };
  existingFeedback.falsePositives.push(newRecord);
  writeProjectFeedback(projectRootDirectory, existingFeedback);
}

/**
 * Records a confirmed user expectation into the project feedback file.
 *
 * These expectations are captured via `eztest interview` and represent
 * ground-truth knowledge from the application owner about expected behavior.
 * They are injected into future AI prompts to anchor test generation to real requirements.
 */
export function recordConfirmedExpectation(
  projectRootDirectory: string,
  record: Omit<ConfirmedExpectation, 'recordedAt'>,
): void {
  const existingFeedback = readProjectFeedback(projectRootDirectory) ?? createEmptyFeedback();
  const newRecord: ConfirmedExpectation = { ...record, recordedAt: new Date().toISOString() };
  existingFeedback.confirmedExpectations.push(newRecord);
  writeProjectFeedback(projectRootDirectory, existingFeedback);
}

/**
 * Formats the given ProjectFeedback into a plain-English summary string for
 * injection into AI prompts.
 *
 * This is the mechanism that makes EZTest improve over time: historical fixes,
 * confirmed expectations, and false-positive flags are surfaced directly to the
 * AI at generation time so it avoids repeating known mistakes.
 *
 * Returns an empty string when the feedback contains no entries worth injecting.
 */
export function formatFeedbackForPrompt(feedback: ProjectFeedback): string {
  const hasSelectorFixes = feedback.selectorFixes.length > 0;
  const hasConfirmedExpectations = feedback.confirmedExpectations.length > 0;
  const hasFalsePositives = feedback.falsePositives.length > 0;

  if (!hasSelectorFixes && !hasConfirmedExpectations && !hasFalsePositives) {
    return '';
  }

  const sections: string[] = [
    'PROJECT-SPECIFIC LEARNINGS (apply these to avoid known issues):',
  ];

  if (hasSelectorFixes) {
    const fixLines = feedback.selectorFixes.map(
      fix => `- In ${fix.componentHint}: use ${fix.fixedSelector} instead of ${fix.originalSelector}`,
    );
    sections.push('\nSelector fixes from previous runs:\n' + fixLines.join('\n'));
  }

  if (hasConfirmedExpectations) {
    const expectationLines = feedback.confirmedExpectations.map(
      expectation => `- ${expectation.expectation}`,
    );
    sections.push('\nConfirmed user expectations:\n' + expectationLines.join('\n'));
  }

  if (hasFalsePositives) {
    const falsePositiveLines = feedback.falsePositives.map(
      record => `- "${record.testName}" — ${record.reason}`,
    );
    sections.push(
      '\nTests previously flagged as false positives (do not generate similar ones):\n' +
      falsePositiveLines.join('\n'),
    );
  }

  return sections.join('\n');
}
