/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Content} from '@google/genai';
import {beforeEach, describe, expect, it, vi} from 'vitest';

// Shared transport mocks, hoisted so they are available inside vi.mock.
const mocks = vi.hoisted(() => ({
  clientCtor: vi.fn(),
  reasoningEnginePath: vi.fn(
    (project: string, location: string, id: string) =>
      `projects/${project}/locations/${location}/reasoningEngines/${id}`,
  ),
  queryReasoningEngine: vi.fn(),
  streamQueryReasoningEngine: vi.fn(),
}));

// Mock only the transport client; keep the real `helpers`/`protos` so the
// Struct encoding/decoding is exercised for real (they perform no network I/O).
vi.mock('@google-cloud/aiplatform', async (importActual) => {
  const actual =
    await importActual<typeof import('@google-cloud/aiplatform')>();
  class ReasoningEngineExecutionServiceClient {
    reasoningEnginePath = mocks.reasoningEnginePath;
    queryReasoningEngine = mocks.queryReasoningEngine;
    streamQueryReasoningEngine = mocks.streamQueryReasoningEngine;
    constructor(options: unknown) {
      mocks.clientCtor(options);
    }
  }
  return {
    ...actual,
    v1: {...actual.v1, ReasoningEngineExecutionServiceClient},
  };
});

import {helpers} from '@google-cloud/aiplatform';
import {AgentEngineClient, AgentExecutionError} from '@google/adk';
// Internal, non-public helpers are imported relatively (per the testing guide)
// since they are intentionally not re-exported from the package entry point.
import {
  buildInputStruct,
  parseEngineName,
  parseStream,
  toSessionResult,
} from '../../src/agents/agent_engine_client.js';

const ENGINE_NAME =
  'projects/test-project/locations/us-central1/reasoningEngines/12345';

/** Decodes the IStruct passed as the RPC `input` back to a plain object. */
function decodeStruct(input: unknown): Record<string, unknown> {
  return helpers.fromValue({
    kind: 'structValue',
    structValue: input,
  } as Parameters<typeof helpers.fromValue>[0]) as Record<string, unknown>;
}

/**
 * A `google.protobuf.Value` wrapping null, as the engine returns for a missing
 * session or an empty result. Its lack of a `structValue` is what the client
 * treats as "no value".
 */
const NULL_OUTPUT = {nullValue: 0};

/** Yields the given chunks as an async stream, like the transport does. */
async function* asStream(chunks: unknown[]): AsyncGenerator<unknown> {
  for (const chunk of chunks) {
    yield chunk;
  }
}

