/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AgentEngineClient,
  AgentEngineEvent,
  getClientLabels,
  getLogger,
} from '@google/adk';
import {GoogleAuth} from 'google-auth-library';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
// These helpers are deliberately not part of the package surface, so the unit
// test reaches into the module that owns them.
import {
  agentEngineApiEndpoint,
  parseReasoningEngineName,
  parseSseStream,
} from '../../src/agent_engines/agent_engine_client.js';

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
const ENGINE_URL = `https://${LOCATION}-aiplatform.googleapis.com/v1beta1/${NAME}`;

const fetchMock = vi.fn<typeof fetch>();

interface CapturedRequest {
  url: string;
  method: string;
  headers: Headers;
  body: Record<string, unknown>;
}

function capturedRequest(index: number): CapturedRequest {
  const [input, init] = fetchMock.mock.calls[index];
  return {
    url: String(input),
    method: init?.method ?? '',
    headers: new Headers(init?.headers),
    body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
  };
}

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {status: 200});
}

function streamOf(
  chunks: Array<string | Uint8Array>,
  onCancel?: () => void,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(
          typeof chunk === 'string' ? encoder.encode(chunk) : chunk,
        );
      }
      controller.close();
    },
    cancel: onCancel,
  });
}

function sseBody(events: AgentEngineEvent[]): string {
  return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('');
}

async function collect(
  events: AsyncGenerator<AgentEngineEvent>,
): Promise<AgentEngineEvent[]> {
  const collected: AgentEngineEvent[] = [];
  for await (const event of events) {
    collected.push(event);
  }
  return collected;
}

describe('parseReasoningEngineName', () => {
  it('parses a full resource name', () => {
    expect(parseReasoningEngineName(NAME)).toEqual({
      projectId: PROJECT,
      location: LOCATION,
      reasoningEngineId: ENGINE_ID,
    });
  });

  it.each([
    'invalid',
    `${NAME}/sessions/session-1`,
    `projects/${PROJECT}/locations/${LOCATION}/reasoningEngines/not-a-number`,
  ])('rejects the malformed resource name %s', (name) => {
    expect(() => parseReasoningEngineName(name)).toThrow(
      `Invalid Agent Engine resource name: ${name}. Expected ` +
        `projects/{project}/locations/{location}/reasoningEngines/{id}.`,
    );
  });
});

describe('agentEngineApiEndpoint', () => {
  it('returns the regional endpoint', () => {
    expect(agentEngineApiEndpoint('europe-west4')).toBe(
      'https://europe-west4-aiplatform.googleapis.com',
    );
  });

  it('returns the global endpoint', () => {
    expect(agentEngineApiEndpoint('global')).toBe(
      'https://aiplatform.googleapis.com',
    );
  });
});

