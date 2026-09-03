/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {createEvent, Session, VertexAiSessionService} from '@google/adk';
import {createAgentEngineSessions} from '@google/adk/utils/vertex_ai_utils.js';
import {
  ApiClient,
  Auth,
  NodeAuth,
  NodeDownloader,
  NodeUploader,
} from '@google/genai/vertex_internal';
import http from 'node:http';
import {AddressInfo} from 'node:net';
import {json} from 'node:stream/consumers';
import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';

const AGENT_ENGINE_ID = '12345';

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
 * scope: the client is wired with an API key so no credentials are needed.
 */
describe('VertexAiSessionService over the real Sessions HTTP client', () => {
  let server: http.Server;
  let service: VertexAiSessionService;

  beforeAll(async () => {
    server = http.createServer((_req, res) => {
      res.writeHead(404, {'Content-Type': 'application/json'});
      res.end(JSON.stringify({error: {code: 404, message: 'not found'}}));
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );

    const {port} = server.address() as AddressInfo;
    const apiClient = new ApiClient({
      auth: new NodeAuth({apiKey: 'not-a-real-key'}),
      uploader: new NodeUploader(),
      downloader: new NodeDownloader(),
      vertexai: true,
      apiKey: 'not-a-real-key',
      httpOptions: {baseUrl: `http://127.0.0.1:${port}`},
    });
    service = new VertexAiSessionService({
      agentEngineId: AGENT_ENGINE_ID,
      sessions: createAgentEngineSessions(apiClient),
    });
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it('resolves undefined when the backend reports the session is gone', async () => {
    const session = await service.getSession({
      appName: AGENT_ENGINE_ID,
      userId: 'testUser',
      sessionId: 'missing-session',
    });

    expect(session).toBeUndefined();
  });
});

/** A loopback server has no identity to assert, so requests go out unsigned. */
const unauthenticated: Auth = {
  async addAuthHeaders(): Promise<void> {},
};

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

    const apiClient = new ApiClient({
      auth: unauthenticated,
      uploader: new NodeUploader(),
      downloader: new NodeDownloader(),
      project: 'test-project',
      location: 'us-central1',
      vertexai: true,
      httpOptions: {
        baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      },
    });
    service = new VertexAiSessionService({
      agentEngineId: AGENT_ENGINE_ID,
      sessions: createAgentEngineSessions(apiClient),
    });
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

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

/**
 * Covers the two behaviours whose unit tests can only see the mock client: that
 * getSession follows a nextPageToken the server really sent, and that the real
 * client turns an HTTP 429 into an error the rate-limit guard recognizes.
 *
 * The unit tests build an `ApiError` by hand, so they pin its shape but not the
 * translation of the HTTP status into it.
 */
describe('VertexAiSessionService pagination and rate limits over the wire', () => {
  let server: http.Server;
  let service: VertexAiSessionService;
  let requestPaths: string[];
  let rateLimitOnce: boolean;

  const eventsPage = (invocationIds: string[], nextPageToken?: string) => ({
    sessionEvents: invocationIds.map((invocationId, index) => ({
      name: `reasoningEngines/${AGENT_ENGINE_ID}/sessions/session-1/events/e${index}`,
      author: 'user',
      invocationId,
      timestamp: '2026-01-01T00:00:00Z',
    })),
    ...(nextPageToken ? {nextPageToken} : {}),
  });

  beforeAll(async () => {
    server = http.createServer(async (request, response) => {
      const url = new URL(request.url!, 'http://127.0.0.1');
      requestPaths.push(`${request.method} ${request.url}`);

      if (url.pathname.endsWith(':appendEvent')) {
        await json(request);
        if (rateLimitOnce) {
          rateLimitOnce = false;
          response.writeHead(429, {'content-type': 'application/json'});
          response.end(
            JSON.stringify({
              error: {code: 429, message: 'quota exceeded', status: 'ABORTED'},
            }),
          );
          return;
        }
        response.writeHead(200, {'content-type': 'application/json'});
        response.end('{}');
        return;
      }

      response.writeHead(200, {'content-type': 'application/json'});
      if (url.pathname.endsWith('/events')) {
        response.end(
          JSON.stringify(
            url.searchParams.get('pageToken') === 'page-2'
              ? eventsPage(['invocation_2'])
              : eventsPage(['invocation_0', 'invocation_1'], 'page-2'),
          ),
        );
        return;
      }
      response.end(
        JSON.stringify({userId: 'user-1', updateTime: '2026-01-01T00:00:00Z'}),
      );
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );

    const apiClient = new ApiClient({
      auth: unauthenticated,
      uploader: new NodeUploader(),
      downloader: new NodeDownloader(),
      project: 'test-project',
      location: 'us-central1',
      vertexai: true,
      httpOptions: {
        baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      },
    });
    service = new VertexAiSessionService({
      agentEngineId: AGENT_ENGINE_ID,
      sessions: createAgentEngineSessions(apiClient),
    });
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  beforeEach(() => {
    requestPaths = [];
    rateLimitOnce = false;
  });

  it('follows the nextPageToken the server sent and returns both pages', async () => {
    const session = await service.getSession({
      appName: AGENT_ENGINE_ID,
      userId: 'user-1',
      sessionId: 'session-1',
    });

    expect(session?.events.map((event) => event.invocationId)).toEqual([
      'invocation_0',
      'invocation_1',
      'invocation_2',
    ]);
    expect(
      requestPaths.filter((path) => path.includes('pageToken=page-2')),
    ).toHaveLength(1);
  });

  it('retries the append after the server answers 429', async () => {
    rateLimitOnce = true;

    await service.appendEvent({
      session: await createLiveSession(service),
      event: createEvent({
        timestamp: 1620000000000,
        content: {role: 'user', parts: [{text: 'hello'}]},
      }),
    });

    expect(
      requestPaths.filter((path) => path.includes(':appendEvent')),
    ).toHaveLength(2);
  });
});

/** Loads session-1 from the loopback server so appendEvent has a real session. */
async function createLiveSession(
  service: VertexAiSessionService,
): Promise<Session> {
  const session = await service.getSession({
    appName: AGENT_ENGINE_ID,
    userId: 'user-1',
    sessionId: 'session-1',
  });
  if (!session) {
    expect.fail('the loopback server should have returned session-1');
  }
  return session;
}
