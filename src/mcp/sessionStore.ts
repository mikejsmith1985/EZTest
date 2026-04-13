/**
 * In-memory store for active MCP recording sessions.
 *
 * When an MCP client calls `start_recording`, a browser session is launched
 * asynchronously. This store tracks the state of each session so that a
 * subsequent `get_recording` call can check for completion and retrieve bug
 * reports — without blocking the MCP server while the browser is open.
 */
import { randomUUID } from 'node:crypto';
import type { BugReport } from '../shared/types.js';

// ── Session State ──────────────────────────────────────────────────────────

/** All possible lifecycle states for a recording session. */
export type RecordingSessionStatus = 'running' | 'completed' | 'error';

/**
 * Full state record for one recording session.
 * Created by `start_recording`, updated by the async recorder process,
 * and read by `get_recording`.
 */
export interface RecordingSessionState {
  sessionId: string;
  status: RecordingSessionStatus;
  /** URL the browser was opened to. */
  targetUrl: string;
  /** Directory where bug-report JSON files were saved. */
  outputDirectory: string;
  /** ISO timestamp when the session was started. */
  startedAt: string;
  /** Bug reports collected during the session (populated on completion). */
  bugReports: BugReport[];
  /** Human-readable error message (populated only when status === 'error'). */
  errorMessage?: string;
}

// ── Store Implementation ────────────────────────────────────────────────────

/** Module-level map — lives as long as the MCP server process. */
const sessionMap = new Map<string, RecordingSessionState>();

/**
 * Creates a new session entry in 'running' state and returns the full state object.
 * The caller is responsible for driving the recording process, then calling
 * `markSessionCompleted` or `markSessionFailed` when the browser closes.
 */
export function createRecordingSession(
  targetUrl: string,
  outputDirectory: string,
): RecordingSessionState {
  const sessionId = randomUUID();
  const session: RecordingSessionState = {
    sessionId,
    status: 'running',
    targetUrl,
    outputDirectory,
    startedAt: new Date().toISOString(),
    bugReports: [],
  };
  sessionMap.set(sessionId, session);
  return session;
}

/**
 * Returns the current state of a recording session, or null if the ID is unknown.
 */
export function getRecordingSession(sessionId: string): RecordingSessionState | null {
  return sessionMap.get(sessionId) ?? null;
}

/**
 * Marks a session as completed and stores the collected bug reports.
 */
export function markSessionCompleted(sessionId: string, bugReports: BugReport[]): void {
  const session = sessionMap.get(sessionId);
  if (!session) return;
  session.status = 'completed';
  session.bugReports = bugReports;
}

/**
 * Marks a session as failed and records the reason.
 */
export function markSessionFailed(sessionId: string, errorMessage: string): void {
  const session = sessionMap.get(sessionId);
  if (!session) return;
  session.status = 'error';
  session.errorMessage = errorMessage;
}
