/**
 * UI Command — launches the EZTest wizard in the user's browser.
 * No terminal knowledge required — just run `eztest ui` and the browser opens.
 */
import { Command } from 'commander';
import { startUiServer } from '../../ui/uiServer.js';
import { logInfo, logSuccess } from '../../shared/logger.js';
import { spawn } from 'node:child_process';

/** Default port for the local wizard server. Chosen to avoid common conflicts. */
const DEFAULT_UI_PORT = 7433;

/**
 * Opens the given URL in the user's default browser using the platform-appropriate
 * system command (start on Windows, open on macOS, xdg-open on Linux).
 */
function openBrowser(url: string): void {
  const platform = process.platform;
  const command  = platform === 'win32' ? 'start' : platform === 'darwin' ? 'open' : 'xdg-open';
  spawn(command, [url], { shell: true, detached: true, stdio: 'ignore' }).unref();
}

/**
 * Registers the `ui` subcommand on the given Commander program instance.
 * Starts the wizard server, opens the browser, and keeps the process alive
 * until the user presses Ctrl+C.
 */
export function registerUiCommand(program: Command): void {
  program
    .command('ui')
    .description('Launch the EZTest wizard in your browser — no terminal commands needed')
    .option('-p, --port <number>', 'Port to run the UI server on', String(DEFAULT_UI_PORT))
    .action(async (options: { port: string }) => {
      const portNumber = parseInt(options.port, 10);
      const serverInstance = await startUiServer({ port: portNumber });

      logSuccess('EZTest wizard is ready!');
      logInfo('  → Opening browser at ' + serverInstance.serverUrl);
      logInfo('  → Press Ctrl+C to stop the wizard');
      logInfo('');

      openBrowser(serverInstance.serverUrl);

      // Block until the user signals shutdown with Ctrl+C
      await new Promise<void>((resolve) => {
        process.on('SIGINT', async () => {
          logInfo('\nShutting down EZTest wizard…');
          await serverInstance.shutdown();
          resolve();
        });
      });

      process.exit(0);
    });
}
