/**
 * Bug Report Builder — assembles all captured session data into a structured BugReport.
 *
 * The BugReport is the central artifact of EZTest's agent feedback loop.
 * It contains everything the AI agent needs to:
 * 1. Understand what the user was doing
 * 2. Reproduce the sequence of actions in a test
 * 3. Understand what outcome was expected vs. what actually happened
 * 4. Find the relevant code to fix
 */
import { randomUUID } from 'node:crypto';
import type { BugReport, RecordedInteraction } from '../shared/types.js';

/** Input data for building a bug report — all fields the session recorder collects. */
export interface BugReportInput {
  userExpectation: string;
  observedAtUrl: string;
  flaggedAt: string;
  interactionHistory: RecordedInteraction[];
  domStateAtFlag: string;
  screenshotAtFlag?: string;
  /** Optional: path to the source directory for the agent to analyze */
  sourceDirectory?: string;
}

/**
 * Assembles a structured BugReport from all collected session data.
 *
 * The report is designed to be sent directly to an AI agent prompt without
 * further processing — it should contain all context needed in a self-contained package.
 */
export function buildBugReport(input: BugReportInput): BugReport {
  return {
    reportId: randomUUID(),
    reportedAt: input.flaggedAt,
    observedAtUrl: input.observedAtUrl,
    userExpectation: input.userExpectation,
    interactionHistory: input.interactionHistory,
    screenshotAtFlag: input.screenshotAtFlag,
    domStateAtFlag: input.domStateAtFlag,
    sourceDirectory: input.sourceDirectory,
  };
}

/**
 * Formats a BugReport's interaction history into a human-readable numbered list
 * suitable for inclusion in an AI prompt.
 *
 * Example output:
 * "1. Navigated to /cart
 *  2. Clicked "Remove" button on "Widget Pro" item
 *  3. The cart total did not update"
 */
export function formatInteractionHistoryForPrompt(
  interactionHistory: RecordedInteraction[],
): string {
  if (interactionHistory.length === 0) {
    return '(No interactions recorded before the flag was raised)';
  }

  return interactionHistory
    .map((interaction, index) => {
      const stepNumber = index + 1;
      const description = interaction.targetDescription ?? interaction.targetSelector;

      switch (interaction.interactionKind) {
        case 'navigation':
          return `${stepNumber}. Navigated to ${interaction.pageUrl}`;
        case 'click':
          return `${stepNumber}. Clicked "${description}" at ${interaction.pageUrl}`;
        case 'input':
          return `${stepNumber}. Typed "${interaction.inputValue ?? ''}" into "${description}"`;
        case 'scroll':
          return `${stepNumber}. Scrolled on ${interaction.pageUrl}`;
        default:
          return `${stepNumber}. ${interaction.interactionKind} on "${description}"`;
      }
    })
    .join('\n');
}
