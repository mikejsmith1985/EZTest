/**
 * Structured logger for EZTest.
 * Keeps output clean during normal operation and expands with detail when verbose
 * mode is enabled. All modules use these functions instead of calling console directly.
 */

/** Whether verbose/debug logging is currently enabled. Set once at startup. */
let isVerboseMode = false;

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
  console.log(`[EZTest] ${message}`);
}

/**
 * Logs a success message to stdout.
 * Always shown regardless of verbose mode.
 */
export function logSuccess(message: string): void {
  console.log(`[EZTest] ✓ ${message}`);
}

/**
 * Logs a warning to stderr.
 * Always shown regardless of verbose mode.
 */
export function logWarning(message: string): void {
  console.warn(`[EZTest] ⚠ ${message}`);
}

/**
 * Logs an error to stderr.
 * Always shown regardless of verbose mode.
 */
export function logError(message: string, error?: unknown): void {
  console.error(`[EZTest] ✗ ${message}`);
  if (error && isVerboseMode) {
    console.error(error);
  }
}

/**
 * Logs a debug message to stdout.
 * Only shown when verbose mode is enabled — use freely without worrying about noise.
 */
export function logDebug(message: string): void {
  if (isVerboseMode) {
    console.log(`[EZTest:debug] ${message}`);
  }
}
