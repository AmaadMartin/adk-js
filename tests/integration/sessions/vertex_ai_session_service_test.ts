/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Client} from '@google-cloud/vertexai';
import {VertexAiSessionService} from '@google/adk';
import fs from 'node:fs';
import http from 'node:http';
import type {AddressInfo} from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {json} from 'node:stream/consumers';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

const AGENT_ENGINE_ID = '12345';
const PROJECT = 'test-project';
const LOCATION = 'us-central1';

/**
 * Answers an Application Default Credentials metadata lookup with a fake token.
 *
 * Returns true when the request was a metadata lookup and the response is now
 * complete, so the caller returns instead of running its own handler.
 */
function serveMetadataToken(
  request: http.IncomingMessage,
  response: http.ServerResponse,
): boolean {
  if (!request.url?.startsWith('/computeMetadata/')) return false;
  response.writeHead(200, {
    'content-type': 'application/json',
    'metadata-flavor': 'Google',
  });
  response.end(
    request.url.includes('/token')
      ? JSON.stringify({
          access_token: 'not-a-real-token',
          expires_in: 3600,
          token_type: 'Bearer',
        })
      : JSON.stringify({}),
  );
  return true;
}

/**
 * Points Application Default Credentials at the loopback server on `port`.
 *
 * `GoogleAuth` resolves credentials in the order
 * `GOOGLE_APPLICATION_CREDENTIALS`, gcloud well-known file, GCE metadata.
 * Clearing the first two forces the third on every machine, so a developer who
 * is logged in with gcloud takes the same code path as CI instead of fetching a
 * live token. `CLOUDSDK_CONFIG` relocates the well-known file on Linux, macOS
 * and Windows, so one variable covers the whole matrix.
 */
function pointAdcAt(port: number): void {
  vi.stubEnv('GCE_METADATA_HOST', `127.0.0.1:${port}`);
  vi.stubEnv('GOOGLE_APPLICATION_CREDENTIALS', undefined);
  vi.stubEnv(
    'CLOUDSDK_CONFIG',
    fs.mkdtempSync(path.join(os.tmpdir(), 'adk-no-adc-')),
  );
}

/**
 * Exercises `getSession`'s NOT_FOUND handling against an error the SDK builds
 * itself: a loopback HTTP server answers 404 in place of the Agent Engine
 * Sessions API, and the response travels back through the real
 * `@google-cloud/vertexai` Sessions client and the real `@google/genai`
 * `ApiClient`.
 *
 * The unit tests construct an `ApiError` directly, so they pin its shape but
 * not the translation of an HTTP response into it -- and misreading that
 * translation is what caused the bug this covers. Authentication is out of
 * scope: the same loopback server answers the Application Default Credentials
 * metadata lookup, so no real credentials are needed.
 */
describe('VertexAiSessionService over the real Sessions HTTP client', () => {
  let server: http.Server;
  let service: VertexAiSessionService;
  const requested: string[] = [];

  beforeAll(async () => {
    server = http.createServer((request, response) => {
      if (serveMetadataToken(request, response)) return;
      requested.push(request.url!);
      response.writeHead(404, {'Content-Type': 'application/json'});
      response.end(JSON.stringify({error: {code: 404, message: 'not found'}}));
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );

    const {port} = server.address() as AddressInfo;
    pointAdcAt(port);
    const client = new Client({
      project: PROJECT,
      location: LOCATION,
      apiEndpoint: `http://127.0.0.1:${port}`,
    });
    service = new VertexAiSessionService({
      agentEngineId: AGENT_ENGINE_ID,
      sessions: client.agentEnginesInternal.sessions,
    });
  });

  afterAll(() => {
    vi.unstubAllEnvs();
    return new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('resolves undefined when the backend reports the session is gone', async () => {
    const session = await service.getSession({
      appName: AGENT_ENGINE_ID,
      userId: 'testUser',
      sessionId: 'missing-session',
    });

    expect(session).toBeUndefined();
    // An auth failure also reports 404, which getSession maps to undefined, so
    // this pins that the request reached the Sessions endpoint. getSession
    // lists events concurrently, and that second request races the 404 here.
    expect(requested).toContain(
      `/v1beta1/projects/${PROJECT}/locations/${LOCATION}/reasoningEngines/${AGENT_ENGINE_ID}/sessions/missing-session`,
    );
  });
});

/**
 * Drives createSession through the real Agent Engine Sessions client against a
 * loopback server. The unit tests can only assert the config object handed to
 * the SDK; these assert the request body the SDK actually produces from it, so
 * they fail if an SDK upgrade stops serializing either field.
 */
describe('VertexAiSessionService session expiration over the wire', () => {
  let server: http.Server;
  let service: VertexAiSessionService;
  let bodies: unknown[];

  beforeAll(async () => {
    server = http.createServer(async (request, response) => {
      if (serveMetadataToken(request, response)) return;
      bodies.push(await json(request));
      response.writeHead(200, {'content-type': 'application/json'});
      response.end(
        JSON.stringify({
          name: 'operations/1',
          done: true,
          response: {
            name: `reasoningEngines/${AGENT_ENGINE_ID}/sessions/session-1`,
            updateTime: '2026-01-01T00:00:00Z',
          },
        }),
      );
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );

    const {port} = server.address() as AddressInfo;
    pointAdcAt(port);
    const client = new Client({
      project: PROJECT,
      location: LOCATION,
      apiEndpoint: `http://127.0.0.1:${port}`,
    });
    service = new VertexAiSessionService({
      agentEngineId: AGENT_ENGINE_ID,
      sessions: client.agentEnginesInternal.sessions,
    });
  });

  afterAll(() => {
    vi.unstubAllEnvs();
    return new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    bodies = [];
  });

  it('sends ttl in the create request body', async () => {
    const session = await service.createSession({
      appName: AGENT_ENGINE_ID,
      userId: 'user-1',
      ttl: '7200s',
    });

    expect(session.id).toBe('session-1');
    expect(bodies).toEqual([{userId: 'user-1', ttl: '7200s'}]);
  });

  it('sends expireTime in the create request body', async () => {
    await service.createSession({
      appName: AGENT_ENGINE_ID,
      userId: 'user-1',
      expireTime: '2026-10-01T00:00:00Z',
    });

    expect(bodies).toEqual([
      {userId: 'user-1', expireTime: '2026-10-01T00:00:00Z'},
    ]);
  });
});
