/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {helpers, protos, v1} from '@google-cloud/aiplatform';
import {Content} from '@google/genai';

import {Event, transformToCamelCaseEvent} from '../events/event.js';
import {experimental} from '../utils/experimental.js';

const AI_PLATFORM_ENDPOINT_SUFFIX = 'aiplatform.googleapis.com';

/** Class method invoked on the deployed engine to create/reuse a session. */
const CREATE_SESSION_METHOD = 'async_create_session';

/** Class method invoked on the deployed engine to stream a query. */
const STREAM_QUERY_METHOD = 'async_stream_query';

/**
 * Full reasoning-engine resource name, e.g.
 * `projects/{project}/locations/{location}/reasoningEngines/{id}`.
 */
const REASONING_ENGINE_NAME_PATTERN =
  /^projects\/([a-zA-Z0-9-_]+)\/locations\/([a-zA-Z0-9-_]+)\/reasoningEngines\/(\d+)$/;

/** Identifies a deployed Vertex AI Agent Engine (reasoning engine). */
export interface AgentEngineConfig {
  project: string;
  location: string;
  reasoningEngineId: string;
}

/** Parameters for {@link AgentEngineClient.createSession}. */
export interface CreateSessionConfig {
  userId: string;
  /**
   * Optional caller-provided session id. When supplied the engine reuses the
   * session; when omitted the engine allocates a new one. Useful for
   * human-in-the-loop apps that need stable session ids.
   */
  sessionId?: string;
}

/** Parameters for {@link AgentEngineClient.streamQuery}. */
export interface StreamQueryConfig {
  userId: string;
  sessionId: string;
  /** A plain text prompt or a structured `Content` message. */
  message: Content | string;
}

/**
 * The session returned by {@link AgentEngineClient.createSession}: a camelCased
 * subset of the engine's session object.
 */
export interface AgentEngineSession {
  id: string;
  userId?: string;
  state?: Record<string, unknown>;
  lastUpdateTime?: number;
}

/** Thrown when an underlying reasoning-engine call or stream parse fails. */
export class AgentExecutionError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'AgentExecutionError';
  }
}

/**
 * Parses a full reasoning-engine resource name into its components.
 *
 * @throws {Error} when `name` is not a valid ReasoningEngine resource name.
 */
export function parseEngineName(name: string): AgentEngineConfig {
  const match = name.match(REASONING_ENGINE_NAME_PATTERN);
  if (!match) {
    throw new Error(
      `${name} is not a valid ReasoningEngine resource name. It should match ` +
        `projects/{project}/locations/{location}/reasoningEngines/{id}.`,
    );
  }
  return {project: match[1], location: match[2], reasoningEngineId: match[3]};
}

/**
 * Encodes a plain snake_case input object as the `google.protobuf.Struct`
 * expected by the reasoning-engine RPCs. Callers never construct a Struct.
 */
export function buildInputStruct(
  input: Record<string, unknown> | undefined,
): protos.google.protobuf.IStruct | undefined {
  if (!input) {
    return undefined;
  }
  // toValue wraps the object as a Value with a `structValue`; the RPC `input`
  // field wants the IStruct, so unwrap it.
  return (
    helpers.toValue(input) as {structValue?: protos.google.protobuf.IStruct}
  ).structValue;
}

/** Maps a decoded snake_case session object to an {@link AgentEngineSession}. */
export function toSessionResult(
  raw: Record<string, unknown>,
): AgentEngineSession {
  return {
    id: (raw['id'] as string | undefined) ?? '',
    userId: raw['user_id'] as string | undefined,
    state: raw['state'] as Record<string, unknown> | undefined,
    lastUpdateTime: raw['last_update_time'] as number | undefined,
  };
}

/**
 * Parses a single stream line/fragment into an {@link Event}.
 *
 * Strips an optional `data:`/`data: ` SSE prefix, skips blank lines and the
 * `[DONE]` sentinel, and camelCases the decoded snake_case event.
 *
 * @throws {AgentExecutionError} when the fragment is not valid JSON.
 */
function parseFragment(line: string): Event | undefined {
  let payload = line;
  if (payload.startsWith('data: ')) {
    payload = payload.slice(6);
  } else if (payload.startsWith('data:')) {
    payload = payload.slice(5);
  }
  payload = payload.trim();
  if (!payload || payload === '[DONE]') {
    return undefined;
  }
  try {
    return transformToCamelCaseEvent(
      JSON.parse(payload) as Record<string, unknown>,
    );
  } catch (error) {
    throw new AgentExecutionError(
      `Failed to parse stream fragment: ${payload}`,
      error,
    );
  }
}

/** A streamed chunk carrying newline-delimited JSON / SSE text. */
interface StreamChunk {
  data?: Uint8Array | string | null;
}

/**
 * Parses a reasoning-engine response stream into {@link Event}s.
 *
 * Accumulates text across chunks, splits on newlines, and yields the camelCased
 * form of each JSON event. A final payload emitted without a trailing newline is
 * flushed once the stream ends.
 */
