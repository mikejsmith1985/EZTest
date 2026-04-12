/**
 * The `eztest interview` command.
 *
 * Closes the gap from 90% to 95% test confidence by interactively asking the developer
 * 10 targeted questions about expected user-visible outcomes that AI cannot infer from
 * source code alone. Confirmed answers are merged back into eztest-spec.md as
 * ground-truth behavioral constraints that the test generator treats as authoritative.
 *
 * Usage: eztest interview [--source ./src] [--spec ./eztest-spec.md] [--output ./eztest-spec.md]
 */
import * as readline from 'node:readline';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Command } from 'commander';
import { loadConfig } from '../../shared/config.js';
import { AiClient } from '../../shared/aiClient.js';
import { logInfo, logSuccess, logError, logWarning } from '../../shared/logger.js';
import {
  generateInterviewQuestions,
  mergeAnswersIntoSpec,
} from '../../synthesizer/behavioralInterview.js';
import type { InterviewAnswer } from '../../synthesizer/behavioralInterview.js';

// ── Constants ──────────────────────────────────────────────────────────────

/**
 * Minimal spec content written when no existing eztest-spec.md is present.
 * Provides the AI with enough structure to merge answers into a coherent document.
 */
const MINIMAL_SPEC_CONTENT = `# Application Behavioral Spec

This spec was created by \`eztest interview\`. The sections below contain confirmed
behavioral expectations provided directly by the application owner.

`;

// ── Readline Helpers ───────────────────────────────────────────────────────

/**
 * Wraps Node's readline `question()` callback API in a Promise so the interview
 * loop can use async/await instead of nested callbacks.
 */
function promptUserForAnswer(
  readlineInterface: readline.Interface,
  promptText: string,
): Promise<string> {
  return new Promise(resolveAnswer => {
    readlineInterface.question(promptText, (userInput: string) => {
      resolveAnswer(userInput.trim());
    });
  });
}

// ── Interview Session ──────────────────────────────────────────────────────

/**
 * Runs the full interactive behavioral interview session:
 * 1. Scans source code
 * 2. Generates AI questions
 * 3. Prompts the developer for each answer
 * 4. Merges answers into the spec and writes it to disk
 */
async function runInterviewSession(commandOptions: {
  source: string;
  spec: string;
  output: string;
}): Promise<void> {
  const { source, spec: specFilePath, output: outputFilePath } = commandOptions;

  logInfo('Reading your application...');

  // ── Initialize AI client ── (same pattern as generate.ts)
  const ezTestConfig = loadConfig();
  const aiClient = new AiClient(ezTestConfig.ai);

  try {
    await aiClient.initialize();
    logInfo(`  AI: ${aiClient.providerName} / ${aiClient.modelName}`);
  } catch (initError) {
    logError('Failed to initialize AI client', initError);
    logError('Make sure OPENAI_API_KEY or ANTHROPIC_API_KEY is set in your environment.');
    process.exit(1);
  }

  // ── Stage 1: Generate interview questions ──
  let interviewQuestions;
  try {
    interviewQuestions = await generateInterviewQuestions({
      sourceDirectory: source,
      projectRootDirectory: process.cwd(),
      aiClient,
    });
  } catch (questionError) {
    logError('Failed to generate interview questions', questionError);
    process.exit(1);
  }

  logInfo(`AI generated ${interviewQuestions.length} questions`);

  if (interviewQuestions.length === 0) {
    logWarning('Could not generate questions. Ensure your source directory contains application code.');
    process.exit(0);
  }

  // ── Stage 2: Collect answers interactively ──
  const readlineInterface = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const collectedAnswers: InterviewAnswer[] = [];

  console.log('\nAnswer each question about what your users should see and experience.');
  console.log('Press Enter to skip a question.\n');

  for (let questionIndex = 0; questionIndex < interviewQuestions.length; questionIndex++) {
    const currentQuestion = interviewQuestions[questionIndex];
    const questionNumber = questionIndex + 1;
    const totalQuestions = interviewQuestions.length;

    console.log(`\n[Feature: ${currentQuestion.feature}]`);
    console.log(`Question ${questionNumber}/${totalQuestions}: ${currentQuestion.question}`);
    console.log(`(Why this matters: ${currentQuestion.context})`);

    const userAnswer = await promptUserForAnswer(readlineInterface, '> Your answer: ');

    // Only store the answer if the developer typed something — skipped questions are omitted
    const hasAnswer = userAnswer.length > 0;
    if (hasAnswer) {
      collectedAnswers.push({
        question: currentQuestion.question,
        answer: userAnswer,
        feature: currentQuestion.feature,
      });
    }
  }

  readlineInterface.close();

  const hasAnyAnswers = collectedAnswers.length > 0;
  if (!hasAnyAnswers) {
    logWarning('No answers were provided — spec was not updated.');
    process.exit(0);
  }

  // ── Stage 3: Merge answers into spec ──
  const resolvedSpecPath = resolve(specFilePath);
  const isExistingSpecPresent = existsSync(resolvedSpecPath);

  const existingSpecContent = isExistingSpecPresent
    ? readFileSync(resolvedSpecPath, 'utf-8')
    : MINIMAL_SPEC_CONTENT;

  let updatedSpecContent: string;
  try {
    updatedSpecContent = await mergeAnswersIntoSpec(existingSpecContent, collectedAnswers, aiClient);
  } catch (mergeError) {
    logError('Failed to merge answers into spec', mergeError);
    process.exit(1);
  }

  const resolvedOutputPath = resolve(outputFilePath);
  writeFileSync(resolvedOutputPath, updatedSpecContent, 'utf-8');

  logSuccess(`✓ eztest-spec.md updated with ${collectedAnswers.length} confirmed expectations`);
  logInfo(`  Written to: ${resolvedOutputPath}`);
  logInfo('\nRun `eztest generate` to create tests using your confirmed expectations');
}

// ── Command Registration ───────────────────────────────────────────────────

/**
 * Registers the `interview` subcommand on the given Commander program instance.
 *
 * The interview command is the primary mechanism for capturing human intent about
 * expected user-visible outcomes — things AI cannot determine from source code alone,
 * such as exact success messages, post-login redirect URLs, and empty-state copy.
 */
export function registerInterviewCommand(program: Command): void {
  program
    .command('interview')
    .description(
      'Interactively answer 10 AI-generated questions about expected user-visible outcomes. ' +
      'Answers are merged into eztest-spec.md as ground-truth behavioral constraints for test generation.',
    )
    .option(
      '--source <dir>',
      'Source code directory to analyze',
      './src',
    )
    .option(
      '--spec <file>',
      'Path to existing spec to update',
      './eztest-spec.md',
    )
    .option(
      '--output <file>',
      'Where to write the updated spec',
      './eztest-spec.md',
    )
    .action(async (commandOptions: {
      source: string;
      spec: string;
      output: string;
    }) => {
      await runInterviewSession(commandOptions);
    });
}
