/**
 * EZTest CLI entry point.
 *
 * Registers all subcommands and handles top-level CLI concerns like
 * version display, help text, and unhandled errors.
 *
 * Recommended first-run workflow:
 *   1. eztest init       — AI generates eztest-spec.md from your source code
 *   2. eztest interview  — AI asks questions; your answers become ground-truth expectations
 *   3. eztest plan       — Preview what tests will be written before committing
 *   4. eztest generate   — Write the Playwright tests (with run-and-fix loop)
 *   5. eztest feedback   — Flag false positives; EZTest learns from corrections over time
 *   6. eztest record     — Start a Smart Session Recording with annotation overlay
 *   7. eztest replay     — Run the autonomous reproduce → fix → validate loop from a bug report
 *   8. eztest ui         — Launch the browser-based wizard (no terminal knowledge required)
 */

// Load .env before any other import so every module sees the correct process.env values.
import 'dotenv/config';

import { Command } from 'commander';
import { registerInitCommand }      from './commands/init.js';
import { registerGenerateCommand }  from './commands/generate.js';
import { registerPlanCommand }      from './commands/plan.js';
import { registerInterviewCommand } from './commands/interview.js';
import { registerFeedbackCommand }  from './commands/feedback.js';
import { registerRecordCommand }    from './commands/record.js';
import { registerReplayCommand }    from './commands/replay.js';
import { registerUiCommand }        from './commands/ui.js';
import { registerMcpCommand }       from './commands/mcp.js';

const EZTEST_VERSION = '0.1.4';

const cliProgram = new Command();

cliProgram
  .name('eztest')
  .description(
    'AI-powered behavioral testing companion.\n\n' +
    'Reads your code, understands user intent, and generates Playwright tests that ' +
    'validate real application behavior — not implementation details.'
  )
  .version(EZTEST_VERSION, '-V, --version', 'Output the EZTest version number');

// Register subcommands — order matches recommended first-run workflow
registerInitCommand(cliProgram);
registerGenerateCommand(cliProgram);
registerPlanCommand(cliProgram);
registerInterviewCommand(cliProgram);
registerFeedbackCommand(cliProgram);
registerRecordCommand(cliProgram);
registerReplayCommand(cliProgram);
registerUiCommand(cliProgram);
registerMcpCommand(cliProgram);

// Handle unrecognized commands gracefully
cliProgram.on('command:*', () => {
  console.error(`Unknown command: ${cliProgram.args.join(' ')}`);
  console.error('Run `eztest --help` to see available commands.');
  process.exit(1);
});

// Handle unhandled rejections globally — surface them clearly instead of crashing silently
process.on('unhandledRejection', (reason) => {
  console.error('[EZTest] Fatal unhandled error:', reason);
  process.exit(1);
});

cliProgram.parse(process.argv);

// Show help if no command was provided
if (process.argv.length <= 2) {
  cliProgram.help();
}
