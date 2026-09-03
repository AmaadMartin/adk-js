/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {createEvent, VertexAiSessionService} from '@google/adk';
import {createSession} from '@google/adk/sessions/session.js';
import {createAgentEngineSessions} from '@google/adk/utils/vertex_ai_utils.js';
import {HttpOptions} from '@google/genai';
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
 * A subclass that points every request at extra HTTP options, so the test can
 * read them off the request the SDK sends.
 */
class TracedSessionService extends VertexAiSessionService {
  protected override apiClientHttpOptionsOverride(): HttpOptions {
    return {headers: {'x-adk-test': 'traced'}};
  }
}

/** One request the loopback server answered. */
interface RecordedRequest {
  url: string;
  headers: http.IncomingHttpHeaders;
  body: unknown;
}

/**
 * Drives the parity behaviours through the real Agent Engine Sessions client
 * against a loopback server: the rate-limit retry sees an error the SDK built
 * from a real 429 response, and pagination follows a real `nextPageToken`.
 * Nothing here is mocked below the service, and no credentials are needed.
 */
describe('VertexAiSessionService parity behaviour over the wire', () => {
  let server: http.Server;
  let requests: RecordedRequest[];
  let respond: (url: string, response: http.ServerResponse) => void;
  let port: number;

  beforeAll(async () => {
    server = http.createServer(async (request, response) => {
      requests.push({
        url: request.url ?? '',
        headers: request.headers,
        body: request.method === 'GET' ? undefined : await json(request),
      });
      respond(request.url ?? '', response);
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    port = (server.address() as AddressInfo).port;
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  beforeEach(() => {
    requests = [];
  });

  function sendJson(
    response: http.ServerResponse,
    body: unknown,
    status = 200,
  ) {
    response.writeHead(status, {'content-type': 'application/json'});
    response.end(JSON.stringify(body));
  }

  function buildService(
    Service: typeof VertexAiSessionService = VertexAiSessionService,
  ): VertexAiSessionService {
    const apiClient = new ApiClient({
      auth: unauthenticated,
      uploader: new NodeUploader(),
      downloader: new NodeDownloader(),
      project: 'test-project',
      location: 'us-central1',
      vertexai: true,
      httpOptions: {baseUrl: `http://127.0.0.1:${port}`},
    });
    return new Service({
      agentEngineId: AGENT_ENGINE_ID,
      sessions: createAgentEngineSessions(apiClient),
    });
  }

  it('retries an append the backend rate limits', async () => {
    let appends = 0;
    respond = (_url, response) => {
      appends++;
      if (appends === 1) {
        sendJson(
          response,
          {error: {code: 429, message: 'Resource exhausted'}},
          429,
        );
        return;
      }
      sendJson(response, {});
    };
    const service = buildService();
    const session = createSession({
      id: 'retry-session',
      appName: AGENT_ENGINE_ID,
      userId: 'user-1',
    });
    const event = createEvent({
      author: 'user',
      invocationId: 'inv-1',
      timestamp: 1767225600000,
      content: {role: 'user', parts: [{text: 'hello'}]},
    });

    await service.appendEvent({session, event});

    expect(appends).toBe(2);
  });

  it('gives up after one retry when the backend keeps rate limiting', async () => {
    let appends = 0;
    respond = (_url, response) => {
      appends++;
      sendJson(
        response,
        {error: {code: 429, message: 'Resource exhausted'}},
        429,
      );
    };
    const service = buildService();
    const session = createSession({
      id: 'retry-session',
      appName: AGENT_ENGINE_ID,
      userId: 'user-1',
    });
    const event = createEvent({
      author: 'user',
      invocationId: 'inv-2',
      timestamp: 1767225600000,
      content: {role: 'user', parts: [{text: 'hello'}]},
    });

    await expect(service.appendEvent({session, event})).rejects.toThrow(
      'Resource exhausted',
    );

    expect(appends).toBe(2);
  });

  it('reads every page of events the backend returns', async () => {
    respond = (url, response) => {
      if (!url.includes('/events')) {
        sendJson(response, {
          userId: 'user-1',
          sessionState: {},
          updateTime: '2026-01-01T00:00:00Z',
        });
        return;
      }
      if (url.includes('pageToken=page-2')) {
        sendJson(response, {
          sessionEvents: [
            {name: 'events/e3', invocationId: 'inv-3', author: 'user'},
          ],
        });
        return;
      }
      sendJson(response, {
        sessionEvents: [
          {name: 'events/e1', invocationId: 'inv-1', author: 'user'},
          {name: 'events/e2', invocationId: 'inv-2', author: 'user'},
        ],
        nextPageToken: 'page-2',
      });
    };
    const service = buildService();

    const session = await service.getSession({
      appName: AGENT_ENGINE_ID,
      userId: 'user-1',
      sessionId: 'paged-session',
    });

    expect(session?.events.map((event) => event.id)).toEqual([
      'e1',
      'e2',
      'e3',
    ]);
    expect(
      requests.filter((request) => request.url.includes('pageToken=page-2')),
    ).toHaveLength(1);
  });

  it('sends passthrough create config in the request body', async () => {
    respond = (_url, response) =>
      sendJson(response, {
        name: 'operations/1',
        done: true,
        response: {
          name: `reasoningEngines/${AGENT_ENGINE_ID}/sessions/session-1`,
          updateTime: '2026-01-01T00:00:00Z',
        },
      });
    const service = buildService();

    await service.createSession({
      appName: AGENT_ENGINE_ID,
      userId: 'user-1',
      config: {displayName: 'triage', labels: {team: 'support'}},
    });

    expect(requests[0].body).toEqual({
      userId: 'user-1',
      displayName: 'triage',
      labels: {team: 'support'},
    });
  });

  it('sends the overridden http header on the requests it issues', async () => {
    respond = (_url, response) =>
      sendJson(response, {
        name: 'operations/1',
        done: true,
        response: {
          name: `reasoningEngines/${AGENT_ENGINE_ID}/sessions/session-1`,
          updateTime: '2026-01-01T00:00:00Z',
        },
      });
    const service = buildService(TracedSessionService);

    await service.createSession({appName: AGENT_ENGINE_ID, userId: 'user-1'});

    expect(requests[0].headers['x-adk-test']).toBe('traced');
  });
});
