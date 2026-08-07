/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Sessions} from '@google-cloud/vertexai/build/src/genai/sessions.js';
import {
  createEvent,
  createEventActions,
  createSession,
  EventActions,
  ToolConfirmation,
  VertexAiSessionService,
} from '@google/adk';
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
      sessions: new Sessions(apiClient),
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
      sessions: new Sessions(apiClient),
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
 * Drives an event through appendEvent and back out of getSession against a
 * loopback server that serves the appended event with `rawEvent` stripped, so
 * the read goes through the legacy field-based channel.
 *
 * A mock-object unit test writes and reads the same key, so it cannot catch a
 * wire name the API does not use; these assert the request body the real
 * client produces and the actions parsed from the response it receives.
 */
describe('VertexAiSessionService event actions over the wire', () => {
  const SESSION_NAME = `reasoningEngines/${AGENT_ENGINE_ID}/sessions/session-1`;
  let server: http.Server;
  let service: VertexAiSessionService;
  let appended: Record<string, unknown> | undefined;

  /** The appended event as the API serves it back, minus `rawEvent`. */
  function storedEvents(): Array<Record<string, unknown>> {
    if (!appended) {
      return [];
    }
    const event: Record<string, unknown> = {
      ...appended,
      name: `${SESSION_NAME}/events/e1`,
    };
    delete event['rawEvent'];
    return [event];
  }

  beforeAll(async () => {
    server = http.createServer(async (request, response) => {
      const url = request.url ?? '';
      let body: unknown;
      if (url.includes('appendEvent')) {
        appended = (await json(request)) as Record<string, unknown>;
        body = {};
      } else if (url.includes('/events')) {
        body = {sessionEvents: storedEvents()};
      } else {
        body = {
          name: SESSION_NAME,
          userId: 'user-1',
          sessionState: {},
          updateTime: '2026-01-01T00:00:00Z',
        };
      }
      response.writeHead(200, {'content-type': 'application/json'});
      response.end(JSON.stringify(body));
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
      sessions: new Sessions(apiClient),
    });
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  beforeEach(() => {
    appended = undefined;
  });

  it('sends the actions under the API field names', async () => {
    await service.appendEvent({
      session: createSession({
        id: 'session-1',
        appName: AGENT_ENGINE_ID,
        userId: 'user-1',
      }),
      event: createEvent({
        author: 'agent-a',
        invocationId: 'inv-1',
        content: {role: 'model', parts: [{text: 'handing off'}]},
        actions: createEventActions({transferToAgent: 'agent-b'}),
      }),
    });

    expect(appended?.['actions']).toMatchObject({transferAgent: 'agent-b'});
    expect(appended?.['actions']).not.toHaveProperty('transferToAgent');
  });

  it('recovers the actions from the legacy channel on read', async () => {
    const actions: EventActions & Record<string, unknown> = {
      ...createEventActions({
        skipSummarization: true,
        stateDelta: {counter: 1},
        artifactDelta: {'report.pdf': 3},
        transferToAgent: 'agent-b',
        escalate: true,
        requestedAuthConfigs: {
          'call-1': {
            authScheme: {type: 'apiKey', in: 'header', name: 'X-Api-Key'},
            credentialKey: 'key-1',
          },
        },
        requestedToolConfirmations: {
          'call-2': new ToolConfirmation({hint: 'proceed?', confirmed: false}),
        },
      }),
      // Not declared on EventActions: stands in for the next action field
      // added to it, which must persist without a change to the service.
      rewindBeforeInvocationId: 'inv-1',
    };

    await service.appendEvent({
      session: createSession({
        id: 'session-1',
        appName: AGENT_ENGINE_ID,
        userId: 'user-1',
      }),
      event: createEvent({
        author: 'agent-a',
        invocationId: 'inv-1',
        content: {role: 'model', parts: [{text: 'handing off'}]},
        actions,
      }),
    });
    const session = await service.getSession({
      appName: AGENT_ENGINE_ID,
      userId: 'user-1',
      sessionId: 'session-1',
    });

    expect(session?.events).toHaveLength(1);
    expect(session?.events[0].actions).toEqual(actions);
  });
});
