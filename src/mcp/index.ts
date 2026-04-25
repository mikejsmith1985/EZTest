/**
 * EZTest MCP server entry point.
 *
 * This is the binary that IDE clients (VS Code Copilot, Cursor, Claude Code, Windsurf)
 * launch as a subprocess when you configure EZTest as an MCP server. It reads and writes
 * JSON-RPC 2.0 messages over stdio — the MCP standard transport.
 *
 * Usage (automatically called by the IDE — users do not run this directly):
 *   npx eztest-mcp
 *   node dist/mcp/index.js
 *
 * For terminal use, prefer: eztest mcp
 */

// Load .env before any other import so every module sees the correct process.env values.
import 'dotenv/config';

import { startMcpServer } from './server.js';

startMcpServer().catch((startupError: unknown) => {
  process.stderr.write(
    `[EZTest MCP] Fatal startup error: ${startupError instanceof Error ? startupError.message : String(startupError)}\n`,
  );
  process.exit(1);
});
