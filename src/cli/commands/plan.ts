/**
 * The `eztest plan` command.
 *
 * Runs source analysis and AI flow mapping (the same first two stages as
 * `eztest generate`) but stops short of writing any test code. Instead,
 * it produces a human-readable markdown test plan so the developer can
 * verify EZTest understands their app before committing to a full generation run.
 *
 * Usage: eztest plan [--source ./src] [--url <url>] [--output plan.md] [--spec eztest-spec.md]
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Command } from 'commander';
import { loadConfig } from '../../shared/config.js';
import { AiClient } from '../../shared/aiClient.js';
import { logInfo, logSuccess, logError, logWarning } from '../../shared/logger.js';
import { detectAndReadAppSpec, readAppSpecFromFile } from '../../synthesizer/appSpecReader.js';
import { generateTestPlan } from '../../synthesizer/testPlanner.js';

// ── Constants ──────────────────────────────────────────────────────────────

/** Default source directory when --source is not provided. */
const DEFAULT_SOURCE_DIRECTORY = './src';

// ── Output Helpers ─────────────────────────────────────────────────────────

/**
 * Attempts to colorize a markdown plan for terminal output using ANSI codes.
 * Falls back to plain text if stdout is not a TTY (e.g. piped to a file).
 *
 * Highlights headings, checkmarks, and warning markers so the plan is
 * comfortable to read in a terminal without requiring an external library.
 */
function formatPlanForTerminal(planMarkdown: string): string {
  if (!process.stdout.isTTY) {
    return planMarkdown;
  }

  // ANSI escape codes for terminal colorization
  const RESET = '\x1b[0m';
  const BOLD = '\x1b[1m';
  const CYAN = '\x1b[36m';
  const GREEN = '\x1b[32m';
  const YELLOW = '\x1b[33m';
  const RED = '\x1b[31m';
  const DIM = '\x1b[2m';

  return planMarkdown
    // Top-level headings: bold cyan
    .replace(/^(# .+)$/gm, `${BOLD}${CYAN}$1${RESET}`)
    // Second-level headings: bold
    .replace(/^(## .+)$/gm, `${BOLD}$1${RESET}`)
    // Third-level scenario headings: colorize by marker type
    .replace(/^(### ✅.+)$/gm, `${GREEN}$1${RESET}`)
    .replace(/^(### ⚠️.+)$/gm, `${YELLOW}$1${RESET}`)
    .replace(/^(### ❌.+)$/gm, `${RED}$1${RESET}`)
    .replace(/^(### ❓.+)$/gm, `${YELLOW}$1${RESET}`)
    // Bold inline text (**word**)
    .replace(/\*\*(.+?)\*\*/g, `${BOLD}$1${RESET}`)
    // Italic/complexity notes (_note_)
    .replace(/_(.+?)_/g, `${DIM}$1${RESET}`);
}

/**
 * Writes the plan markdown to a file and logs the resolved output path.
 * Exits the process with code 1 if the write fails.
 */
function writePlanToOutputFile(planMarkdown: string, outputFilePath: string): void {
  const resolvedOutputPath = resolve(outputFilePath);
  try {
    writeFileSync(resolvedOutputPath, planMarkdown, 'utf-8');
    logSuccess(`Plan written to: ${resolvedOutputPath}`);
  } catch (writeError) {
    logError(`Failed to write plan to ${resolvedOutputPath}`, writeError);
    process.exit(1);
  }
}

// ── Command Registration ───────────────────────────────────────────────────

/**
 * Registers the `plan` subcommand on the given Commander program instance.
 *
 * The plan command is designed to be run BEFORE `eztest generate` so the
 * developer can review what will be tested and catch misunderstandings early.
 */
export function registerPlanCommand(program: Command): void {
  program
    .command('plan')
    .description(
      'Analyze source code and produce a human-readable test plan before generating any tests. ' +
      'Review and approve the plan, then run `eztest generate` to create the tests.',
    )
    .option(
      '-s, --source <dir>',
      'Source directory to analyze',
      DEFAULT_SOURCE_DIRECTORY,
    )
    .option(
      '-u, --url <url>',
      'URL of the running application (used for flow context only, not fetched)',
    )
    .option(
      '-o, --output <file>',
      'Write the plan to a file instead of (or in addition to) stdout',
    )
    .option(
      '--spec <file>',
      'Path to eztest-spec.md or README for business context. Auto-detected when not provided.',
    )
    .action(async (commandOptions: {
      source: string;
      url?: string;
      output?: string;
      spec?: string;
    }) => {
      logInfo(`Analyzing ${commandOptions.source}...`);

      // ── Load app spec ──────────────────────────────────────────────────
      // The spec dramatically improves plan quality by giving the AI the
      // business intent alongside the mechanical source-code analysis.
      let appSpecContent: string | null = null;
      if (commandOptions.spec) {
        const specResult = readAppSpecFromFile(commandOptions.spec);
        appSpecContent = specResult?.specContent ?? null;
      } else {
        appSpecContent = detectAndReadAppSpec(commandOptions.source);
        if (!appSpecContent) {
          logWarning(
            '  No app spec found. Create an eztest-spec.md for more accurate plans.\n' +
            '  Tip: Run `eztest interview` first to build one interactively.',
          );
        }
      }

      // ── Initialize AI client ───────────────────────────────────────────
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

      // ── Generate the plan ──────────────────────────────────────────────
      let planResult;
      try {
        planResult = await generateTestPlan({
          sourceDirectory: commandOptions.source,
          appSpecContent,
          aiClient,
        });
      } catch (planError) {
        logError('Test plan generation failed', planError);
        process.exit(1);
      }

      // ── Output: file ───────────────────────────────────────────────────
      if (commandOptions.output) {
        writePlanToOutputFile(planResult.planMarkdown, commandOptions.output);
      }

      // ── Output: terminal ───────────────────────────────────────────────
      // Always print to stdout so developers can review inline without opening a file.
      console.log('\n' + formatPlanForTerminal(planResult.planMarkdown) + '\n');

      // ── Summary line ───────────────────────────────────────────────────
      logSuccess(
        `Plan complete: ${planResult.featureCount} features, ${planResult.scenarioCount} scenarios`,
      );

      // ── Follow-up tips ─────────────────────────────────────────────────
      if (planResult.hasAmbiguousFlows) {
        logWarning(
          'Tip: Run `eztest interview` to clarify ambiguous expectations before generating.',
        );
      }

      logInfo('Ready? Run `eztest generate` to create the tests.');
    });
}
