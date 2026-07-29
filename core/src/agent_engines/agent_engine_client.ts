/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Content, createUserContent} from '@google/genai';
import {GoogleAuth} from 'google-auth-library';
import {getClientLabels} from '../utils/client_labels.js';
import {experimental} from '../utils/experimental.js';
import {logger} from '../utils/logger.js';

const REASONING_ENGINE_NAME_PATTERN =
  /^projects\/([a-zA-Z0-9-_]+)\/locations\/([a-zA-Z0-9-_]+)\/reasoningEngines\/(\d+)$/;
const SSE_DATA_PREFIX = 'data: ';

/** Options identifying a deployed Agent Engine. */
export interface AgentEngineClientOptions {
  /**
   * Full resource name,
   * `projects/{project}/locations/{location}/reasoningEngines/{id}`.
   * When set, `projectId`, `location` and `reasoningEngineId` are derived from
   * it and any values passed alongside it are ignored.
   */
  name?: string;
  /** Defaults to the `GOOGLE_CLOUD_PROJECT` environment variable. */
  projectId?: string;
  /**
   * Defaults to the `GOOGLE_CLOUD_LOCATION` environment variable, then
   * `us-central1`.
   */
  location?: string;
  /** Numeric id of the deployed reasoning engine. */
  reasoningEngineId?: string;
  /**
   * Credentials to authenticate with. Defaults to Application Default
   * Credentials scoped to `cloud-platform`.
   */
  auth?: GoogleAuth;
}

/**
 * A session as returned by the deployed app.
 *
 * Keys are the ones the remote Python app emits (`Session.model_dump`), i.e.
 * snake_case, and the payload is returned untouched so that caller-defined keys
 * inside `state` and `events` are preserved exactly.
 */
export interface AgentEngineSession {
  id: string;
  app_name?: string;
  user_id?: string;
  state?: Record<string, unknown>;
  events?: AgentEngineEvent[];
  last_update_time?: number;
  [key: string]: unknown;
}

/**
 * One event yielded by {@link AgentEngineClient.streamQuery}, exactly as the
 * deployed app emitted it (`Event.model_dump_json(exclude_none=True)`), so keys
 * are snake_case and `content` holds a `google.genai` `Content` in that same
 * snake_case JSON form.
 */
export interface AgentEngineEvent {
  id?: string;
  invocation_id?: string;
  author?: string;
  content?: Record<string, unknown>;
  partial?: boolean;
  turn_complete?: boolean;
  error_code?: string;
  error_message?: string;
  timestamp?: number;
  [key: string]: unknown;
}

/** Arguments for {@link AgentEngineClient.createSession}. */
export interface CreateAgentEngineSessionRequest {
  userId: string;
  /** Optional caller-supplied id; useful for apps that resume a thread. */
  sessionId?: string;
  state?: Record<string, unknown>;
}

/**
 * Arguments for {@link AgentEngineClient.getSession} and
 * {@link AgentEngineClient.deleteSession}.
 */
export interface AgentEngineSessionRequest {
  userId: string;
  sessionId: string;
}

/** Arguments for {@link AgentEngineClient.listSessions}. */
export interface ListAgentEngineSessionsRequest {
  userId: string;
}

/** Arguments for {@link AgentEngineClient.streamQuery}. */
export interface AgentEngineStreamQueryRequest {
  /** A plain string is wrapped as `{role: 'user', parts: [{text}]}`. */
  message: string | Content;
  userId: string;
  /** When omitted the remote app creates a session for the turn. */
  sessionId?: string;
  runConfig?: Record<string, unknown>;
}

/** Arguments for {@link AgentEngineClient.query}. */
export interface AgentEngineQueryRequest {
  /** A class method registered on the deployed app. */
  classMethod: string;
  /**
   * Keys must be the remote Python parameter names (snake_case). Keys whose
   * value is `undefined` are dropped when the body is serialized, which is how
   * optional remote parameters are left unset.
   */
  input?: Record<string, unknown>;
}

/** Splits a full Agent Engine resource name into its parts. */
export function parseReasoningEngineName(name: string): {
  projectId: string;
  location: string;
  reasoningEngineId: string;
} {
  const match = name.match(REASONING_ENGINE_NAME_PATTERN);
  if (!match) {
    throw new Error(
      `Invalid Agent Engine resource name: ${name}. Expected ` +
        `projects/{project}/locations/{location}/reasoningEngines/{id}.`,
    );
  }
  return {projectId: match[1], location: match[2], reasoningEngineId: match[3]};
}

