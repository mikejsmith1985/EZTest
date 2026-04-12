/**
 * Integration tests for the Annotation Server.
 *
 * These tests start a REAL instance of the annotation server (not mocked) and verify
 * that the HTTP endpoints and Socket.io event pipeline work correctly end-to-end.
 * This is the layer of confidence between unit tests (isolated logic) and full
 * E2E tests (real browser + real app).
 */
import { test, expect } from '@playwright/test';
import { startAnnotationServer, SOCKET_EVENTS } from '../../src/recorder/annotationServer.js';
import type { AnnotationServerInstance, BugFlagAnnotation } from '../../src/recorder/annotationServer.js';

// Use a dedicated port to avoid collisions with the default 7432
const INTEGRATION_TEST_PORT = 7499;

// ── Lifecycle ──────────────────────────────────────────────────────────────

let annotationServer: AnnotationServerInstance;

test.beforeAll(async () => {
  annotationServer = await startAnnotationServer(INTEGRATION_TEST_PORT);
});

test.afterAll(async () => {
  await annotationServer.shutdown();
});

// ── Health Check ───────────────────────────────────────────────────────────

test('GET /health returns ok status', async () => {
  const response = await fetch(`http://127.0.0.1:${INTEGRATION_TEST_PORT}/health`);
  expect(response.status).toBe(200);

  const body = await response.json() as { status: string; service: string };
  expect(body.status).toBe('ok');
  expect(body.service).toBe('eztest-annotation-server');
});

// ── Bug Flag Endpoint ──────────────────────────────────────────────────────

test('POST /api/flag accepts a valid bug flag and returns 200', async () => {
  const bugFlagPayload: BugFlagAnnotation = {
    userExpectation: 'Clicking the increment button should increase the counter by 1',
    pageUrl: 'http://localhost:3000/counter',
    flaggedAt: new Date().toISOString(),
  };

  const response = await fetch(`http://127.0.0.1:${INTEGRATION_TEST_PORT}/api/flag`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(bugFlagPayload),
  });

  expect(response.status).toBe(200);

  const body = await response.json() as { status: string };
  expect(body.status).toBe('received');
});

test('POST /api/flag with missing userExpectation returns 400', async () => {
  const incompletePayload = {
    pageUrl: 'http://localhost:3000/counter',
    flaggedAt: new Date().toISOString(),
    // userExpectation intentionally omitted
  };

  const response = await fetch(`http://127.0.0.1:${INTEGRATION_TEST_PORT}/api/flag`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(incompletePayload),
  });

  expect(response.status).toBe(400);
});

test('POST /api/flag with missing pageUrl returns 400', async () => {
  const incompletePayload = {
    userExpectation: 'Counter should increment',
    flaggedAt: new Date().toISOString(),
    // pageUrl intentionally omitted
  };

  const response = await fetch(`http://127.0.0.1:${INTEGRATION_TEST_PORT}/api/flag`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(incompletePayload),
  });

  expect(response.status).toBe(400);
});

// ── Socket.io Event Pipeline ───────────────────────────────────────────────

test('POST /api/flag emits BUG_FLAGGED socket event to connected listeners', async () => {
  // We use the io client that socket.io ships with for server-side use
  const { io: connectSocketIoClient } = await import('socket.io-client');

  const socketClient = connectSocketIoClient(`http://127.0.0.1:${INTEGRATION_TEST_PORT}`);

  const receivedBugFlag = await new Promise<BugFlagAnnotation>((resolve, reject) => {
    const timeoutHandle = setTimeout(() => {
      socketClient.disconnect();
      reject(new Error('Timed out waiting for BUG_FLAGGED socket event'));
    }, 3000);

    socketClient.on(SOCKET_EVENTS.BUG_FLAGGED, (payload: BugFlagAnnotation) => {
      clearTimeout(timeoutHandle);
      socketClient.disconnect();
      resolve(payload);
    });

    socketClient.on('connect', () => {
      // POST the bug flag after the socket is connected so we don't miss the event
      fetch(`http://127.0.0.1:${INTEGRATION_TEST_PORT}/api/flag`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userExpectation: 'The submit button should show a confirmation message',
          pageUrl: 'http://localhost:3000/form',
          flaggedAt: new Date().toISOString(),
        }),
      }).catch(reject);
    });
  });

  expect(receivedBugFlag.userExpectation).toBe('The submit button should show a confirmation message');
  expect(receivedBugFlag.pageUrl).toBe('http://localhost:3000/form');
});

// ── Server Shutdown ────────────────────────────────────────────────────────

test('server shutdown resolves cleanly', async () => {
  // Start a second server on a different port to test shutdown in isolation
  const secondaryServer = await startAnnotationServer(INTEGRATION_TEST_PORT + 1);

  // Verify it's running first
  const healthResponse = await fetch(`http://127.0.0.1:${INTEGRATION_TEST_PORT + 1}/health`);
  expect(healthResponse.status).toBe(200);

  // Shutdown should resolve without throwing
  await expect(secondaryServer.shutdown()).resolves.toBeUndefined();

  // After shutdown, connections should be refused
  await expect(
    fetch(`http://127.0.0.1:${INTEGRATION_TEST_PORT + 1}/health`)
  ).rejects.toThrow();
});
