/**
 * Annotation Server — the local Express server that powers the "Follow Me" annotation overlay.
 *
 * During a recording session, EZTest injects a floating annotation UI into the target
 * application. When the user clicks "Flag this", the overlay sends the annotation data
 * to THIS server via POST /api/flag. The server then emits the annotation to the session
 * recorder via Socket.io so the bug report can be finalized.
 *
 * Note: Click and input interactions are captured via Playwright's exposeFunction bridge
 * (interactionTracker.ts) — not via this server.
 *
 * Architecture: Browser Overlay ──POST /api/flag──> Annotation Server ──Socket.io──> Session Recorder
 */
import { createServer } from 'node:http';
import express from 'express';
import { Server as SocketIoServer } from 'socket.io';
import type { Server as HttpServer } from 'node:http';
import { logInfo, logDebug, logWarning } from '../shared/logger.js';

// ── Event Types ────────────────────────────────────────────────────────────

/** The data payload sent from the browser overlay when the user flags a bug. */
export interface BugFlagAnnotation {
  /** What the user typed as their description of expected behavior */
  userExpectation: string;
  /** The URL where the bug was flagged */
  pageUrl: string;
  /** ISO timestamp of when the flag was submitted */
  flaggedAt: string;
  /** Screenshot taken by the overlay at the moment of flagging (base64 PNG, optional) */
  screenshotData?: string;
}

/** Socket.io event names used for server-to-recorder communication. */
export const SOCKET_EVENTS = {
  /** Emitted when a user submits a bug flag annotation */
  BUG_FLAGGED: 'bug:flagged',
  /** Emitted when the user dismisses the overlay without submitting */
  OVERLAY_DISMISSED: 'overlay:dismissed',
  /** Emitted when the overlay connects (useful for health checks) */
  OVERLAY_CONNECTED: 'overlay:connected',
} as const;

// ── Server Setup ───────────────────────────────────────────────────────────

/**
 * The running annotation server instance.
 * Holds both the HTTP server and the Socket.io server for lifecycle management.
 */
export interface AnnotationServerInstance {
  httpServer: HttpServer;
  socketServer: SocketIoServer;
  /** Stops the server and cleans up all connections. */
  shutdown(): Promise<void>;
  /** Returns the URL of the annotation server for injection into the overlay. */
  serverUrl: string;
}

/**
 * Creates and starts the annotation server.
 *
 * The server:
 * 1. Accepts bug flag POSTs from the browser overlay at POST /api/flag
 * 2. Broadcasts those flags to connected Socket.io listeners (the session recorder)
 * 3. Serves the overlay script at GET /overlay.js so Playwright can inject it
 */
export async function startAnnotationServer(port: number): Promise<AnnotationServerInstance> {
  const expressApp = express();
  expressApp.use(express.json({ limit: '10mb' })); // Screenshots can be large

  const httpServer = createServer(expressApp);
  const socketServer = new SocketIoServer(httpServer, {
    cors: {
      // Allow connections from any origin since the overlay runs in the target app's origin
      origin: '*',
      methods: ['GET', 'POST'],
    },
  });

  // ── REST Endpoint: Receive bug flag from overlay ──
  expressApp.post('/api/flag', (request, response) => {
    const annotation = request.body as BugFlagAnnotation;

    if (!annotation.userExpectation || !annotation.pageUrl) {
      response.status(400).json({ error: 'Missing required fields: userExpectation, pageUrl' });
      return;
    }

    logDebug(`Bug flag received from ${annotation.pageUrl}: "${annotation.userExpectation}"`);

    // Broadcast to all connected session recorder listeners
    socketServer.emit(SOCKET_EVENTS.BUG_FLAGGED, annotation);
    response.json({ status: 'received', flaggedAt: annotation.flaggedAt });
  });

  // ── REST Endpoint: Health check ──
  expressApp.get('/health', (_request, response) => {
    response.json({ status: 'ok', service: 'eztest-annotation-server' });
  });

  // ── Socket.io: Track overlay connections for debugging ──
  socketServer.on('connection', (socket) => {
    logDebug(`Socket.io client connected: ${socket.id}`);
    socket.emit(SOCKET_EVENTS.OVERLAY_CONNECTED, { serverTime: new Date().toISOString() });

    socket.on('disconnect', () => {
      logDebug(`Socket.io client disconnected: ${socket.id}`);
    });
  });

  // ── Start listening ──
  await new Promise<void>((resolve, reject) => {
    httpServer.listen(port, '127.0.0.1', () => {
      logInfo(`Annotation server started on port ${port}`);
      resolve();
    });
    httpServer.on('error', reject);
  });

  const serverUrl = `http://127.0.0.1:${port}`;

  return {
    httpServer,
    socketServer,
    serverUrl,
    shutdown: async () => {
      logDebug('Shutting down annotation server...');
      socketServer.close();
      await new Promise<void>((resolve, reject) => {
        httpServer.close((closeError) => {
          if (closeError) reject(closeError);
          else resolve();
        });
      });
      logDebug('Annotation server stopped.');
    },
  };
}