/** Returns the Vertex AI endpoint serving the given location. */
export function agentEngineApiEndpoint(location: string): string {
  return location === 'global'
    ? 'https://aiplatform.googleapis.com'
    : `https://${location}-aiplatform.googleapis.com`;
}

function buildNameFromOptions(options: AgentEngineClientOptions): string {
  const projectId = options.projectId || process.env.GOOGLE_CLOUD_PROJECT;
  if (!projectId) {
    throw new Error(
      'Project ID is required. Set projectId or the GOOGLE_CLOUD_PROJECT ' +
        'environment variable.',
    );
  }
  if (!options.reasoningEngineId) {
    throw new Error('reasoningEngineId is required when name is not provided.');
  }
  const location =
    options.location || process.env.GOOGLE_CLOUD_LOCATION || 'us-central1';
  return `projects/${projectId}/locations/${location}/reasoningEngines/${options.reasoningEngineId}`;
}

function parseSsePayload(payload: string): AgentEngineEvent | undefined {
  try {
    return JSON.parse(payload) as AgentEngineEvent;
  } catch {
    // Streamed payloads carry end-user conversation text, so only their size
    // is logged.
    logger.warn(
      `Skipping unparseable Agent Engine stream payload (${payload.length} chars).`,
    );
    return undefined;
  }
}

/**
 * Decodes a server-sent event stream into the events it carries.
 *
 * Events are yielded as they arrive; the stream is never buffered as a whole.
 * A payload that is not valid JSON is logged and skipped.
 */
export async function* parseSseStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<AgentEngineEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const dataLines: string[] = [];
  let buffer = '';
  try {
    for (;;) {
      const {done, value} = await reader.read();
      // The trailing blank line terminates an event that the server did not
      // close with one itself.
      buffer += done
        ? `${decoder.decode()}\n\n`
        : decoder.decode(value, {stream: true});
      const lines = buffer.split('\n');
      // Splitting always yields at least one element; the last one is the
      // start of the next line unless the stream ended.
      buffer = lines.pop()!;
      for (const rawLine of lines) {
        const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
        if (line.startsWith(SSE_DATA_PREFIX)) {
          dataLines.push(line.slice(SSE_DATA_PREFIX.length));
        } else if (line === '' && dataLines.length > 0) {
          const event = parseSsePayload(dataLines.join('\n'));
          dataLines.length = 0;
          if (event) {
            yield event;
          }
        }
      }
      if (done) {
        return;
      }
    }
  } finally {
    // Releases the socket when a consumer abandons the generator early; a
    // no-op once the stream has been read to completion.
    await reader.cancel();
    reader.releaseLock();
  }
}

/**
 * Client for an Agent Engine that is already deployed on Vertex AI.
 *
 * It invokes the class methods of the deployed app, which is what a Python
 * caller gets from `vertexai.Client().agent_engines`. The target reasoning
 * engine must therefore be an ADK app deployment, i.e. one exposing the
 * `async_create_session` / `async_stream_query` class methods.
 *
 * Payloads returned by the remote app are handed back exactly as received.
 * They are serialized by Python without aliasing, so their keys are snake_case
 * (`app_name`, `last_update_time`, `state_delta`, …); rewriting them would
 * corrupt caller-defined keys nested inside `state` and function-call `args`.
 *
 * This is not a session service: {@link VertexAiSessionService} persists the
 * sessions of a *local* runner in Vertex, whereas this client drives a *remote*
 * agent that runs its own session service.
 *
 * @example
 * ```ts
 * const engine = new AgentEngineClient({reasoningEngineId: '1234567890'});
 * const session = await engine.createSession({userId: 'user-1'});
 * for await (const event of engine.streamQuery({
 *   userId: 'user-1',
 *   sessionId: session.id,
 *   message: 'Hello',
 * })) {
 *   logger.info(event.author);
 * }
 * ```
 */
@experimental
export class AgentEngineClient {
  /** Full resource name of the deployed Agent Engine. */
  readonly name: string;
  readonly projectId: string;
  readonly location: string;
  readonly reasoningEngineId: string;
  private readonly auth: GoogleAuth;
  private readonly baseUrl: string;

