/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Sessions} from '@google-cloud/vertexai/build/src/genai/sessions.js';
import {createEvent, createSession, VertexAiSessionService} from '@google/adk';
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
 * Builds the Agent Engine `Sessions` client from an `ApiClient`.
 *
 * `@google-cloud/vertexai` bundles its own nested copy of `@google/genai`
 * (1.52.0) while the repo root resolves `@google/genai` to 2.9.0, so the
 * `ApiClient` this test constructs is a structurally distinct class (its
 * private fields make the two nominally incompatible) from the one `Sessions`
 * declares. The instances are interchangeable at runtime -- the mismatch is a
 * duplicate-dependency artifact, not a real API difference -- so the cast is
 * confined to this one boundary.
 */
function createSessionsClient(apiClient: ApiClient): Sessions {
  return new Sessions(
    apiClient as unknown as ConstructorParameters<typeof Sessions>[0],
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
      sessions: createSessionsClient(apiClient),
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
 * Drives getSession's session-id handling through the real Sessions client
 * against a loopback server. The unit tests assert the name handed to a mock
 * client; these assert the URL the SDK builds from it, so they fail if the id
 * is normalized too late to reach the request path.
 */
describe('VertexAiSessionService session ids over the wire', () => {
  let server: http.Server;
  let service: VertexAiSessionService;
  let paths: string[];

  beforeAll(async () => {
    server = http.createServer((request, response) => {
      paths.push(request.url ?? '');
      response.writeHead(200, {'content-type': 'application/json'});
      response.end(
        JSON.stringify({
          name: `reasoningEngines/${AGENT_ENGINE_ID}/sessions/session-123`,
          userId: 'user-1',
          updateTime: '2026-01-01T00:00:00Z',
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
      sessions: createSessionsClient(apiClient),
    });
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  beforeEach(() => {
    paths = [];
  });

  it('requests the short id when given a full resource name', async () => {
    const session = await service.getSession({
      appName: AGENT_ENGINE_ID,
      userId: 'user-1',
      sessionId:
        `projects/test-project/locations/us-central1/reasoningEngines/` +
        `${AGENT_ENGINE_ID}/sessions/session-123`,
      config: {numRecentEvents: 0},
    });

    expect(paths).toHaveLength(1);
    expect(paths[0]).toContain(
      `reasoningEngines/${AGENT_ENGINE_ID}/sessions/session-123`,
    );
    expect(session?.id).toBe('session-123');
  });

  it('sends no request for a session id that escapes the path', async () => {
    await expect(
      service.getSession({
        appName: AGENT_ENGINE_ID,
        userId: 'user-1',
        sessionId: '../../sandboxes/other',
      }),
    ).rejects.toThrow(/Invalid session_id/);

    expect(paths).toEqual([]);
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
      sessions: createSessionsClient(apiClient),
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
 * Drives the append retry against an error the SDK builds from a real 429
 * response. The unit tests construct that error directly, so they pin its
 * shape but not the translation of an HTTP status into it -- and misreading
 * that translation is the class of bug the NOT_FOUND test above was written
 * for.
 */
describe('VertexAiSessionService append retry over the wire', () => {
  let server: http.Server;
  let service: VertexAiSessionService;
  let requestCount: number;

  beforeAll(async () => {
    server = http.createServer((_request, response) => {
      requestCount += 1;
      if (requestCount === 1) {
        response.writeHead(429, {'content-type': 'application/json'});
        response.end(
          JSON.stringify({error: {code: 429, message: 'Resource exhausted'}}),
        );
        return;
      }
      response.writeHead(200, {'content-type': 'application/json'});
      response.end('{}');
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
      sessions: createSessionsClient(apiClient),
    });
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  beforeEach(() => {
    requestCount = 0;
  });

  it('appends the event after the backend answers 429 once', async () => {
    const session = createSession({
      id: 'session-1',
      appName: AGENT_ENGINE_ID,
      userId: 'user-1',
      events: [],
      lastUpdateTime: 0,
    });
    const event = createEvent({
      author: 'user',
      invocationId: 'inv-retry',
      timestamp: 1734005533000,
      content: {role: 'user', parts: [{text: 'hello'}]},
    });

    await expect(service.appendEvent({session, event})).resolves.toBe(event);

    expect(requestCount).toBe(2);
  });
});
