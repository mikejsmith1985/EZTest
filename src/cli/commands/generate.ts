/**
 * The `eztest generate` command.
 *
 * Orchestrates the full AI Test Synthesizer pipeline:
 * 1. Reads source code from the target directory
 * 2. Auto-detects or reads an app spec (README/eztest-spec.md) for business context
 * 3. Analyzes components with the CodeAnalyzer
 * 4. Maps components to user flows with the FlowMapper
 * 5. Generates Playwright test files with the TestGenerator
 * 6. Optionally runs a second behavioral assertion review pass
 * 7. Optionally runs the tests immediately and fixes failing tests via regeneration
 *
 * Usage: eztest generate --source ./src --url http://localhost:3000 --output ./tests/e2e
 */
import type { Command } from 'commander';
import { resolve } from 'path';
import { loadConfig } from '../../shared/config.js';
import { AiClient } from '../../shared/aiClient.js';
import { logInfo, logSuccess, logError, logWarning, enableVerboseLogging } from '../../shared/logger.js';
import { analyzeSourceDirectory } from '../../synthesizer/codeAnalyzer.js';
import { mapComponentAnalysesToUserFlows } from '../../synthesizer/flowMapper.js';
import {
  generateTestsForFlows,
  runAndFixGeneratedTests,
} from '../../synthesizer/testGenerator.js';
import { detectAndReadAppSpec, readAppSpecFromFile } from '../../synthesizer/appSpecReader.js';
import {
  readProjectFeedback,
  formatFeedbackForPrompt,
  recordSelectorFix,
} from '../../synthesizer/feedbackStore.js';
import { buildFeedbackContextSection } from '../../synthesizer/promptTemplates.js';