/** Awaits a promise expected to reject and returns the thrown value. */
async function captureError(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the promise to reject');
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('parseEngineName', () => {
  it('parses a full reasoning engine resource name', () => {
    expect(parseEngineName(ENGINE_NAME)).toEqual({
      project: 'test-project',
      location: 'us-central1',
      reasoningEngineId: '12345',
    });
  });

  it('throws for a non-matching resource name', () => {
    expect(() => parseEngineName('not-a-resource-name')).toThrow(
      'not-a-resource-name is not a valid ReasoningEngine resource name',
    );
  });
});

describe('buildInputStruct', () => {
  it('returns undefined for undefined input', () => {
    expect(buildInputStruct(helpers, undefined)).toBeUndefined();
  });

  it('encodes an object as a snake_case Struct', () => {
    const struct = buildInputStruct(helpers, {user_id: 'u1'});
    expect(struct?.fields?.['user_id']?.stringValue).toBe('u1');
  });
});

describe('toSessionResult', () => {
  it('maps snake_case fields to camelCase', () => {
    expect(
      toSessionResult({
        id: 'sess-1',
        user_id: 'u1',
        state: {foo: 'bar'},
        last_update_time: 123,
      }),
    ).toEqual({
      id: 'sess-1',
      userId: 'u1',
      state: {foo: 'bar'},
      lastUpdateTime: 123,
    });
  });

  it('defaults a missing id to an empty string', () => {
    expect(toSessionResult({}).id).toBe('');
  });
});

describe('AgentEngineClient constructor / get', () => {
  it('lazily builds the transport with the regional endpoint and derives the path', async () => {
    const client = new AgentEngineClient({
      project: 'test-project',
      location: 'us-central1',
      reasoningEngineId: '12345',
    });

    // The heavy transport is not constructed until the client is first used.
    expect(client).toBeInstanceOf(AgentEngineClient);
    expect(mocks.clientCtor).not.toHaveBeenCalled();

    mocks.queryReasoningEngine.mockResolvedValue([
      {output: helpers.toValue({id: 'sess-1'})},
    ]);
    await client.createSession({userId: 'u1'});

    expect(mocks.clientCtor).toHaveBeenCalledWith({
      apiEndpoint: 'us-central1-aiplatform.googleapis.com',
    });
    expect(mocks.reasoningEnginePath).toHaveBeenCalledWith(
      'test-project',
      'us-central1',
      '12345',
    );
  });

  it('get() parses a full resource name into a bound client', async () => {
    const client = AgentEngineClient.get(ENGINE_NAME);
    mocks.queryReasoningEngine.mockResolvedValue([
      {output: helpers.toValue({id: 'sess-1'})},
    ]);
    await client.createSession({userId: 'u1'});
    expect(mocks.reasoningEnginePath).toHaveBeenCalledWith(
      'test-project',
      'us-central1',
      '12345',
    );
  });

  it('get() throws for an invalid resource name', () => {
    expect(() => AgentEngineClient.get('bad-name')).toThrow(
      'is not a valid ReasoningEngine resource name',
    );
  });
});

describe('AgentEngineClient.createSession', () => {
  let client: AgentEngineClient;

  beforeEach(() => {
    client = AgentEngineClient.get(ENGINE_NAME);
  });

  it('calls async_create_session with snake_case input and returns the session', async () => {
    mocks.queryReasoningEngine.mockResolvedValue([
      {
        output: helpers.toValue({
          id: 'sess-1',
          user_id: 'u1',
          state: {k: 1},
          last_update_time: 42,
        }),
      },
    ]);

    const session = await client.createSession({userId: 'u1'});

    expect(session).toEqual({
      id: 'sess-1',
      userId: 'u1',
      state: {k: 1},
      lastUpdateTime: 42,
    });

    const req = mocks.queryReasoningEngine.mock.calls[0][0];
    expect(req.name).toBe(ENGINE_NAME);
    expect(req.classMethod).toBe('async_create_session');
    expect(decodeStruct(req.input)).toEqual({user_id: 'u1'});
  });

  it('includes session_id when supplied', async () => {
    mocks.queryReasoningEngine.mockResolvedValue([
      {output: helpers.toValue({id: 'sess-1'})},
    ]);

    await client.createSession({userId: 'u1', sessionId: 'reuse-me'});

    const req = mocks.queryReasoningEngine.mock.calls[0][0];
    expect(decodeStruct(req.input)).toEqual({
      user_id: 'u1',
      session_id: 'reuse-me',
    });
  });

  it('throws AgentExecutionError when the response has no output', async () => {
    mocks.queryReasoningEngine.mockResolvedValue([{}]);

    await expect(client.createSession({userId: 'u1'})).rejects.toThrow(
      'Failed to create session: the response did not contain a session output.',
    );
  });

  it('throws AgentExecutionError when the session has no id', async () => {
    mocks.queryReasoningEngine.mockResolvedValue([
      {output: helpers.toValue({user_id: 'u1'})},
    ]);

    await expect(client.createSession({userId: 'u1'})).rejects.toThrow(
      'Failed to create session: the session output did not contain an id.',
    );
  });

  it('wraps a rejected Error call in AgentExecutionError with the cause', async () => {
    const cause = new Error('boom');
    mocks.queryReasoningEngine.mockRejectedValue(cause);

    const error = await captureError(client.createSession({userId: 'u1'}));
    expect(error).toBeInstanceOf(AgentExecutionError);
    expect((error as AgentExecutionError).message).toBe(
      'Failed to create session: boom',
    );
    expect((error as AgentExecutionError).cause).toBe(cause);
  });

  it('wraps a rejected non-Error throwable in AgentExecutionError', async () => {
    mocks.queryReasoningEngine.mockRejectedValue('kaboom');

    await expect(client.createSession({userId: 'u1'})).rejects.toThrow(
      'Failed to create session: kaboom',
    );
  });
});

describe('AgentEngineClient.getSession', () => {
  let client: AgentEngineClient;

  beforeEach(() => {
    client = AgentEngineClient.get(ENGINE_NAME);
  });

  it('calls async_get_session with snake_case input and returns the mapped session', async () => {
    mocks.queryReasoningEngine.mockResolvedValue([
      {
        output: helpers.toValue({
          id: 'sess-1',
          user_id: 'u1',
          state: {k: 1},
          last_update_time: 42,
        }),
      },
    ]);

    const session = await client.getSession({userId: 'u1', sessionId: 's1'});

    expect(session).toEqual({
      id: 'sess-1',
      userId: 'u1',
      state: {k: 1},
      lastUpdateTime: 42,
    });

    const req = mocks.queryReasoningEngine.mock.calls[0][0];
    expect(req.name).toBe(ENGINE_NAME);
    expect(req.classMethod).toBe('async_get_session');
    expect(decodeStruct(req.input)).toEqual({user_id: 'u1', session_id: 's1'});
  });

  it('returns undefined when the response has no output', async () => {
    mocks.queryReasoningEngine.mockResolvedValue([{}]);

    expect(
      await client.getSession({userId: 'u1', sessionId: 's1'}),
    ).toBeUndefined();
  });

  it('returns undefined when the output is a null Value', async () => {
    mocks.queryReasoningEngine.mockResolvedValue([{output: NULL_OUTPUT}]);

    expect(
      await client.getSession({userId: 'u1', sessionId: 's1'}),
    ).toBeUndefined();
  });

  it('wraps a rejected Error call in AgentExecutionError with the cause', async () => {
    const cause = new Error('boom');
    mocks.queryReasoningEngine.mockRejectedValue(cause);

    const error = await captureError(
      client.getSession({userId: 'u1', sessionId: 's1'}),
    );
    expect(error).toBeInstanceOf(AgentExecutionError);
    expect((error as AgentExecutionError).message).toBe(
      'Failed to get session: boom',
    );
    expect((error as AgentExecutionError).cause).toBe(cause);
  });

  it('wraps a rejected non-Error throwable in AgentExecutionError', async () => {
    mocks.queryReasoningEngine.mockRejectedValue('kaboom');

    await expect(
      client.getSession({userId: 'u1', sessionId: 's1'}),
    ).rejects.toThrow('Failed to get session: kaboom');
  });
});

describe('AgentEngineClient.listSessions', () => {
  let client: AgentEngineClient;

  beforeEach(() => {
    client = AgentEngineClient.get(ENGINE_NAME);
  });

  it('calls async_list_sessions with snake_case input and maps every session', async () => {
    mocks.queryReasoningEngine.mockResolvedValue([
      {
        output: helpers.toValue({
          sessions: [
            {id: 's1', user_id: 'u1'},
            {id: 's2', user_id: 'u1', state: {a: 1}, last_update_time: 9},
          ],
        }),
      },
    ]);

    const sessions = await client.listSessions({userId: 'u1'});

    expect(sessions).toEqual([
      {id: 's1', userId: 'u1', state: undefined, lastUpdateTime: undefined},
      {id: 's2', userId: 'u1', state: {a: 1}, lastUpdateTime: 9},
    ]);

    const req = mocks.queryReasoningEngine.mock.calls[0][0];
    expect(req.name).toBe(ENGINE_NAME);
    expect(req.classMethod).toBe('async_list_sessions');
    expect(decodeStruct(req.input)).toEqual({user_id: 'u1'});
  });

  it('returns an empty array when the response has no output', async () => {
    mocks.queryReasoningEngine.mockResolvedValue([{}]);

    expect(await client.listSessions({userId: 'u1'})).toEqual([]);
  });

  it('returns an empty array when the decoded object has no sessions field', async () => {
    mocks.queryReasoningEngine.mockResolvedValue([
      {output: helpers.toValue({})},
    ]);

    expect(await client.listSessions({userId: 'u1'})).toEqual([]);
  });

  it('returns an empty array when the output is a null Value', async () => {
    mocks.queryReasoningEngine.mockResolvedValue([{output: NULL_OUTPUT}]);

    expect(await client.listSessions({userId: 'u1'})).toEqual([]);
  });

  it('wraps a rejected Error call in AgentExecutionError with the cause', async () => {
    const cause = new Error('boom');
    mocks.queryReasoningEngine.mockRejectedValue(cause);

    const error = await captureError(client.listSessions({userId: 'u1'}));
    expect(error).toBeInstanceOf(AgentExecutionError);
    expect((error as AgentExecutionError).message).toBe(
      'Failed to list sessions: boom',
    );
    expect((error as AgentExecutionError).cause).toBe(cause);
  });

  it('wraps a rejected non-Error throwable in AgentExecutionError', async () => {
    mocks.queryReasoningEngine.mockRejectedValue('kaboom');

    await expect(client.listSessions({userId: 'u1'})).rejects.toThrow(
      'Failed to list sessions: kaboom',
    );
  });
});

describe('AgentEngineClient.deleteSession', () => {
  let client: AgentEngineClient;

  beforeEach(() => {
    client = AgentEngineClient.get(ENGINE_NAME);
  });

  it('calls async_delete_session with snake_case input and resolves undefined', async () => {
    mocks.queryReasoningEngine.mockResolvedValue([{}]);

    expect(
      await client.deleteSession({userId: 'u1', sessionId: 's1'}),
    ).toBeUndefined();

    const req = mocks.queryReasoningEngine.mock.calls[0][0];
    expect(req.name).toBe(ENGINE_NAME);
    expect(req.classMethod).toBe('async_delete_session');
    expect(decodeStruct(req.input)).toEqual({user_id: 'u1', session_id: 's1'});
  });

  it('wraps a rejected Error call in AgentExecutionError with the cause', async () => {
    const cause = new Error('boom');
    mocks.queryReasoningEngine.mockRejectedValue(cause);

    const error = await captureError(
      client.deleteSession({userId: 'u1', sessionId: 's1'}),
    );
    expect(error).toBeInstanceOf(AgentExecutionError);
    expect((error as AgentExecutionError).message).toBe(
      'Failed to delete session: boom',
    );
    expect((error as AgentExecutionError).cause).toBe(cause);
  });

  it('wraps a rejected non-Error throwable in AgentExecutionError', async () => {
    mocks.queryReasoningEngine.mockRejectedValue('kaboom');

    await expect(
      client.deleteSession({userId: 'u1', sessionId: 's1'}),
    ).rejects.toThrow('Failed to delete session: kaboom');
  });
});

describe('AgentEngineClient.streamQuery', () => {
  let client: AgentEngineClient;

  beforeEach(() => {
    client = AgentEngineClient.get(ENGINE_NAME);
  });

  async function collect(stream: AsyncIterable<unknown>): Promise<unknown[]> {
    const events: unknown[] = [];
    for await (const event of stream) {
      events.push(event);
    }
    return events;
  }

  it('parses an SSE stream into camelCased Events with snake_case input', async () => {
    mocks.streamQueryReasoningEngine.mockReturnValue(
      asStream([
        {data: 'data: {"author": "agent", "invocation_id": "abc"}\n'},
        {data: 'data: [DONE]\n'},
      ]),
    );

    const events = await collect(
      client.streamQuery({
        userId: 'u1',
        sessionId: 's1',
        message: 'Hello',
      }),
    );

    expect(events).toEqual([{author: 'agent', invocationId: 'abc'}]);

    const req = mocks.streamQueryReasoningEngine.mock.calls[0][0];
    expect(req.name).toBe(ENGINE_NAME);
    expect(req.classMethod).toBe('async_stream_query');
    expect(decodeStruct(req.input)).toEqual({
      user_id: 'u1',
      session_id: 's1',
      message: 'Hello',
    });
  });

  it('handles a "data:" prefix without a space', async () => {
    mocks.streamQueryReasoningEngine.mockReturnValue(
      asStream([{data: 'data:{"author": "agent"}\n'}]),
    );

    const events = await collect(
      client.streamQuery({userId: 'u1', sessionId: 's1', message: 'Hi'}),
    );

    expect(events).toEqual([{author: 'agent'}]);
  });

  it('decodes Uint8Array chunk data', async () => {
    const bytes = new TextEncoder().encode('{"author": "agent"}\n');
    mocks.streamQueryReasoningEngine.mockReturnValue(asStream([{data: bytes}]));

    const events = await collect(
      client.streamQuery({userId: 'u1', sessionId: 's1', message: 'Hi'}),
    );

    expect(events).toEqual([{author: 'agent'}]);
  });

  it('reassembles JSON fragmented across chunks', async () => {
    mocks.streamQueryReasoningEngine.mockReturnValue(
      asStream([{data: '{"author": "ag'}, {data: 'ent", "branch": "b1"}\n'}]),
    );

    const events = await collect(
      client.streamQuery({userId: 'u1', sessionId: 's1', message: 'Hi'}),
    );

    expect(events).toEqual([{author: 'agent', branch: 'b1'}]);
  });

  it('flushes a final payload emitted without a trailing newline', async () => {
    mocks.streamQueryReasoningEngine.mockReturnValue(
      asStream([{data: '{"author": "agent"}'}]),
    );

    const events = await collect(
      client.streamQuery({userId: 'u1', sessionId: 's1', message: 'Hi'}),
    );

    expect(events).toEqual([{author: 'agent'}]);
  });

  it('serializes a Content message into the input Struct', async () => {
    mocks.streamQueryReasoningEngine.mockReturnValue(asStream([]));
    const message: Content = {
      role: 'user',
      parts: [{text: 'hi'}, {thought: undefined}],
    };

    await collect(client.streamQuery({userId: 'u1', sessionId: 's1', message}));

    const req = mocks.streamQueryReasoningEngine.mock.calls[0][0];
    expect(decodeStruct(req.input)).toEqual({
      user_id: 'u1',
      session_id: 's1',
      // undefined fields are dropped during serialization.
      message: {role: 'user', parts: [{text: 'hi'}, {}]},
    });
  });

  it('throws AgentExecutionError when the transport call throws', async () => {
    const cause = new Error('no stream');
    mocks.streamQueryReasoningEngine.mockImplementation(() => {
      throw cause;
    });

    const stream = client.streamQuery({
      userId: 'u1',
      sessionId: 's1',
      message: 'Hi',
    });

    const error = await captureError(stream.next());
    expect(error).toBeInstanceOf(AgentExecutionError);
    expect((error as AgentExecutionError).message).toBe(
      'Failed to execute stream query: no stream',
    );
    expect((error as AgentExecutionError).cause).toBe(cause);
  });

  it('throws AgentExecutionError when a completed line fails to parse', async () => {
    mocks.streamQueryReasoningEngine.mockReturnValue(
      asStream([{data: 'data: {not json}\n'}]),
    );

    await expect(
      collect(
        client.streamQuery({userId: 'u1', sessionId: 's1', message: 'Hi'}),
      ),
    ).rejects.toThrow('Failed to parse stream fragment: {not json}');
  });

  it('throws AgentExecutionError when the flushed remainder fails to parse', async () => {
    mocks.streamQueryReasoningEngine.mockReturnValue(
      asStream([{data: '{bad remainder}'}]),
    );

    await expect(
      collect(
        client.streamQuery({userId: 'u1', sessionId: 's1', message: 'Hi'}),
      ),
    ).rejects.toThrow('Failed to parse stream fragment: {bad remainder}');
  });
});

describe('parseStream (defensive chunk handling)', () => {
  it('yields a non-.data object chunk as-is and skips null/primitive chunks', async () => {
    const decoded = {author: 'agent', content: {parts: []}};
    const events: unknown[] = [];
    for await (const event of parseStream(asStream([null, 42, decoded]))) {
      events.push(event);
    }
    expect(events).toEqual([decoded]);
  });
});
