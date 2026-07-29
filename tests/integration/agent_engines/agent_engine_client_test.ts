/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {AgentEngineClient, AgentEngineEvent} from '@google/adk';
import * as http from 'node:http';
import {setTimeout as delay} from 'node:timers/promises';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

// Credentials are the only thing that cannot be exercised locally; the rest of
// the client runs against a real HTTP server over a real socket.
vi.mock('google-auth-library', () => ({
  GoogleAuth: vi.fn(() => ({
    getClient: vi.fn(async () => ({
      getRequestHeaders: vi.fn(
        async () => new Headers({Authorization: 'Bearer fake-token'}),
      ),
    })),
  })),
}));

const PROJECT = 'test-project';
const LOCATION = 'us-central1';
const ENGINE_ID = '1234567890';
const NAME = `projects/${PROJECT}/locations/${LOCATION}/reasoningEngines/${ENGINE_ID}`;
const ENGINE_PATH = `/v1beta1/${NAME}`;
const VERTEX_ORIGIN = `https://${LOCATION}-aiplatform.googleapis.com`;
const USER_ID = 'user_wa_123';
const SESSION_ID = 'conversation-uuid';

/**
 * A session as a deployed Python ADK app dumps it: snake_case keys, and
 * caller-defined keys inside `state` exactly as the app wrote them.
 */
const SESSION = {
  id: SESSION_ID,
  app_name: 'weather_app',
  user_id: USER_ID,
  state: {preferred_unit: 'celsius', 'ticket:id': 42},
  events: [],
  last_update_time: 1751000000.001,
};

/** Events as the deployed app dumps them with `exclude_none=True`. */
const CONVERSATION: AgentEngineEvent[] = [
  {
    id: 'a1b2c3d4',
    invocation_id: 'e-9f2c',
    author: 'weather_agent',
    content: {role: 'model', parts: [{text: 'Let me check Paris.'}]},
    partial: true,
    timestamp: 1751000001.123,
  },
  {
    id: 'b2c3d4e5',
    invocation_id: 'e-9f2c',
    author: 'weather_agent',
    content: {
      role: 'model',
      parts: [
        {
          function_call: {
            id: 'fc-1',
            name: 'get_weather',
            args: {city_name: 'Paris'},
          },
        },
      ],
    },
    actions: {state_delta: {last_city_lookup: 'Paris'}, artifact_delta: {}},
    long_running_tool_ids: [],
    timestamp: 1751000002.456,
  },
  {
    id: 'c3d4e5f6',
    invocation_id: 'e-9f2c',
    author: 'weather_agent',
    content: {role: 'model', parts: [{text: 'It is 18°C and sunny.'}]},
    turn_complete: true,
    timestamp: 1751000003.789,
  },
];

const QUERY_OUTPUTS: Record<string, unknown> = {
  'async_create_session': SESSION,
  'async_get_session': SESSION,
  'async_list_sessions': {sessions: [SESSION]},
  'async_delete_session': null,
};

const SSE_PAYLOAD = Buffer.from(
  CONVERSATION.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''),
  'utf8',
);
// The first boundary falls inside the two byte "°" and the rest split the JSON
// payloads, which is what a real chunked response looks like.
const FIRST_CHUNK_END = SSE_PAYLOAD.indexOf(Buffer.from('°', 'utf8')) + 1;
const CHUNK_BYTES = 16;

function sseChunks(): Buffer[] {
  const chunks = [SSE_PAYLOAD.subarray(0, FIRST_CHUNK_END)];
  for (
    let offset = FIRST_CHUNK_END;
    offset < SSE_PAYLOAD.length;
    offset += CHUNK_BYTES
  ) {
    chunks.push(SSE_PAYLOAD.subarray(offset, offset + CHUNK_BYTES));
  }
  return chunks;
}

const realFetch = globalThis.fetch;

/**
 * The client addresses the public Vertex host; this sends those requests to
 * the local server without otherwise touching the transport.
 */
function localServerFetch(origin: string): typeof fetch {
  return (input, init) =>
    realFetch(String(input).replace(VERTEX_ORIGIN, origin), init);
}

