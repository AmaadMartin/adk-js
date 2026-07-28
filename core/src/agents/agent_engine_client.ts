/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {protos, v1} from '@google-cloud/aiplatform';
import {Content} from '@google/genai';

import {Event, transformToCamelCaseEvent} from '../events/event.js';
import {experimental} from '../utils/experimental.js';

const AI_PLATFORM_ENDPOINT_SUFFIX = 'aiplatform.googleapis.com';

/**
 * `@google-cloud/aiplatform` ships heavy native gRPC bindings, so it is loaded
 * lazily (on first use) rather than at import time. This keeps `import
 * '@google/adk'` cheap for consumers that never touch the Agent Engine client,
 * mirroring how the DB session service dynamically imports its drivers.
 */
type AiPlatformModule = typeof import('@google-cloud/aiplatform');
type AiPlatformHelpers = AiPlatformModule['helpers'];

let aiPlatformPromise: Promise<AiPlatformModule> | undefined;

function loadAiPlatform(): Promise<AiPlatformModule> {
  aiPlatformPromise ??= import('@google-cloud/aiplatform');
  return aiPlatformPromise;
}

/** Class method invoked on the deployed engine to create/reuse a session. */
const CREATE_SESSION_METHOD = 'async_create_session';

/** Class method invoked on the deployed engine to stream a query. */
const STREAM_QUERY_METHOD = 'async_stream_query';

/** Class method invoked on the deployed engine to get a session. */
const GET_SESSION_METHOD = 'async_get_session';

/** Class method invoked on the deployed engine to list sessions. */
const LIST_SESSIONS_METHOD = 'async_list_sessions';

/** Class method invoked on the deployed engine to delete a session. */
const DELETE_SESSION_METHOD = 'async_delete_session';

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

/** Parameters for {@link AgentEngineClient.getSession}. */
export interface GetSessionOptions {
  userId: string;
  sessionId: string;
}

/** Parameters for {@link AgentEngineClient.listSessions}. */
export interface ListSessionsOptions {
  userId: string;
}

/** Parameters for {@link AgentEngineClient.deleteSession}. */
export interface DeleteSessionOptions {
  userId: string;
  sessionId: string;
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
  helpers: AiPlatformHelpers,
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
 * Decodes a reasoning-engine `response.output` Value to a plain object, treating
 * an absent or non-struct output (e.g. a null Value the engine returns for a
 * missing session or empty result) as "no value" rather than an error. The
 * shared `helpers.fromValue` only accepts struct Values and throws otherwise, so
 * this guards the struct shape before delegating the decode to it.
 */
function decodeOutput(
  helpers: AiPlatformHelpers,
  output: unknown,
): Record<string, unknown> | undefined {
  const value = output as {structValue?: {fields?: unknown}} | null | undefined;
  if (!value?.structValue?.fields) {
    return undefined;
  }
  return helpers.fromValue(
    output as Parameters<typeof helpers.fromValue>[0],
  ) as Record<string, unknown>;
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
interface Transport {
  client: v1.ReasoningEngineExecutionServiceClient;
  path: string;
  helpers: AiPlatformHelpers;
}

@experimental
export class AgentEngineClient {
  private readonly config: AgentEngineConfig;
  private transport?: Transport;

  constructor(config: AgentEngineConfig) {
    this.config = config;
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
   * Lazily loads `@google-cloud/aiplatform` and creates (once) the transport
   * client and derived resource path.
   */
  private async init(): Promise<Transport> {
    if (!this.transport) {
      const {v1, helpers} = await loadAiPlatform();
      const client = new v1.ReasoningEngineExecutionServiceClient({
        apiEndpoint: `${this.config.location}-${AI_PLATFORM_ENDPOINT_SUFFIX}`,
      });
      const path = client.reasoningEnginePath(
        this.config.project,
        this.config.location,
        this.config.reasoningEngineId,
      );
      this.transport = {client, path, helpers};
    }
    return this.transport;
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
      const {client, path, helpers} = await this.init();
      const input: Record<string, unknown> = {
        user_id: config.userId,
        ...(config.sessionId ? {session_id: config.sessionId} : {}),
      };
      const [response] = await client.queryReasoningEngine({
        name: path,
        classMethod: CREATE_SESSION_METHOD,
        input: buildInputStruct(helpers, input),
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
   * Fetches a session for the given user.
   *
   * @returns the session, or `undefined` when the engine reports no session.
   * @throws {AgentExecutionError} when the underlying call fails.
   */
  async getSession(
    config: GetSessionOptions,
  ): Promise<AgentEngineSession | undefined> {
    try {
      const {client, path, helpers} = await this.init();
      const [response] = await client.queryReasoningEngine({
        name: path,
        classMethod: GET_SESSION_METHOD,
        input: buildInputStruct(helpers, {
          user_id: config.userId,
          session_id: config.sessionId,
        }),
      });
      const decoded = decodeOutput(helpers, response.output);
      return decoded ? toSessionResult(decoded) : undefined;
    } catch (error) {
      throw new AgentExecutionError(
        `Failed to get session: ${errorMessage(error)}`,
        error,
      );
    }
  }

  /**
   * Lists the sessions for the given user.
   *
   * @throws {AgentExecutionError} when the underlying call fails.
   */
  async listSessions(
    config: ListSessionsOptions,
  ): Promise<AgentEngineSession[]> {
    try {
      const {client, path, helpers} = await this.init();
      const [response] = await client.queryReasoningEngine({
        name: path,
        classMethod: LIST_SESSIONS_METHOD,
        input: buildInputStruct(helpers, {user_id: config.userId}),
      });
      const decoded = decodeOutput(helpers, response.output) as
        | {sessions?: Array<Record<string, unknown>>}
        | undefined;
      return (decoded?.sessions ?? []).map(toSessionResult);
    } catch (error) {
      throw new AgentExecutionError(
        `Failed to list sessions: ${errorMessage(error)}`,
        error,
      );
    }
  }

  /**
   * Deletes a session for the given user.
   *
   * @throws {AgentExecutionError} when the underlying call fails.
   */
  async deleteSession(config: DeleteSessionOptions): Promise<void> {
    try {
      const {client, path, helpers} = await this.init();
      await client.queryReasoningEngine({
        name: path,
        classMethod: DELETE_SESSION_METHOD,
        input: buildInputStruct(helpers, {
          user_id: config.userId,
          session_id: config.sessionId,
        }),
      });
    } catch (error) {
      throw new AgentExecutionError(
        `Failed to delete session: ${errorMessage(error)}`,
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
      const {client, path, helpers} = await this.init();
      // A string prompt is passed through; a Content message is serialized to
      // the genai JSON wire shape, dropping undefined fields (parity with the
      // Python reference's model_dump(exclude_none=True)) since the Struct
      // encoder cannot represent `undefined`.
      const message =
        typeof config.message === 'string'
          ? config.message
          : (JSON.parse(JSON.stringify(config.message)) as Record<
              string,
              unknown
            >);
      stream = client.streamQueryReasoningEngine({
        name: path,
        classMethod: STREAM_QUERY_METHOD,
        input: buildInputStruct(helpers, {
          user_id: config.userId,
          session_id: config.sessionId,
          message,
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
