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
import { analyzeSourceDirectory, detectForgeAppContext } from '../../synthesizer/codeAnalyzer.js';
import { mapComponentAnalysesToUserFlows } from '../../synthesizer/flowMapper.js';
import {
  generateTestsForFlows,
  runAndFixGeneratedTests,
  fixSpecFilesFromDisk,
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
 * Maximum number of user flows to generate tests for in a single run.
 *
 * The GitHub Models free tier allows roughly 10 requests/minute. With the flow-mapping
 * batch calls plus one test-generation call per flow, a run capped at 10 flows completes
 * in under 3 minutes on the free tier. Users can increase this with --max-flows.
 */
const DEFAULT_MAX_FLOW_COUNT = 10;

/**
 * GitHub Models HIGH-tier models (gpt-4.1, gpt-4o) allow 50 requests per day.
 * When a single generation run's remaining API calls would exceed this threshold,
 * the assertion review pass is auto-disabled to avoid cascading through multiple
 * model quotas unnecessarily. Users can force-enable review with --review.
 */
const GITHUB_FREE_TIER_QUOTA_THRESHOLD = 45;

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Logs the run-and-fix summary in a consistent human-readable format.
 *
 * The summary distinguishes three categories so the developer understands what
 * actually happened — not just a raw pass/fail count:
 * 1. Tests that passed (no action needed)
 * 2. Tests fixed by selector regeneration (AI found the right locator)
 * 3. Tests that likely expose real application bugs (do NOT auto-fix these)
 */
function logRunAndFixSummary(
  fixResult: import('../../synthesizer/testGenerator.js').RunAndFixResult,
  providerNameForContext: string,
): void {
  console.log('');
  logInfo('── Run-and-Fix Summary ───────────────────────────────────────────');
  logSuccess(`  ✓ Passed on first run:  ${fixResult.passedOnFirstRunCount}`);

  if (fixResult.fixedByRegenerationCount > 0) {
    logSuccess(`  ✓ Fixed by regeneration: ${fixResult.fixedByRegenerationCount} (selector issue — AI updated the locator)`);
  }

  // Suspected code bugs: behavioral failures that should NOT be auto-fixed
  if (fixResult.suspectedCodeBugCount > 0) {
    logWarning(`\n  ⚠ Suspected application bugs: ${fixResult.suspectedCodeBugCount}`);
    logWarning(`  These tests failed with behavioral assertions (wrong URL, content, or state).`);
    logWarning(`  The tests were left unchanged — do NOT rewrite them to pass.`);
    logWarning(`  Review with your development team:\n`);
    for (const outcome of fixResult.fileOutcomes.filter(o => o.outcome === 'suspected-code-bug')) {
      logWarning(`    ⚑ ${outcome.fileName}`);
      if (outcome.suspectedBugDescription) {
        logWarning(`      → ${outcome.suspectedBugDescription}`);
      }
    }
  }

  if (fixResult.stillFailingCount > 0) {
    const genuineBugOutcomes = fixResult.fileOutcomes.filter(o => o.outcome === 'likely-genuine-bug');
    const truelyStillFailing = fixResult.stillFailingCount - genuineBugOutcomes.length;

    if (genuineBugOutcomes.length > 0) {
      logWarning(`\n  ⚑ Persistent failures (likely real bugs): ${genuineBugOutcomes.length}`);
      logWarning(`  AI could not fix these after multiple attempts. They probably expose broken features.`);
      logWarning(`  Left as red tests — they are valuable documentation of what doesn't work:\n`);
      for (const outcome of genuineBugOutcomes) {
        logWarning(`    ✗ ${outcome.fileName}`);
      }
    }

    if (truelyStillFailing > 0) {
      logWarning(`  ✗ Still failing (unclear reason): ${truelyStillFailing} (check verbose output)`);
    }
  }

  void providerNameForContext; // Used by caller for context, not needed in body
}

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
      '--max-flows <number>',
      'Maximum number of user flows to generate tests for (default: 10, increase for more coverage at the cost of API time)',
      String(DEFAULT_MAX_FLOW_COUNT),
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
      'Fixes selector mismatches; tests that reveal real behavioral bugs are left as red tests.',
    )
    .option(
      '--fix-only-files <paths>',
      'Comma-separated list of existing spec file paths to run and fix without re-generating. ' +
      'Skips all source analysis and test generation stages. ' +
      'Use this after a test run when you want to fix only the failing tests.',
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
      source?: string;
      url: string;
      output: string;
      edgeCases: boolean;
      maxComponents: string;
      maxFlows: string;
      deepAnalysis: boolean;
      spec?: string;
      review: boolean;
      runAndFix: boolean;
      fixOnlyFiles?: string;
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
      const maxFlowCount = parseInt(commandOptions.maxFlows, 10) || DEFAULT_MAX_FLOW_COUNT;

      // ── Fix-Only Mode: skip all generation stages ──────────────────────────
      // When --fix-only-files is set, the user wants to fix specific existing spec
      // files without re-running the full generate pipeline. Skip straight to the
      // run-and-classify-and-fix loop.
      if (commandOptions.fixOnlyFiles) {
        const absoluteSpecPaths = commandOptions.fixOnlyFiles
          .split(',')
          .map(specFilePath => resolve(specFilePath.trim()));

        logInfo(`Starting EZTest fix-only...`);
        logInfo(`  Target URL: ${commandOptions.url}`);
        logInfo(`  Files to fix: ${absoluteSpecPaths.length}`);

        const fixOnlyAiClient = new AiClient(ezTestConfig.ai);
        try {
          await fixOnlyAiClient.initialize();
          logInfo(`  AI: ${fixOnlyAiClient.providerName} / ${fixOnlyAiClient.modelName}`);
        } catch (initError) {
          logError('Failed to initialize AI client', initError);
          logError('Make sure an API key is set in your .env file.');
          process.exitCode = 1;
          return;
        }

        const fixOnlyWorkingDir = commandOptions.workingDir ?? process.cwd();
        const fixOnlyAppSpec = commandOptions.spec ? readAppSpecFromFile(commandOptions.spec)?.specContent ?? undefined : undefined;

        let fixResult;
        try {
          fixResult = await fixSpecFilesFromDisk(absoluteSpecPaths, {
            targetAppUrl: commandOptions.url,
            outputDirectory: commandOptions.output ?? fixOnlyWorkingDir,
            aiClient: fixOnlyAiClient,
            appSpec: fixOnlyAppSpec,
            workingDirectory: fixOnlyWorkingDir,
          });
        } catch (fixError) {
          logError('Fix-only pass failed', fixError);
          process.exitCode = 1;
          return;
        }

        logRunAndFixSummary(fixResult, fixOnlyAiClient.providerName);
        return;
      }

      // The source directory is required for full generation. --fix-only-files skips
      // this path entirely via the early return above, so this guard only trips if
      // the user runs `generate` without --source (misconfiguration, not normal flow).
      if (!commandOptions.source) {
        logError('Missing required option: --source <directory>');
        process.exitCode = 1;
        return;
      }

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
          'Make sure EZTEST_GITHUB_TOKEN, OPENAI_API_KEY, or ANTHROPIC_API_KEY is set in your .env file.'
        );
        // Set exitCode and return instead of process.exit(1) — calling process.exit() while
        // async HTTP SDK handles are still open causes a libuv assertion crash on Node.js 24.
        process.exitCode = 1;
        return;
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
        process.exitCode = 1;
        return;
      }

      if (componentAnalyses.length === 0) {
        logWarning(
          `No interactive components found in ${commandOptions.source}. ` +
          `Make sure the path is correct and the directory contains JSX/TSX files.`
        );
        return;
      }

      logSuccess(`Found ${componentAnalyses.length} components with interactive elements`);

      // Detect Jira Forge Custom UI apps — these render in an iframe and require
      // special navigation patterns (frameLocator + nav button clicks instead of page.goto).
      const forgeAppContext = detectForgeAppContext(commandOptions.source);
      if (forgeAppContext) {
        logInfo(`\n⚡ Jira Forge app detected — generating iframe-aware tests`);
        logInfo(`   Entry URL: ${forgeAppContext.forgeProjectPageUrl || '(not found — set in app-config.json)'}`);
      }

      // ── Stage 4: Map to user flows ──
      logInfo('\nMapping components to user flows...');
      let userFlows;
      try {
        userFlows = await mapComponentAnalysesToUserFlows(componentAnalyses, aiClient, {
          targetAppUrl: commandOptions.url,
          shouldAnalyzeIndividualComponents: commandOptions.deepAnalysis,
          appSpec: appSpec ?? undefined,
          forgeAppContext: forgeAppContext ?? undefined,
        });
      } catch (mappingError) {
        const errorMessage = mappingError instanceof Error ? mappingError.message : String(mappingError);
        const isQuotaExhausted =
          errorMessage.toLowerCase().includes('tokens_limit_reached') ||
          errorMessage.toLowerCase().includes('rate limit') ||
          errorMessage.toLowerCase().includes('too many requests');

        if (isQuotaExhausted) {
          logError(
            'AI API quota exhausted during flow mapping. Your GitHub Models free-tier daily limit has been reached.\n' +
            '  Options:\n' +
            '  1. Wait for your quota to reset (usually resets at midnight UTC)\n' +
            '  2. Use --no-review to halve API calls on the next run\n' +
            '  3. Set EZTEST_AI_PROVIDER=copilot in your .env (requires GitHub Copilot Pro — no daily quotas)\n' +
            '  4. Set OPENAI_API_KEY or ANTHROPIC_API_KEY in your .env for a paid provider',
          );
        } else {
          logError('User flow mapping failed', mappingError);
        }
        process.exitCode = 1;
        return;
      }

      if (userFlows.length === 0) {
        logWarning('No user flows were generated. The AI may have had trouble understanding the component structure.');
        return;
      }

      // Filter out edge cases if requested, then cap at maxFlowCount.
      // Capping is critical for GitHub Models free tier (10 req/min) — without it,
      // 30+ flows generates 30+ sequential API calls and takes 15+ minutes to complete.
      const filteredFlows = commandOptions.edgeCases
        ? userFlows
        : userFlows.filter(flow => flow.flowKind === 'happy-path');
      const flowsToGenerate = filteredFlows.slice(0, maxFlowCount);

      const wasFlowsCapped = filteredFlows.length > maxFlowCount;
      const flowCountNote = wasFlowsCapped
        ? ` (capped at ${maxFlowCount} — use --max-flows to increase)`
        : '';
      logSuccess(`Identified ${userFlows.length} user flows (generating tests for ${flowsToGenerate.length}${flowCountNote})`);

      // ── Quota-aware review optimization ──────────────────────────────────
      // On the GitHub Models free tier, HIGH-tier models allow ~50 requests/day.
      // If the assertion review pass would push total remaining API calls above
      // that threshold in a single run, auto-disable it so the user doesn't churn
      // through multiple model quotas unnecessarily. This only triggers when
      // --max-flows is set high enough to exceed the budget.
      let isReviewEnabled = commandOptions.review;
      if (isReviewEnabled && aiClient.hasFreeTierQuotaLimits) {
        const estimatedCallsWithReview = flowsToGenerate.length * 2;
        if (estimatedCallsWithReview > GITHUB_FREE_TIER_QUOTA_THRESHOLD) {
          isReviewEnabled = false;
          logWarning(
            `Auto-disabled assertion review: ${estimatedCallsWithReview} estimated API calls would exceed ` +
            `the GitHub Models free-tier quota (~${GITHUB_FREE_TIER_QUOTA_THRESHOLD} req/model/day). ` +
            `Saving ${flowsToGenerate.length} API calls. Pass --no-review to silence this warning.`,
          );
        }
      }

      // Log a pre-flight estimate so users on free tiers know what to expect.
      // This runs after flow capping and review decisions are final.
      const estimatedRemainingCalls = flowsToGenerate.length * (isReviewEnabled ? 2 : 1);
      logInfo(`\n  Estimated remaining API calls: ${estimatedRemainingCalls} ` +
        `(${flowsToGenerate.length} test gen${isReviewEnabled ? ` + ${flowsToGenerate.length} review` : ''})`);
      if (aiClient.hasFreeTierQuotaLimits) {
        logInfo(`  Provider: ${aiClient.providerName} / ${aiClient.modelName} ` +
          `(${aiClient.rotationSize} models in rotation — auto-rotates on quota exhaustion)`);
      }

      // ── Stage 4: Generate test files ──
      logInfo('\nGenerating Playwright test files...');
      if (isReviewEnabled) {
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
          shouldReviewAssertions: isReviewEnabled,
          shouldAuditQuality: commandOptions.audit,
          forgeAppContext: forgeAppContext ?? undefined,
          componentAnalyses,
        });
      } catch (generationError) {
        logError('Test generation failed', generationError);
        process.exitCode = 1;
        return;
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
          logRunAndFixSummary(fixResult, aiClient.providerName);

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
