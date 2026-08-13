/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Sessions} from '@google-cloud/vertexai/build/src/genai/sessions.js';
import {isCompactedEvent, VertexAiSessionService} from '@google/adk';
import {createCompactedEvent} from '@google/adk/events/compacted_event.js';
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

const SESSION_ID = 'session-1';
const USER_ID = 'user-1';
const START_TIMESTAMP = 1000;
const END_TIMESTAMP = 2000;
const SUMMARY = 'compacted summary';
const SUMMARY_CONTENT = {role: 'model', parts: [{text: SUMMARY}]};

/** The `_compaction` payload adk-python persists under `customMetadata`. */
const CANONICAL_PAYLOAD = {
  start_timestamp: START_TIMESTAMP,
  end_timestamp: END_TIMESTAMP,
  compacted_content: SUMMARY_CONTENT,
};

/** The same payload as adk-python mirrors it into `rawEvent`. */
const ALIASED_PAYLOAD = {
  startTimestamp: START_TIMESTAMP,
  endTimestamp: END_TIMESTAMP,
  compactedContent: SUMMARY_CONTENT,
};

interface AppendedBody {
  eventMetadata?: {customMetadata?: Record<string, unknown>};
  rawEvent?: {actions?: Record<string, unknown>};
}

/**
 * Drives the compaction wire format through the real Agent Engine Sessions
 * client against a loopback server.
 *
 * The unit tests mock that client, so they cannot show that the payload
 * survives the SDK's own request and response processing. These do: a
 * compaction written by adk-python comes back as a usable `CompactedEvent`,
 * and one written here reaches the wire in the shape adk-python reads.
 */
describe('VertexAiSessionService compaction over the wire', () => {
  let server: http.Server;
  let service: VertexAiSessionService;
  let bodies: AppendedBody[];
  let sessionEvents: unknown[];

  beforeAll(async () => {
    server = http.createServer(async (request, response) => {
      if (request.method === 'POST') {
        bodies.push((await json(request)) as AppendedBody);
        response.writeHead(200, {'content-type': 'application/json'});
        response.end('{}');
        return;
      }
      response.writeHead(200, {'content-type': 'application/json'});
      response.end(
        JSON.stringify(
          request.url?.includes('/events')
            ? {sessionEvents}
            : {
                name: `reasoningEngines/${AGENT_ENGINE_ID}/sessions/${SESSION_ID}`,
                userId: USER_ID,
                updateTime: '2026-01-01T00:00:00Z',
              },
        ),
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
    sessionEvents = [];
  });

  const getSession = () =>
    service.getSession({
      appName: AGENT_ENGINE_ID,
      userId: USER_ID,
      sessionId: SESSION_ID,
    });

  it('restores a compaction adk-python wrote', async () => {
    sessionEvents = [
      {
        name: `reasoningEngines/${AGENT_ENGINE_ID}/sessions/${SESSION_ID}/events/e1`,
        invocationId: 'inv-1',
        author: 'user',
        timestamp: '2026-01-01T00:00:00Z',
        eventMetadata: {customMetadata: {_compaction: CANONICAL_PAYLOAD}},
        rawEvent: {
          invocationId: 'inv-1',
          author: 'user',
          actions: {compaction: ALIASED_PAYLOAD},
        },
      },
    ];

    const session = await getSession();
    const event = session!.events[0];
    if (!isCompactedEvent(event)) {
      expect.fail('expected the parsed event to be a CompactedEvent');
    }

    expect(event.startTime).toBe(START_TIMESTAMP);
    expect(event.endTime).toBe(END_TIMESTAMP);
    expect(event.compactedContent).toBe(SUMMARY);
    expect(event.content).toEqual(SUMMARY_CONTENT);
  });

  it('sends the canonical payload on both channels when appending', async () => {
    const session = await getSession();

    await service.appendEvent({
      session: session!,
      event: createCompactedEvent({
        timestamp: 1620000000000,
        author: 'user',
        invocationId: 'inv-compaction',
        startTime: START_TIMESTAMP,
        endTime: END_TIMESTAMP,
        compactedContent: SUMMARY,
        content: SUMMARY_CONTENT,
      }),
    });

    expect(bodies).toHaveLength(1);
    expect(bodies[0].eventMetadata?.customMetadata).toEqual({
      _compaction: CANONICAL_PAYLOAD,
    });
    expect(bodies[0].rawEvent?.actions?.['compaction']).toEqual(
      ALIASED_PAYLOAD,
    );
  });
});