interface RecordedRequest {
  method: string;
  url: string;
  body: Record<string, unknown>;
}

const requests: RecordedRequest[] = [];
const authorizations: Array<string | undefined> = [];

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      body += chunk;
    });
    req.on('end', () => resolve(body));
  });
}

function respondJson(res: http.ServerResponse, payload: unknown): void {
  res.writeHead(200, {'Content-Type': 'application/json'});
  res.end(JSON.stringify(payload));
}

async function respondSse(res: http.ServerResponse): Promise<void> {
  res.writeHead(200, {'Content-Type': 'text/event-stream'});
  for (const chunk of sseChunks()) {
    res.write(chunk);
    await delay(1);
  }
  res.end();
}

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const url = req.url ?? '';
  const rawBody = await readBody(req);
  const body = rawBody ? (JSON.parse(rawBody) as Record<string, unknown>) : {};
  requests.push({method: req.method ?? '', url, body});
  authorizations.push(req.headers.authorization);

  if (url === `${ENGINE_PATH}:streamQuery?alt=sse`) {
    return respondSse(res);
  }
  if (url === `${ENGINE_PATH}:query`) {
    return respondJson(res, {
      output: QUERY_OUTPUTS[String(body['classMethod'])],
    });
  }
  if (url === ENGINE_PATH) {
    return respondJson(res, {name: NAME, displayName: 'weather_app'});
  }
  res.writeHead(404, {'Content-Type': 'text/plain'});
  res.end('reasoning engine not found');
}

describe('AgentEngineClient against a local Agent Engine server', () => {
  let server: http.Server;
  let port = 0;

  beforeAll(() => {
    server = http.createServer(handleRequest);
    return new Promise<void>((resolve) => {
      server.listen(0, () => {
        const address = server.address();
        if (address && typeof address !== 'string') {
          port = address.port;
        }
        resolve();
      });
    });
  });

  afterAll(() => {
    return new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  beforeEach(() => {
    requests.length = 0;
    authorizations.length = 0;
    vi.stubGlobal('fetch', localServerFetch(`http://127.0.0.1:${port}`));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('runs a conversation and returns the remote payloads untouched', async () => {
    const client = new AgentEngineClient({name: NAME});

    const engine = await client.getEngine();
    const session = await client.createSession({
      userId: USER_ID,
      sessionId: SESSION_ID,
    });
    const events: AgentEngineEvent[] = [];
    for await (const event of client.streamQuery({
      userId: USER_ID,
      sessionId: session.id,
      message: 'How is the weather in Paris?',
    })) {
      events.push(event);
    }
    const sessions = await client.listSessions({userId: USER_ID});
    await client.deleteSession({userId: USER_ID, sessionId: session.id});

    expect(engine).toEqual({name: NAME, displayName: 'weather_app'});
    expect(session).toEqual(SESSION);
    expect(events).toEqual(CONVERSATION);
    expect(sessions).toEqual([SESSION]);
    expect(authorizations).toEqual(Array(5).fill('Bearer fake-token'));
    // Pin the wire contract so that a refactor cannot silently change it.
    expect(requests).toEqual([
      {method: 'GET', url: ENGINE_PATH, body: {}},
      {
        method: 'POST',
        url: `${ENGINE_PATH}:query`,
        body: {
          classMethod: 'async_create_session',
          input: {user_id: USER_ID, session_id: SESSION_ID},
        },
      },
      {
        method: 'POST',
        url: `${ENGINE_PATH}:streamQuery?alt=sse`,
        body: {
          classMethod: 'async_stream_query',
          input: {
            message: {
              role: 'user',
              parts: [{text: 'How is the weather in Paris?'}],
            },
            user_id: USER_ID,
            session_id: SESSION_ID,
          },
        },
      },
      {
        method: 'POST',
        url: `${ENGINE_PATH}:query`,
        body: {classMethod: 'async_list_sessions', input: {user_id: USER_ID}},
      },
      {
        method: 'POST',
        url: `${ENGINE_PATH}:query`,
        body: {
          classMethod: 'async_delete_session',
          input: {user_id: USER_ID, session_id: SESSION_ID},
        },
      },
    ]);
  });
});