  constructor(options: AgentEngineClientOptions) {
    const name = options.name ?? buildNameFromOptions(options);
    const {projectId, location, reasoningEngineId} =
      parseReasoningEngineName(name);
    this.name = name;
    this.projectId = projectId;
    this.location = location;
    this.reasoningEngineId = reasoningEngineId;
    this.auth =
      options.auth ??
      new GoogleAuth({
        scopes: ['https://www.googleapis.com/auth/cloud-platform'],
      });
    // v1beta1 is the version `vertexai.Client()` targets, and it carries the
    // same :query and :streamQuery bindings as v1.
    this.baseUrl = `${agentEngineApiEndpoint(location)}/v1beta1`;
  }

  /** Returns the deployed `ReasoningEngine` resource. */
  async getEngine(): Promise<Record<string, unknown>> {
    const response = await this.request('GET', this.name);
    return (await response.json()) as Record<string, unknown>;
  }

  /**
   * Invokes any class method registered on the deployed app and returns its
   * output, e.g. `async_search_memory` or an app-specific method.
   */
  async query<T = unknown>(request: AgentEngineQueryRequest): Promise<T> {
    const response = await this.request('POST', `${this.name}:query`, {
      classMethod: request.classMethod,
      input: request.input ?? {},
    });
    const {output} = (await response.json()) as {output: T};
    return output;
  }

  /** Creates a session owned by the deployed app. */
  async createSession(
    request: CreateAgentEngineSessionRequest,
  ): Promise<AgentEngineSession> {
    return this.query<AgentEngineSession>({
      classMethod: 'async_create_session',
      input: {
        user_id: request.userId,
        session_id: request.sessionId,
        state: request.state,
      },
    });
  }

  /** Returns a session, or `undefined` when the app does not have it. */
  async getSession(
    request: AgentEngineSessionRequest,
  ): Promise<AgentEngineSession | undefined> {
    const session = await this.query<AgentEngineSession | null>({
      classMethod: 'async_get_session',
      input: {user_id: request.userId, session_id: request.sessionId},
    });
    return session ?? undefined;
  }

  /** Lists the sessions the deployed app holds for a user. */
  async listSessions(
    request: ListAgentEngineSessionsRequest,
  ): Promise<AgentEngineSession[]> {
    const output = await this.query<{sessions?: AgentEngineSession[]} | null>({
      classMethod: 'async_list_sessions',
      input: {user_id: request.userId},
    });
    return output?.sessions ?? [];
  }

  /** Deletes a session from the deployed app. */
  async deleteSession(request: AgentEngineSessionRequest): Promise<void> {
    await this.query({
      classMethod: 'async_delete_session',
      input: {user_id: request.userId, session_id: request.sessionId},
    });
  }

  /**
   * Runs a turn against the deployed app and yields its events as they arrive.
   *
   * Unlike the Python client, a streamed payload that is not valid JSON is
   * logged and skipped rather than yielded as a raw string, so that every
   * yielded value really is an {@link AgentEngineEvent}.
   */
  async *streamQuery(
    request: AgentEngineStreamQueryRequest,
  ): AsyncGenerator<AgentEngineEvent> {
    const response = await this.request(
      'POST',
      `${this.name}:streamQuery?alt=sse`,
      {
        classMethod: 'async_stream_query',
        input: {
          message:
            typeof request.message === 'string'
              ? createUserContent(request.message)
              : request.message,
          user_id: request.userId,
          session_id: request.sessionId,
          run_config: request.runConfig,
        },
      },
    );
    if (response.body) {
      yield* parseSseStream(response.body);
    }
  }

  private async request(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Response> {
    const url = `${this.baseUrl}/${path}`;
    const authClient = await this.auth.getClient();
    const headers = await authClient.getRequestHeaders(url);
    const labels = getClientLabels().join(' ');
    headers.set('x-goog-api-client', labels);
    headers.set('user-agent', labels);
    if (body !== undefined) {
      headers.set('Content-Type', 'application/json');
    }
    logger.debug(`Agent Engine request: ${method} ${url}`);
    const response = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) {
      throw new Error(
        `Agent Engine request to ${url} failed with status ` +
          `${response.status}: ${await response.text()}`,
      );
    }
    return response;
  }
}