describe('parseSseStream', () => {
  it('yields the event of a single data line', async () => {
    const events = await collect(
      parseSseStream(streamOf(['data: {"author":"agent"}\n\n'])),
    );

    expect(events).toEqual([{author: 'agent'}]);
  });

  it('yields several events of one chunk in order', async () => {
    const events = await collect(
      parseSseStream(streamOf([sseBody([{id: '1'}, {id: '2'}, {id: '3'}])])),
    );

    expect(events).toEqual([{id: '1'}, {id: '2'}, {id: '3'}]);
  });

  it('joins the data lines of one event', async () => {
    const events = await collect(
      parseSseStream(streamOf(['data: {"author":\ndata: "agent"}\n\n'])),
    );

    expect(events).toEqual([{author: 'agent'}]);
  });

  it('reassembles a payload split across chunks', async () => {
    const payload = new TextEncoder().encode('data: {"author":"agénte"}\n\n');
    // Byte 19 starts the two byte "é", so the split falls inside a character.
    const events = await collect(
      parseSseStream(streamOf([payload.slice(0, 20), payload.slice(20)])),
    );

    expect(events).toEqual([{author: 'agénte'}]);
  });

  it('handles CRLF line endings', async () => {
    const events = await collect(
      parseSseStream(streamOf(['data: {"author":"agent"}\r\n\r\n'])),
    );

    expect(events).toEqual([{author: 'agent'}]);
  });

  it('ignores comments and non data fields', async () => {
    const events = await collect(
      parseSseStream(
        streamOf([': keepalive\n\nevent: message\ndata: {"id":"1"}\n\n']),
      ),
    );

    expect(events).toEqual([{id: '1'}]);
  });

  it('flushes a trailing event that has no blank line', async () => {
    const events = await collect(
      parseSseStream(streamOf(['data: {"id":"1"}'])),
    );

    expect(events).toEqual([{id: '1'}]);
  });

  it('skips an unparseable payload and keeps streaming', async () => {
    const warn = vi.spyOn(getLogger(), 'warn').mockImplementation(() => {});

    const events = await collect(
      parseSseStream(streamOf(['data: <html>\n\ndata: {"id":"1"}\n\n'])),
    );

    expect(events).toEqual([{id: '1'}]);
    expect(warn).toHaveBeenCalledWith(
      'Skipping unparseable Agent Engine stream payload (6 chars).',
    );
  });

  it('yields nothing for an empty stream', async () => {
    expect(await collect(parseSseStream(streamOf([])))).toEqual([]);
  });

  it('cancels the stream when the consumer stops early', async () => {
    const cancel = vi.fn();
    const stream = streamOf(
      ['data: {"id":"1"}\n\n', 'data: {"id":"2"}\n\n'],
      cancel,
    );

    for await (const event of parseSseStream(stream)) {
      expect(event).toEqual({id: '1'});
      break;
    }

    expect(cancel).toHaveBeenCalled();
    expect(stream.locked).toBe(false);
  });
});

