/**
 * The `eztest mcp` command.
 *
 * Starts the EZTest MCP server over stdio, making all EZTest capabilities available
 * as MCP tools to any compatible IDE (VS Code Copilot, Cursor, Claude Code, Windsurf).
 *
 * This command is intended to be launched by IDE MCP client configuration, not run
 * manually in a terminal. If you need to test the server interactively, use the
 * `npx eztest-mcp` binary instead and send JSON-RPC messages manually.
 *
 * IDE Configuration Examples:
 *
 *   VS Code (.vscode/mcp.json):
 *     { "servers": { "eztest": { "type": "stdio", "command": "npx", "args": ["eztest-mcp"] } } }
 *
 *   Cursor / Windsurf (mcp.json):
 *     { "mcpServers": { "eztest": { "command": "npx", "args": ["eztest-mcp"] } } }
 *
 *   Claude Code:
 *     claude mcp add eztest -- npx eztest-mcp
 */
import type { Command } from 'commander';
import { startMcpServer } from '../../mcp/server.js';

/**
 * Registers the `mcp` subcommand on the given Commander program instance.
 */
export function registerMcpCommand(program: Command): void {
  program
    .command('mcp')
    .description(
      'Start the EZTest MCP server over stdio.\n\n' +
      'Exposes analyze_source, generate_tests, start_recording, get_recording,\n' +
      'reproduce_bug, and fix_and_validate as MCP tools to IDE AI agents.\n\n' +
      'Typically launched automatically by IDE MCP configuration — see README for setup.',
    )
    .action(async () => {
      // startMcpServer redirects all stdout logging to stderr internally before connecting.
      await startMcpServer();
    });
}
