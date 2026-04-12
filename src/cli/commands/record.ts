/**
 * The `eztest record` command.
 *
 * Starts an EZTest Smart Session Recording session — opens a browser with the
 * annotation overlay injected and records all user interactions. When the user
 * flags an unexpected result, the bug report is assembled and sent to the
 * Forge Terminal agent for autonomous test generation and code fixing.
 *
 * Usage: eztest record --url http://localhost:3000 --source ./src
 */
import type { Command } from 'commander';
import { loadConfig } from '../../shared/config.js';
import { logInfo, logError, enableVerboseLogging } from '../../shared/logger.js';
import { startRecordingSession } from '../../recorder/sessionRecorder.js';
import { sendBugReportToForgeAgent } from '../../agentLoop/forgeIntegration.js';

/** Default directory for saving bug report JSON files. */
const DEFAULT_BUG_REPORT_OUTPUT_DIRECTORY = '.eztest/bug-reports';

/**
 * Registers the `record` subcommand on the given Commander program instance.
 */
export function registerRecordCommand(program: Command): void {
  program
    .command('record')
    .description(
      'Start a Smart Session Recording — use your application normally and flag unexpected ' +
      'results with the overlay UI. Bug reports are automatically sent to your Forge Terminal agent.'
    )
    .option(
      '-u, --url <url>',
      'URL of the application to record',
      'http://localhost:3000',
    )
    .option(
      '-s, --source <directory>',
      'Source code directory (helps the agent find the code to fix)',
      './src',
    )
    .option(
      '-o, --output <directory>',
      'Directory to save bug report files',
      DEFAULT_BUG_REPORT_OUTPUT_DIRECTORY,
    )
    .option(
      '--no-forge',
      'Save bug reports to disk but do not send to Forge Terminal agent',
    )
    .option(
      '-v, --verbose',
      'Enable verbose debug logging',
    )
    .action(async (commandOptions: {
      url: string;
      source: string;
      output: string;
      forge: boolean;
      verbose: boolean;
    }) => {
      if (commandOptions.verbose) {
        enableVerboseLogging();
      }

      const ezTestConfig = loadConfig();

      logInfo('Starting EZTest Smart Session Recorder...');
      logInfo(`  Target: ${commandOptions.url}`);
      logInfo(`  Source: ${commandOptions.source}`);
      logInfo(`  Reports: ${commandOptions.output}`);

      let collectedBugReports;
      try {
        collectedBugReports = await startRecordingSession({
          targetUrl: commandOptions.url,
          annotationServerPort: ezTestConfig.annotationServerPort,
          bugReportOutputDirectory: commandOptions.output,
          shouldShowBrowser: true,
        });
      } catch (sessionError) {
        logError('Recording session failed', sessionError);
        process.exit(1);
      }

      // Send all collected bug reports to the Forge Terminal agent
      if (commandOptions.forge && collectedBugReports.length > 0) {
        logInfo(`\nSending ${collectedBugReports.length} bug report(s) to Forge Terminal agent...`);

        for (const bugReport of collectedBugReports) {
          bugReport.sourceDirectory = commandOptions.source;

          try {
            await sendBugReportToForgeAgent(bugReport, {
              webhookUrl: ezTestConfig.forgeTerminalWebhookUrl,
              projectWorkingDirectory: process.cwd(),
              sourceDirectory: commandOptions.source,
            });
          } catch (integrationError) {
            logError(`Failed to send bug report ${bugReport.reportId}`, integrationError);
          }
        }
      } else if (collectedBugReports.length === 0) {
        logInfo('\nNo bugs were flagged during this session.');
      }
    });
}
