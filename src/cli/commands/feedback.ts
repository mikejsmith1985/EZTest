/**
 * The `eztest feedback` command.
 *
 * Manages the eztest-feedback.json project learning file — the persistent memory
 * that makes EZTest improve test generation quality over time for a specific codebase.
 * Users can flag false positives, record confirmed expectations, inspect current
 * learnings, or clear the file to start fresh.
 *
 * Usage:
 *   eztest feedback --show
 *   eztest feedback --flag-false-positive "test name" --reason "why it was wrong"
 *   eztest feedback --confirm-expectation "feature" --expectation "what the user sees"
 *   eztest feedback --clear
 */
import { existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { Command } from 'commander';
import { logInfo, logSuccess, logError, logWarning } from '../../shared/logger.js';
import {
  readProjectFeedback,
  recordFalsePositive,
  recordConfirmedExpectation,
} from '../../synthesizer/feedbackStore.js';

// ── Constants ──────────────────────────────────────────────────────────────

/** The file name of the project feedback file — kept here as a single source of truth. */
const FEEDBACK_FILE_NAME = 'eztest-feedback.json';

// ── Internal Helpers ───────────────────────────────────────────────────────

/**
 * Prints the current contents of the feedback file to stdout in pretty-printed
 * JSON format. If no feedback file exists, informs the user that no learnings
 * have been recorded yet.
 */
function showCurrentFeedback(): void {
  const currentFeedback = readProjectFeedback('.');

  if (!currentFeedback) {
    logInfo('No feedback file found. EZTest has not recorded any project learnings yet.');
    logInfo(`Run tests or use this command to start building the ${FEEDBACK_FILE_NAME} file.`);
    return;
  }

  const selectorFixCount = currentFeedback.selectorFixes.length;
  const expectationCount = currentFeedback.confirmedExpectations.length;
  const falsePositiveCount = currentFeedback.falsePositives.length;

  logInfo(`Project feedback summary:`);
  logInfo(`  Selector fixes recorded:        ${selectorFixCount}`);
  logInfo(`  Confirmed expectations:         ${expectationCount}`);
  logInfo(`  False positives flagged:        ${falsePositiveCount}`);
  console.log('\n' + JSON.stringify(currentFeedback, null, 2));
}

/**
 * Flags a test as a false positive and writes it into the feedback file.
 * Requires both a test name and a reason — without context, the record is meaningless
 * for future AI prompt injection.
 */
function flagFalsePositive(testName: string, reason: string | undefined): void {
  if (!reason || !reason.trim()) {
    logError('--reason is required when using --flag-false-positive.');
    logInfo('Example: eztest feedback --flag-false-positive "validates form" --reason "was testing code, not user outcome"');
    process.exit(1);
  }

  recordFalsePositive('.', { testName: testName.trim(), reason: reason.trim() });
  logSuccess(`False positive recorded: "${testName}"`);
  logInfo(`This test will be excluded from future AI generation patterns.`);
}

/**
 * Records a confirmed user expectation for the given feature area.
 * Requires both a feature name and the expectation text — the combination is
 * what gets injected into AI prompts as ground-truth project knowledge.
 */
function confirmExpectation(feature: string, expectationText: string | undefined): void {
  if (!expectationText || !expectationText.trim()) {
    logError('--expectation is required when using --confirm-expectation.');
    logInfo('Example: eztest feedback --confirm-expectation "contact form" --expectation "After submitting, user sees Message sent!"');
    process.exit(1);
  }

  recordConfirmedExpectation('.', {
    feature: feature.trim(),
    expectation: expectationText.trim(),
  });

  logSuccess(`Confirmed expectation recorded for feature: "${feature}"`);
  logInfo(`This will be injected into future AI prompts to anchor test generation.`);
}

/**
 * Removes the feedback file after printing a clear warning to the user.
 * This is intentionally destructive — all recorded learnings are permanently lost.
 */
function clearAllFeedback(): void {
  const feedbackFilePath = join('.', FEEDBACK_FILE_NAME);

  if (!existsSync(feedbackFilePath)) {
    logInfo('No feedback file found — nothing to clear.');
    return;
  }

  logWarning('This will clear all EZTest project learnings. This cannot be undone.');

  try {
    unlinkSync(feedbackFilePath);
    logSuccess(`Cleared all feedback. ${FEEDBACK_FILE_NAME} has been deleted.`);
  } catch (deleteError) {
    logError(`Failed to delete ${feedbackFilePath}`, deleteError);
    process.exit(1);
  }
}

// ── Command Registration ───────────────────────────────────────────────────

/**
 * Registers the `feedback` subcommand on the given Commander program instance.
 *
 * The feedback command is the user-facing interface for EZTest's project learning
 * system. It allows users to inspect, add to, and manage the eztest-feedback.json
 * file — the persistent knowledge base that makes EZTest improve over time.
 */
export function registerFeedbackCommand(program: Command): void {
  program
    .command('feedback')
    .description(
      'Manage EZTest project learnings stored in eztest-feedback.json. ' +
      'Flag false positives, record confirmed expectations, or inspect current learnings.',
    )
    .option(
      '--flag-false-positive <testName>',
      'Mark a test as a false positive (a test that passed when it should not have)',
    )
    .option(
      '--reason <text>',
      'Reason the test is a false positive (required with --flag-false-positive)',
    )
    .option(
      '--confirm-expectation <feature>',
      'Record a confirmed expectation for a feature area',
    )
    .option(
      '--expectation <text>',
      'The expectation text (required with --confirm-expectation)',
    )
    .option(
      '--show',
      'Print the current feedback file contents',
    )
    .option(
      '--clear',
      'Clear all feedback (permanently removes eztest-feedback.json)',
    )
    .action((commandOptions: {
      flagFalsePositive?: string;
      reason?: string;
      confirmExpectation?: string;
      expectation?: string;
      show?: boolean;
      clear?: boolean;
    }) => {
      const hasNoOptions = !commandOptions.show &&
        !commandOptions.clear &&
        !commandOptions.flagFalsePositive &&
        !commandOptions.confirmExpectation;

      // Default to --show when no option is given — a useful no-argument experience
      if (hasNoOptions) {
        showCurrentFeedback();
        return;
      }

      if (commandOptions.show) {
        showCurrentFeedback();
        return;
      }

      if (commandOptions.clear) {
        clearAllFeedback();
        return;
      }

      if (commandOptions.flagFalsePositive) {
        flagFalsePositive(commandOptions.flagFalsePositive, commandOptions.reason);
        return;
      }

      if (commandOptions.confirmExpectation) {
        confirmExpectation(commandOptions.confirmExpectation, commandOptions.expectation);
        return;
      }
    });
}