export async function* parseStream(
  stream: AsyncIterable<unknown>,
): AsyncGenerator<Event, void, unknown> {
  let buffer = '';
  for await (const chunk of stream) {
    const data = (chunk as StreamChunk | null | undefined)?.data;
    if (data == null) {
      // Defensive: a non-null object without `.data` is an already-decoded
      // payload; yield it unchanged.
      if (chunk != null && typeof chunk === 'object') {
        yield chunk as Event;
      }
      continue;
    }
    buffer +=
      data instanceof Uint8Array
        ? new TextDecoder().decode(data)
        : String(data);
    const lines = buffer.split('\n');
    // split() always returns at least one element, so pop() is defined; the
    // trailing partial line is carried over to the next chunk.
    buffer = lines.pop()!;
    for (const line of lines) {
      const event = parseFragment(line);
      if (event) {
        yield event;
      }
    }
  }
  const remainder = parseFragment(buffer);
  if (remainder) {
    yield remainder;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function encodeMessage(
  message: Content | string,
): string | Record<string, unknown> {
  if (typeof message === 'string') {
    return message;
  }
  // Serialize to the genai JSON wire shape, dropping undefined fields (parity
  // with the Python reference's `model_dump(exclude_none=True)`), since the
  // Struct encoder cannot represent `undefined`.
  return JSON.parse(JSON.stringify(message)) as Record<string, unknown>;
}

/**
 * An ergonomic, consumer-side client for a deployed Vertex AI Agent Engine
 * (reasoning engine). It mirrors the Python `vertexai` remote surface, hiding
 * all protobuf `Struct` encoding and streamed-response parsing so callers only
 * pass and receive plain typed objects and {@link Event}s.
 *
 * Authentication reuses `@google-cloud/aiplatform`'s built-in Application
 * Default Credentials (ADC); no new transport or auth layer is introduced.
 *
 * @example
 * ```ts
 * import {AgentEngineClient} from '@google/adk';
 *
 * const engine = AgentEngineClient.get(
 *   'projects/my-proj/locations/us-central1/reasoningEngines/12345',
 * );
 * const session = await engine.createSession({userId: 'user_wa_123'});
 * for await (const event of engine.streamQuery({
 *   userId: 'user_wa_123',
 *   sessionId: session.id,
 *   message: 'Hello',
 * })) {
 *   console.log(event.author, event.content);
 * }
 * ```
 */
@experimental
export class AgentEngineClient {
  private readonly client: v1.ReasoningEngineExecutionServiceClient;
  private readonly reasoningEnginePath: string;

  constructor(config: AgentEngineConfig) {
    this.client = new v1.ReasoningEngineExecutionServiceClient({
      apiEndpoint: `${config.location}-${AI_PLATFORM_ENDPOINT_SUFFIX}`,
    });
    this.reasoningEnginePath = this.client.reasoningEnginePath(
      config.project,
      config.location,
      config.reasoningEngineId,
    );
  }

  /**
   * Binds a client to a full reasoning-engine resource name, e.g.
   * `projects/{project}/locations/{location}/reasoningEngines/{id}`.
   *
   * @throws {Error} when `name` is not a valid ReasoningEngine resource name.
   */
  static get(name: string): AgentEngineClient {
    return new AgentEngineClient(parseEngineName(name));
  }

  /**
   * Creates a session (or reuses one when `sessionId` is supplied) on the
   * remote engine.
   *
   * @throws {AgentExecutionError} when the underlying call fails or the response
   *   does not contain a session id.
   */
  async createSession(
    config: CreateSessionConfig,
  ): Promise<AgentEngineSession> {
    try {
      const input: Record<string, unknown> = {
        user_id: config.userId,
        ...(config.sessionId ? {session_id: config.sessionId} : {}),
      };
      const [response] = await this.client.queryReasoningEngine({
        name: this.reasoningEnginePath,
        classMethod: CREATE_SESSION_METHOD,
        input: buildInputStruct(input),
      });
      if (!response.output) {
        throw new Error('the response did not contain a session output.');
      }
      const session = toSessionResult(
        helpers.fromValue(
          response.output as Parameters<typeof helpers.fromValue>[0],
        ) as Record<string, unknown>,
      );
      if (!session.id) {
        throw new Error('the session output did not contain an id.');
      }
      return session;
    } catch (error) {
      throw new AgentExecutionError(
        `Failed to create session: ${errorMessage(error)}`,
        error,
      );
    }
  }

  /**
   * Streams a query against the remote engine, yielding parsed {@link Event}s in
   * arrival order.
   *
   * @throws {AgentExecutionError} when the underlying call fails (surfaced on the
   *   first iteration) or a streamed fragment cannot be parsed.
   */
  async *streamQuery(
    config: StreamQueryConfig,
  ): AsyncGenerator<Event, void, unknown> {
    let stream: AsyncIterable<unknown>;
    try {
      stream = this.client.streamQueryReasoningEngine({
        name: this.reasoningEnginePath,
        classMethod: STREAM_QUERY_METHOD,
        input: buildInputStruct({
          user_id: config.userId,
          session_id: config.sessionId,
          message: encodeMessage(config.message),
        }),
      });
    } catch (error) {
      throw new AgentExecutionError(
        `Failed to execute stream query: ${errorMessage(error)}`,
        error,
      );
    }
    yield* parseStream(stream);
  }
}