describe('AgentEngineClient', () => {
  let client: AgentEngineClient;

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    client = new AgentEngineClient({name: NAME});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  describe('constructor', () => {
    it('builds the resource name from its parts', () => {
      const built = new AgentEngineClient({
        projectId: PROJECT,
        location: LOCATION,
        reasoningEngineId: ENGINE_ID,
      });

      expect(built.name).toBe(NAME);
    });

    it('derives the parts from the resource name', () => {
      expect(client.projectId).toBe(PROJECT);
      expect(client.location).toBe(LOCATION);
      expect(client.reasoningEngineId).toBe(ENGINE_ID);
    });

    it('falls back to the environment', () => {
      vi.stubEnv('GOOGLE_CLOUD_PROJECT', 'env-project');
      vi.stubEnv('GOOGLE_CLOUD_LOCATION', 'europe-west4');

      expect(new AgentEngineClient({reasoningEngineId: ENGINE_ID}).name).toBe(
        `projects/env-project/locations/europe-west4/reasoningEngines/${ENGINE_ID}`,
      );
    });

    it('defaults the location to us-central1', () => {
      vi.stubEnv('GOOGLE_CLOUD_PROJECT', 'env-project');
      vi.stubEnv('GOOGLE_CLOUD_LOCATION', undefined);

      expect(
        new AgentEngineClient({reasoningEngineId: ENGINE_ID}).location,
      ).toBe('us-central1');
    });

    it('throws when the project cannot be resolved', () => {
      vi.stubEnv('GOOGLE_CLOUD_PROJECT', undefined);

      expect(
        () => new AgentEngineClient({reasoningEngineId: ENGINE_ID}),
      ).toThrow(
        'Project ID is required. Set projectId or the GOOGLE_CLOUD_PROJECT ' +
          'environment variable.',
      );
    });

    it('throws when the reasoning engine id is missing', () => {
      expect(() => new AgentEngineClient({projectId: PROJECT})).toThrow(
        'reasoningEngineId is required when name is not provided.',
      );
    });

    it('throws for a malformed resource name', () => {
      expect(
        () => new AgentEngineClient({name: 'projects/p/reasoningEngines/1'}),
      ).toThrow('Invalid Agent Engine resource name');
    });

    it('uses the injected credentials', async () => {
      const auth = new GoogleAuth();
      fetchMock.mockResolvedValue(jsonResponse({name: NAME}));

      await new AgentEngineClient({name: NAME, auth}).getEngine();

      expect(auth.getClient).toHaveBeenCalled();
    });
  });

  describe('getEngine', () => {
    it('returns the reasoning engine resource', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse({name: NAME, displayName: 'my-app'}),
      );

      expect(await client.getEngine()).toEqual({
        name: NAME,
        displayName: 'my-app',
      });
      const request = capturedRequest(0);
      expect(request.url).toBe(ENGINE_URL);
      expect(request.method).toBe('GET');
      expect(request.headers.get('Authorization')).toBe('Bearer fake-token');
      expect(request.headers.get('Content-Type')).toBeNull();
    });

    it('reports the status and body of a failed request', async () => {
      fetchMock.mockResolvedValue(
        new Response('permission denied', {status: 403}),
      );

      await expect(client.getEngine()).rejects.toThrow(
        `Agent Engine request to ${ENGINE_URL} failed with status 403: permission denied`,
      );
    });
  });

  describe('createSession', () => {
    it('sends the user id, session id and state', async () => {
      const session = {
        id: 'session-1',
        app_name: 'my-app',
        user_id: 'user-1',
        state: {user_pref: 'dark'},
        last_update_time: 1700000000.5,
      };
      fetchMock.mockResolvedValue(jsonResponse({output: session}));

      expect(
        await client.createSession({
          userId: 'user-1',
          sessionId: 'session-1',
          state: {user_pref: 'dark'},
        }),
      ).toEqual(session);
      const request = capturedRequest(0);
      expect(request.url).toBe(`${ENGINE_URL}:query`);
      expect(request.method).toBe('POST');
      expect(request.body).toEqual({
        classMethod: 'async_create_session',
        input: {
          user_id: 'user-1',
          session_id: 'session-1',
          state: {user_pref: 'dark'},
        },
      });
    });

    it('omits the session id and state when they are not given', async () => {
      fetchMock.mockResolvedValue(jsonResponse({output: {id: 'session-1'}}));

      await client.createSession({userId: 'user-1'});

      expect(capturedRequest(0).body).toEqual({
        classMethod: 'async_create_session',
        input: {user_id: 'user-1'},
      });
    });

    it('sends the auth and client label headers', async () => {
      fetchMock.mockResolvedValue(jsonResponse({output: {id: 'session-1'}}));

      await client.createSession({userId: 'user-1'});

      const labels = getClientLabels().join(' ');
      const {headers} = capturedRequest(0);
      expect(headers.get('Authorization')).toBe('Bearer fake-token');
      expect(headers.get('Content-Type')).toBe('application/json');
      expect(headers.get('x-goog-api-client')).toBe(labels);
      expect(headers.get('user-agent')).toBe(labels);
    });
  });

  describe('getSession', () => {
    it('returns the session', async () => {
      fetchMock.mockResolvedValue(jsonResponse({output: {id: 'session-1'}}));

      expect(
        await client.getSession({userId: 'user-1', sessionId: 'session-1'}),
      ).toEqual({id: 'session-1'});
      expect(capturedRequest(0).body).toEqual({
        classMethod: 'async_get_session',
        input: {user_id: 'user-1', session_id: 'session-1'},
      });
    });

    it('returns undefined for a null output', async () => {
      fetchMock.mockResolvedValue(jsonResponse({output: null}));

      expect(
        await client.getSession({userId: 'user-1', sessionId: 'missing'}),
      ).toBeUndefined();
    });

    it('returns undefined when the output is absent', async () => {
      fetchMock.mockResolvedValue(jsonResponse({}));

      expect(
        await client.getSession({userId: 'user-1', sessionId: 'missing'}),
      ).toBeUndefined();
    });
  });

  describe('listSessions', () => {
    it('returns the sessions of the user', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse({output: {sessions: [{id: 'session-1'}]}}),
      );

      expect(await client.listSessions({userId: 'user-1'})).toEqual([
        {id: 'session-1'},
      ]);
      expect(capturedRequest(0).body).toEqual({
        classMethod: 'async_list_sessions',
        input: {user_id: 'user-1'},
      });
    });

    it('returns an empty list when there are no sessions', async () => {
      fetchMock.mockResolvedValue(jsonResponse({output: {}}));

      expect(await client.listSessions({userId: 'user-1'})).toEqual([]);
    });
  });

  describe('deleteSession', () => {
    it('deletes the session', async () => {
      fetchMock.mockResolvedValue(jsonResponse({output: null}));

      expect(
        await client.deleteSession({userId: 'user-1', sessionId: 'session-1'}),
      ).toBeUndefined();
      expect(capturedRequest(0).body).toEqual({
        classMethod: 'async_delete_session',
        input: {user_id: 'user-1', session_id: 'session-1'},
      });
    });
  });

  describe('query', () => {
    it('forwards an arbitrary class method and returns its output', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse({output: {memories: [{fact: 'likes tea'}]}}),
      );

      expect(
        await client.query({
          classMethod: 'async_search_memory',
          input: {user_id: 'user-1', query: 'tea'},
        }),
      ).toEqual({memories: [{fact: 'likes tea'}]});
      expect(capturedRequest(0).body).toEqual({
        classMethod: 'async_search_memory',
        input: {user_id: 'user-1', query: 'tea'},
      });
    });

    it('sends an empty input when none is given', async () => {
      fetchMock.mockResolvedValue(jsonResponse({output: 'ok'}));

      await client.query({classMethod: 'custom_method'});

      expect(capturedRequest(0).body).toEqual({
        classMethod: 'custom_method',
        input: {},
      });
    });
  });

  describe('streamQuery', () => {
    const streamEvents: AgentEngineEvent[] = [
      {
        id: 'event-1',
        invocation_id: 'e-1',
        author: 'weather_agent',
        content: {role: 'model', parts: [{text: 'Checking the '}]},
        partial: true,
      },
      {
        id: 'event-2',
        invocation_id: 'e-1',
        author: 'weather_agent',
        content: {
          role: 'model',
          parts: [
            {function_call: {name: 'get_weather', args: {city_name: 'Paris'}}},
          ],
        },
      },
      {
        id: 'event-3',
        invocation_id: 'e-1',
        author: 'weather_agent',
        turn_complete: true,
      },
    ];

    it('wraps a string message and yields every event in order', async () => {
      fetchMock.mockResolvedValue(
        new Response(streamOf([sseBody(streamEvents)])),
      );

      expect(
        await collect(
          client.streamQuery({
            userId: 'user-1',
            sessionId: 'session-1',
            message: 'Hello',
          }),
        ),
      ).toEqual(streamEvents);
      const request = capturedRequest(0);
      expect(request.url).toBe(`${ENGINE_URL}:streamQuery?alt=sse`);
      expect(request.method).toBe('POST');
      expect(request.body).toEqual({
        classMethod: 'async_stream_query',
        input: {
          message: {role: 'user', parts: [{text: 'Hello'}]},
          user_id: 'user-1',
          session_id: 'session-1',
        },
      });
    });

    it('forwards a Content message and the run config', async () => {
      fetchMock.mockResolvedValue(new Response(streamOf([])));

      await collect(
        client.streamQuery({
          userId: 'user-1',
          message: {role: 'user', parts: [{text: 'Hi'}]},
          runConfig: {streaming_mode: 'SSE'},
        }),
      );

      expect(capturedRequest(0).body).toEqual({
        classMethod: 'async_stream_query',
        input: {
          message: {role: 'user', parts: [{text: 'Hi'}]},
          user_id: 'user-1',
          run_config: {streaming_mode: 'SSE'},
        },
      });
    });

    it('throws before the first event when the request fails', async () => {
      fetchMock.mockResolvedValue(
        new Response('quota exceeded', {status: 429}),
      );

      await expect(
        collect(client.streamQuery({userId: 'user-1', message: 'Hello'})),
      ).rejects.toThrow(
        `Agent Engine request to ${ENGINE_URL}:streamQuery?alt=sse failed with status 429: quota exceeded`,
      );
    });

    it('yields nothing when the response has no body', async () => {
      fetchMock.mockResolvedValue(new Response(null, {status: 200}));

      expect(
        await collect(client.streamQuery({userId: 'user-1', message: 'Hello'})),
      ).toEqual([]);
    });
  });
});
