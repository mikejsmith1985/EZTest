/**
 * EZTest CLI entry point.
 *
 * Registers all subcommands and handles top-level CLI concerns like
 * version display, help text, and unhandled errors.
 *
 * Usage:
 *   eztest generate  — Analyze source code and generate Playwright tests
 *   eztest record    — Start a Smart Session Recording with annotation overlay
 *   eztest replay    — Run the autonomous reproduce → fix → validate loop from a bug report
 *   eztest ui        — Launch the browser-based wizard (no terminal knowledge required)
 */
import { Command } from 'commander';
import { registerGenerateCommand } from './commands/generate.js';
import { registerRecordCommand } from './commands/record.js';
import { registerReplayCommand } from './commands/replay.js';
import { registerUiCommand } from './commands/ui.js';

const EZTEST_VERSION = '0.1.0';

const cliProgram = new Command();

cliProgram
  .name('eztest')
  .description(
    'AI-powered behavioral testing companion.\n\n' +
    'Reads your code, understands user intent, and generates Playwright tests that ' +
    'validate real application behavior — not implementation details.'
  )
  .version(EZTEST_VERSION, '-V, --version', 'Output the EZTest version number');

// Register subcommands
registerGenerateCommand(cliProgram);
registerRecordCommand(cliProgram);
registerReplayCommand(cliProgram);
registerUiCommand(cliProgram);

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
