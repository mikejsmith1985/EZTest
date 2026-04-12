/**
 * The `eztest init` command.
 *
 * Scans the user's source code and uses AI to generate a high-quality
 * eztest-spec.md behavioral specification. The spec anchors every generated
 * test to a real user expectation rather than an implementation detail — it is
 * the single biggest quality lever in the EZTest system.
 *
 * Usage: eztest init [--source ./src] [--output ./eztest-spec.md] [--dry-run]
 */
import { existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Command } from 'commander';
import { loadConfig } from '../../shared/config.js';
import { AiClient } from '../../shared/aiClient.js';
import { logInfo, logSuccess, logError, logWarning } from '../../shared/logger.js';
import { generateAppSpec } from '../../synthesizer/specGenerator.js';

// ── Constants ──────────────────────────────────────────────────────────────

/** Default directory to scan for application source code. */
const DEFAULT_SOURCE_DIRECTORY = './src';

/** Default file path where the generated spec will be written. */
const DEFAULT_OUTPUT_FILE = './eztest-spec.md';

// ── Command Registration ───────────────────────────────────────────────────

/**
 * Registers the `init` subcommand on the given Commander program instance.
 *
 * The init command reads the user's project source code and generates an
 * eztest-spec.md using AI — a plain-English behavioral specification that
 * describes what real users should see and experience at every feature boundary.
 * Running `eztest generate` after `eztest init` produces dramatically higher
 * quality tests because the AI has explicit success criteria to write against.
 */
export function registerInitCommand(program: Command): void {
  program
    .command('init')
    .description(
      'Analyze your source code with AI and generate an eztest-spec.md behavioral specification. ' +
      'Run this once per project before using `eztest generate` for best test quality.',
    )
    .option(
      '-s, --source <dir>',
      'Source code directory to analyze',
      DEFAULT_SOURCE_DIRECTORY,
    )
    .option(
      '-o, --output <file>',
      'Where to write the generated spec file',
      DEFAULT_OUTPUT_FILE,
    )
    .option(
      '--dry-run',
      'Print the generated spec to stdout instead of writing it to disk',
    )
    .action(async (commandOptions: {
      source: string;
      output: string;
      dryRun: boolean;
    }) => {
      logInfo(`Analyzing ${commandOptions.source} with AI...`);

      // ── Stage 1: Initialize AI client ──
      // Same initialization pattern used by `eztest generate` — loads provider
      // and API key from the resolved config (env vars + eztest.config.json).
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

      // ── Stage 2: Generate the behavioral spec ──
      let generatedSpec;
      try {
        generatedSpec = await generateAppSpec({
          sourceDirectory: commandOptions.source,
          // Project root is always the current working directory when running the CLI
          projectRootDirectory: '.',
          aiClient,
        });
      } catch (generationError) {
        logError('Spec generation failed', generationError);
        process.exit(1);
      }

      logSuccess(
        `Analyzed ${generatedSpec.sourceFilesAnalyzed} source file(s) for "${generatedSpec.projectName}"`,
      );

      // ── Stage 3: Output the spec ──
      if (commandOptions.dryRun) {
        console.log('\n─── Generated eztest-spec.md ───\n');
        console.log(generatedSpec.specContent);
        return;
      }

      const resolvedOutputPath = resolve(commandOptions.output);
      const doesOutputFileExist = existsSync(resolvedOutputPath);

      // Warn before overwriting an existing spec — the user may have hand-edited it
      if (doesOutputFileExist) {
        logWarning(`${resolvedOutputPath} already exists — overwriting with newly generated spec.`);
      }

      try {
        writeFileSync(resolvedOutputPath, generatedSpec.specContent, 'utf-8');
      } catch (writeError) {
        logError(`Failed to write spec to ${resolvedOutputPath}`, writeError);
        process.exit(1);
      }

      logSuccess(`Spec written to ${resolvedOutputPath}`);
      logInfo(
        `\nNext step: run \`eztest generate\` to create Playwright tests anchored to this spec.`,
      );
    });
}
