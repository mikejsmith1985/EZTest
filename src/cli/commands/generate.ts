/**
 * The `eztest generate` command.
 *
 * Orchestrates the full Phase 1 synthesis pipeline:
 * 1. Reads source code from the target directory
 * 2. Analyzes components with the CodeAnalyzer
 * 3. Maps components to user flows with the FlowMapper
 * 4. Generates Playwright test files with the TestGenerator
 *
 * Usage: eztest generate --source ./src --url http://localhost:3000 --output ./tests/e2e
 */
import type { Command } from 'commander';
import { loadConfig } from '../../shared/config.js';
import { AiClient } from '../../shared/aiClient.js';
import { logInfo, logSuccess, logError, logWarning, enableVerboseLogging } from '../../shared/logger.js';
import { analyzeSourceDirectory } from '../../synthesizer/codeAnalyzer.js';
import { mapComponentAnalysesToUserFlows } from '../../synthesizer/flowMapper.js';
import { generateTestsForFlows } from '../../synthesizer/testGenerator.js';

/** Maximum components to analyze per run — prevents runaway API costs. */
const DEFAULT_MAX_COMPONENT_COUNT = 50;

/**
 * Registers the `generate` subcommand on the given Commander program instance.
 * All options have sensible defaults pulled from the loaded config.
 */
export function registerGenerateCommand(program: Command): void {
  program
    .command('generate')
    .description(
      'Analyze source code and generate Playwright behavioral tests using AI. ' +
      'Tests validate what users see and experience, not internal implementation details.'
    )
    .option(
      '-s, --source <directory>',
      'Source code directory to analyze',
      './src',
    )
    .option(
      '-u, --url <url>',
      'URL where the target application is running',
      'http://localhost:3000',
    )
    .option(
      '-o, --output <directory>',
      'Directory to write generated test files',
      './tests/e2e',
    )
    .option(
      '--no-edge-cases',
      'Skip generating edge case and error scenario tests (faster, fewer tokens)',
    )
    .option(
      '--max-components <number>',
      'Maximum number of components to analyze',
      String(DEFAULT_MAX_COMPONENT_COUNT),
    )
    .option(
      '--no-deep-analysis',
      'Skip per-component intent analysis (faster but may produce less connected flows)',
    )
    .option(
      '--dry-run',
      'Generate tests but print to stdout instead of writing files',
    )
    .option(
      '-v, --verbose',
      'Enable verbose debug logging',
    )
    .action(async (commandOptions: {
      source: string;
      url: string;
      output: string;
      edgeCases: boolean;
      maxComponents: string;
      deepAnalysis: boolean;
      dryRun: boolean;
      verbose: boolean;
    }) => {
      if (commandOptions.verbose) {
        enableVerboseLogging();
      }

      const ezTestConfig = loadConfig();
      const maxComponentCount = parseInt(commandOptions.maxComponents, 10) || DEFAULT_MAX_COMPONENT_COUNT;

      logInfo(`Starting EZTest generate...`);
      logInfo(`  Source: ${commandOptions.source}`);
      logInfo(`  Target URL: ${commandOptions.url}`);
      logInfo(`  Output: ${commandOptions.output}`);

      // ── Stage 1: Initialize AI client ──
      const aiClient = new AiClient(ezTestConfig.ai);
      try {
        await aiClient.initialize();
        logInfo(`  AI: ${aiClient.providerName} / ${aiClient.modelName}`);
      } catch (initError) {
        logError('Failed to initialize AI client', initError);
        logError(
          'Make sure OPENAI_API_KEY or ANTHROPIC_API_KEY is set in your environment.'
        );
        process.exit(1);
      }

      // ── Stage 2: Analyze source code ──
      logInfo('\nAnalyzing source code...');
      let componentAnalyses;
      try {
        componentAnalyses = await analyzeSourceDirectory({
          sourceDirectory: commandOptions.source,
          excludePatterns: ezTestConfig.globalExcludePatterns,
          maxFileCount: maxComponentCount,
        });
      } catch (analysisError) {
        logError('Source code analysis failed', analysisError);
        process.exit(1);
      }

      if (componentAnalyses.length === 0) {
        logWarning(
          `No interactive components found in ${commandOptions.source}. ` +
          `Make sure the path is correct and the directory contains JSX/TSX files.`
        );
        process.exit(0);
      }

      logSuccess(`Found ${componentAnalyses.length} components with interactive elements`);

      // ── Stage 3: Map to user flows ──
      logInfo('\nMapping components to user flows...');
      let userFlows;
      try {
        userFlows = await mapComponentAnalysesToUserFlows(componentAnalyses, aiClient, {
          targetAppUrl: commandOptions.url,
          shouldAnalyzeIndividualComponents: commandOptions.deepAnalysis,
        });
      } catch (mappingError) {
        logError('User flow mapping failed', mappingError);
        process.exit(1);
      }

      if (userFlows.length === 0) {
        logWarning('No user flows were generated. The AI may have had trouble understanding the component structure.');
        process.exit(0);
      }

      // Filter out edge cases if requested
      const flowsToGenerate = commandOptions.edgeCases
        ? userFlows
        : userFlows.filter(flow => flow.flowKind === 'happy-path');

      logSuccess(`Identified ${userFlows.length} user flows (generating tests for ${flowsToGenerate.length})`);

      // ── Stage 4: Generate test files ──
      logInfo('\nGenerating Playwright test files...');
      let generationResult;
      try {
        generationResult = await generateTestsForFlows(flowsToGenerate, aiClient, {
          targetAppUrl: commandOptions.url,
          outputDirectory: commandOptions.output,
          shouldWriteFilesToDisk: !commandOptions.dryRun,
        });
      } catch (generationError) {
        logError('Test generation failed', generationError);
        process.exit(1);
      }

      // ── Summary ──
      console.log('');
      logSuccess(`Done! Generated ${generationResult.generatedFiles.length} test files`);
      logInfo(`  Total assertions: ${generationResult.totalAssertionCount}`);

      if (generationResult.failedFlowCount > 0) {
        logWarning(`  ${generationResult.failedFlowCount} flows failed to generate (check verbose output for details)`);
      }

      if (commandOptions.dryRun) {
        console.log('\n─── Generated Test Files ───\n');
        for (const generatedFile of generationResult.generatedFiles) {
          console.log(`\n// ─── ${generatedFile.suggestedOutputPath} ───`);
          console.log(generatedFile.testSourceCode);
        }
      } else {
        logInfo(`\nRun your tests with: npx playwright test ${commandOptions.output}`);
      }
    });
}
