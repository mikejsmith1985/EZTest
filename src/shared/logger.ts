/**
 * Structured logger for EZTest.
 * Keeps output clean during normal operation and expands with detail when verbose
 * mode is enabled. All modules use these functions instead of calling console directly.
 */

/** Whether verbose/debug logging is currently enabled. Set once at startup. */
let isVerboseMode = false;

/**
 * When true, all log output is written to stderr instead of stdout.
 * Must be enabled before starting the MCP stdio server so log lines never
 * corrupt the JSON-RPC message stream on stdout.
 */
let isStderrMode = false;

/**
 * Redirects all logger output to stderr.
 * Call this once at the top of the MCP server entry point, before any other
 * module writes to stdout.
 */
export function redirectLoggingToStderr(): void {
  isStderrMode = true;
}

/** Writes a message to the appropriate output stream. */
function writeLog(message: string): void {
  if (isStderrMode) {
    process.stderr.write(message + '\n');
  } else {
    console.log(message);
  }
}

/**
 * Enables verbose debug logging for this process.
 * Typically called once when the --verbose CLI flag is passed.
 */
export function enableVerboseLogging(): void {
  isVerboseMode = true;
}

/** Returns true if verbose logging is currently enabled. */
export function isVerboseLoggingEnabled(): boolean {
  return isVerboseMode;
}

/**
 * Logs an informational message to stdout.
 * Always shown regardless of verbose mode.
 */
export function logInfo(message: string): void {
  writeLog(`[EZTest] ${message}`);
}

/**
 * Logs a success message to stdout.
 * Always shown regardless of verbose mode.
 */
export function logSuccess(message: string): void {
  writeLog(`[EZTest] ✓ ${message}`);
}

/**
 * Logs a warning to stderr.
 * Always shown regardless of verbose mode.
 */
export function logWarning(message: string): void {
  process.stderr.write(`[EZTest] ⚠ ${message}\n`);
}

/**
 * Logs an error to stderr.
 * Always shown regardless of verbose mode.
 */
export function logError(message: string, error?: unknown): void {
  process.stderr.write(`[EZTest] ✗ ${message}\n`);
  if (error && isVerboseMode) {
    process.stderr.write(String(error) + '\n');
  }
}

/**
 * Logs a debug message to stdout.
 * Only shown when verbose mode is enabled — use freely without worrying about noise.
 */
export function logDebug(message: string): void {
  if (isVerboseMode) {
    writeLog(`[EZTest:debug] ${message}`);
  }
}