/** Maximum components to analyze per run — high enough for large codebases while still bounding API costs. */
const DEFAULT_MAX_COMPONENT_COUNT = 400;

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
      '--spec <file>',
      'Path to a plain-English app spec file (README.md, eztest-spec.md, etc.). ' +
      'Auto-detected from the source directory when not provided. ' +
      'This is the single biggest quality lever for behavioral test generation.',
    )
    .option(
      '--no-review',
      'Skip the behavioral assertion review pass (saves API calls but may let code-level assertions through)',
    )
    .option(
      '--run-and-fix',
      'After generating tests, immediately run them and attempt to fix any that fail by sending errors back to AI. ' +
      'Fixes selector mismatches; tests that still fail likely reveal real bugs and are left as red tests.',
    )
    .option(
      '--working-dir <path>',
      'Project root to run Playwright from during --run-and-fix (defaults to current directory)',
    )
    .option(
      '--audit',
      'Run a behavioral quality audit on all generated tests after generation (extra AI call). ' +
      'Flags tests that assert on implementation details instead of user-visible behavior.',
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
      spec?: string;
      review: boolean;
      runAndFix: boolean;
      workingDir?: string;
      audit: boolean;
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

      // ── Stage 1: Load app spec ──
      // The app spec is optional but dramatically improves test quality by giving
      // the AI the business intent of the application alongside the mechanical code.
      let appSpec: string | null = null;
      if (commandOptions.spec) {
        // User explicitly provided a spec file path
        const specResult = readAppSpecFromFile(commandOptions.spec);
        appSpec = specResult?.specContent ?? null;
      } else {
        // Auto-detect from the source directory and its parent (project root)
        appSpec = detectAndReadAppSpec(commandOptions.source);
        if (!appSpec) {
          logWarning(
            '  No app spec found. Create an eztest-spec.md in your project root to improve test quality.\n' +
            '  Example content: "This is a shopping cart app. Users can add items, update quantities,\n' +
            '  and complete checkout. The cart total must always reflect the current items."\n',
          );
        }
      }

      // ── Stage 1.5: Load project feedback (EZTest's memory for this codebase) ──
      // Reads eztest-feedback.json from the project root — selector fix history,
      // confirmed expectations, and false-positive flags from previous runs.
      // This is how EZTest improves over time without any manual configuration.
      const projectRootDirectory = resolve(commandOptions.source, '..');
      const projectFeedback = readProjectFeedback(projectRootDirectory)
                           ?? readProjectFeedback(process.cwd());
      const feedbackSummary = projectFeedback ? formatFeedbackForPrompt(projectFeedback) : '';
      const feedbackContext = buildFeedbackContextSection(feedbackSummary);
      if (projectFeedback && feedbackSummary) {
        const fixCount   = projectFeedback.selectorFixes.length;
        const learnCount = projectFeedback.confirmedExpectations.length;
        logInfo(`  Loaded project feedback: ${fixCount} selector fix${fixCount !== 1 ? 'es' : ''}, ${learnCount} confirmed expectation${learnCount !== 1 ? 's' : ''}`);
      }

      // ── Stage 2: Initialize AI client ──
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

      // ── Stage 3: Analyze source code ──
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

      // ── Stage 4: Map to user flows ──
      logInfo('\nMapping components to user flows...');
      let userFlows;
      try {
        userFlows = await mapComponentAnalysesToUserFlows(componentAnalyses, aiClient, {
          targetAppUrl: commandOptions.url,
          shouldAnalyzeIndividualComponents: commandOptions.deepAnalysis,
          appSpec: appSpec ?? undefined,
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
      if (commandOptions.review) {
        logInfo('  Behavioral assertion review pass: ENABLED');
      }

      let generationResult;
      try {
        generationResult = await generateTestsForFlows(flowsToGenerate, aiClient, {
          targetAppUrl: commandOptions.url,
          outputDirectory: commandOptions.output,
          shouldWriteFilesToDisk: !commandOptions.dryRun,
          appSpec: appSpec ?? undefined,
          feedbackContext: feedbackContext || undefined,
          shouldReviewAssertions: commandOptions.review,
          shouldAuditQuality: commandOptions.audit,
        });
      } catch (generationError) {
        logError('Test generation failed', generationError);
        process.exit(1);
      }

      // ── Stage 5 (optional): Run tests and fix failures ────────────────
      // When --run-and-fix is set and we actually wrote files, run the tests
      // immediately. Failing tests are sent back to AI for diagnosis and
      // regeneration. Tests that survive two regeneration attempts are left
      // as-is — they likely reveal real behavioral bugs, which is valuable.
      if (commandOptions.runAndFix && !commandOptions.dryRun && generationResult.generatedFiles.length > 0) {
        logInfo('\n── Run-and-Fix pass ──────────────────────────────────────────────');
        logInfo('Running generated tests and attempting to fix any selector failures...');

        let fixResult;
        try {
          fixResult = await runAndFixGeneratedTests(generationResult.generatedFiles, {
            targetAppUrl: commandOptions.url,
            outputDirectory: commandOptions.output,
            aiClient,
            appSpec: appSpec ?? undefined,
            workingDirectory: commandOptions.workingDir,
          });
        } catch (fixError) {
          logWarning(`Run-and-fix pass failed unexpectedly: ${String(fixError)}`);
          logWarning('Your generated tests are still on disk. Run them manually with: npx playwright test ' + commandOptions.output);
          fixResult = null;
        }

        if (fixResult) {
          console.log('');
          logInfo('── Run-and-Fix Summary ───────────────────────────────────────────');
          logSuccess(`  ✓ Passed on first run:  ${fixResult.passedOnFirstRunCount}`);
          if (fixResult.fixedByRegenerationCount > 0) {
            logSuccess(`  ✓ Fixed by regeneration: ${fixResult.fixedByRegenerationCount}`);
          }
          if (fixResult.stillFailingCount > 0) {
            const genuineBugCount = fixResult.fileOutcomes.filter(outcome => outcome.outcome === 'likely-genuine-bug').length;
            if (genuineBugCount > 0) {
              logWarning(`  ⚑ Likely reveals bugs:   ${genuineBugCount} (left as red tests — these are valuable!)`);
            }
            const truelyStillFailing = fixResult.stillFailingCount - genuineBugCount;
            if (truelyStillFailing > 0) {
              logWarning(`  ✗ Still failing:         ${truelyStillFailing} (check verbose output for details)`);
            }
          }

          // Persist selector fixes so future runs avoid the same brittle patterns
          for (const fixedOutcome of fixResult.fileOutcomes.filter(outcome => outcome.outcome === 'fixed')) {
            recordSelectorFix(projectRootDirectory, {
              originalSelector: `generated selector in ${fixedOutcome.fileName}`,
              fixedSelector:    'AI-regenerated (see file)',
              componentHint:    fixedOutcome.fileName.replace('.spec.ts', ''),
            });
          }
          if (fixResult.fixedByRegenerationCount > 0) {
            logInfo(`  💾 ${fixResult.fixedByRegenerationCount} selector fix${fixResult.fixedByRegenerationCount !== 1 ? 'es' : ''} recorded to eztest-feedback.json`);
          }
        }
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
      } else if (!commandOptions.runAndFix) {
        logInfo(`\nRun your tests with: npx playwright test ${commandOptions.output}`);
        logInfo(`Tip: Use --run-and-fix next time to automatically fix selector failures after generation.`);
      }
    });
}
