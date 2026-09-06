/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Client} from '@google-cloud/vertexai';
import {Sessions} from '@google-cloud/vertexai/build/src/genai/sessions.js';
import {
  EventActions as ApiEventActions,
  AppendAgentEngineSessionEventConfig,
  AppendAgentEngineSessionEventRequestParameters,
  CreateAgentEngineSessionConfig,
  EventMetadata,
  ListAgentEngineSessionEventsConfig,
  Session as VertexAiSession,
  SessionEvent as VertexAiSessionEvent,
} from '@google-cloud/vertexai/build/src/genai/types.js';
import {
  Content,
  GenerateContentResponseUsageMetadata,
  GroundingMetadata,
  HttpOptions,
} from '@google/genai';
import {ApiClient} from '@google/genai/vertex_internal';
import {isCompactedEvent} from '../events/compacted_event.js';
import {formatError, isNotFoundError} from '../utils/error_utils.js';
import {experimental} from '../utils/experimental.js';

import {AuthConfig} from '../auth/auth_tool.js';
import {NotImplementedError} from '../errors/not_implemented_error.js';
import {Event, NodeInfo, Route} from '../events/event.js';
import {EventActions} from '../events/event_actions.js';
import {ToolConfirmation} from '../tools/tool_confirmation.js';
import {logger} from '../utils/logger.js';
import {sleep} from '../utils/time_utils.js';
import {
  createExpressModeApiClient,
  getExpressModeApiKey,
} from '../utils/vertex_ai_utils.js';

import {partialCopy} from '../utils/partial_copy.js';
import {
  AppendEventRequest,
  BaseSessionService,
  CreateSessionRequest,
  DeleteSessionRequest,
  GetSessionRequest,
  ListSessionsRequest,
  ListSessionsResponse,
  trimTempState,
  validateGetSessionConfig,
} from './base_session_service.js';
import {createSession, Session} from './session.js';
import {decodeModel} from './session_util.js';

const DEFAULT_MAX_ATTEMPTS = 30;
const HTTP_BAD_REQUEST = 400;
const HTTP_TOO_MANY_REQUESTS = 429;

/** Backoff before the single append retry, matching adk-python's 1.0 s sleep. */
const APPEND_RETRY_DELAY_MS = 1000;

/** Interval between polls of the pending create-session operation. */
const CREATE_POLL_INTERVAL_MS = 1000;

/**
 * `eventMetadata.customMetadata` key carrying the workflow fields of an
 * {@link Event} that the Agent Engine sessions API does not model: a node's
 * `output`, `route`, `nodeInfo` and `isolationScope`, plus the
 * `agentState`/`endOfAgent` actions. It is the same escape hatch this service
 * already uses for `_compaction` and `_usage_metadata`.
 *
 * Workflow resume is driven entirely by these fields — `reconstructNodeStates`
 * groups prior events by `nodeInfo.path` and replays their `output`/`route`,
 * and a paused node recovers its input from `actions.agentState` — so an event
 * rebuilt without them makes a resumed run re-execute completed nodes.
 */
const WORKFLOW_CUSTOM_METADATA_KEY = '_workflow';

/** The session IDs the Agent Engine sessions API accepts in a resource name. */
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

/**
 * Checks if the given URI is a Vertex AI session service URI.
 */
export function isVertexAiConnectionString(uri?: string): boolean {
  return uri?.startsWith('vertexai://') || false;
}

/**
 * Returns the short session ID to put in a request path.
 *
 * Extraction runs before validation, because a caller who stored the resource
 * name the API returned
 * (`projects/p/locations/l/reasoningEngines/123/sessions/abc`) may pass it back
 * where a short ID is expected, and validating first would reject every such
 * name.
 *
 * @throws if the name carries a different reasoning engine than the service is
 *     configured for, or if the ID would escape its URL path segment.
 */
export function normalizeSessionId(
  sessionId: string,
  expectedEngineId?: string,
): string {
  const shortId = extractShortSessionId(sessionId, expectedEngineId);
  validateSessionId(shortId);
  return shortId;
}

/**
 * Returns the trailing ID of a session resource name, or `sessionId` unchanged.
 *
 * Interpolating a full resource name into the request path would produce
 * `reasoningEngines/123/sessions/projects/p/...` and a 404.
 */
function extractShortSessionId(
  sessionId: string,
  expectedEngineId?: string,
): string {
  const parts = sessionId.split('/');
  if (parts.at(-2) !== 'sessions') {
    return sessionId;
  }
  const passedEngineId = parts.at(-3);
  if (
    parts.at(-4) === 'reasoningEngines' &&
    expectedEngineId &&
    passedEngineId !== expectedEngineId
  ) {
    throw new Error(
      'Session resource name mismatch: session belongs to reasoningEngine ' +
        `'${passedEngineId}', but service is configured for ` +
        `'${expectedEngineId}'.`,
    );
  }
  return parts[parts.length - 1];
}

/**
 * Rejects a session ID that would escape its URL path segment.
 *
 * @throws if `sessionId` contains anything outside `[A-Za-z0-9_-]`, or is
 *     empty.
 */
export function validateSessionId(sessionId: string): void {
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    throw new Error(
      `Invalid session_id '${sessionId}': must match ` +
        `${SESSION_ID_PATTERN.source}.`,
    );
  }
}

/**
 * Quotes a value for safe use as a Google AIP-160 filter string literal.
 *
 * Backslashes are escaped first, then double quotes, so that caller-controlled
 * input stays inside the quoted value and cannot break out to inject additional
 * filter predicates. See https://google.aip.dev/160.
 */
export function quoteFilterLiteral(value: string): string {
  const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `"${escaped}"`;
}

/**
 * Builds the Agent Engine `Sessions` client from an `ApiClient`.
 *
 * `@google-cloud/vertexai` bundles its own nested copy of `@google/genai`
 * (1.52.0) while the repo root resolves `@google/genai` to 2.9.0, so the
 * `ApiClient` here is a structurally distinct class (its private fields make
 * the two nominally incompatible) from the one `Sessions` declares. The
 * instances are interchangeable at runtime -- the mismatch is a
 * duplicate-dependency artifact, not a real API difference -- so the cast is
 * confined to this one boundary.
 */
function createAgentEngineSessions(apiClient: ApiClient): Sessions {
  return new Sessions(
    apiClient as unknown as ConstructorParameters<typeof Sessions>[0],
  );
}

export interface VertexAiSessionServiceOptions {
  projectId?: string;
  location?: string;
  agentEngineId?: string;
  expressModeApiKey?: string;
  sessions?: Sessions;
  /**
   * HTTP options applied to every Agent Engine request, for a custom endpoint,
   * API version or extra headers.
   *
   * adk-python installs the equivalent override on the client it builds. The
   * `@google-cloud/vertexai` `Client` takes no HTTP options, so this service
   * carries them on each request config instead. The observable effect is the
   * same, and it also reaches requests made through an injected client.
   */
  httpOptions?: HttpOptions;
}

/**
 * The parameters for `VertexAiSessionService.createSession`.
 *
 * Extends the common {@link CreateSessionRequest} with the mutually exclusive
 * session-expiration options supported by Vertex AI Agent Engine Sessions. See
 * https://cloud.google.com/vertex-ai/generative-ai/docs/reference/rest/v1beta1/projects.locations.reasoningEngines.sessions
 */
export interface VertexAiCreateSessionRequest extends CreateSessionRequest {
  /** Lifetime relative to creation, in seconds, e.g. `'7200s'`. */
  ttl?: string;
  /** Absolute RFC 3339 UTC expiration, e.g. `'2025-10-01T00:00:00Z'`. */
  expireTime?: string;
  /** Human-readable name for the session. */
  displayName?: CreateAgentEngineSessionConfig['displayName'];
  /** User-defined labels, for organizing sessions. */
  labels?: CreateAgentEngineSessionConfig['labels'];
  /**
   * Any other Agent Engine create-session config field, such as
   * `waitForCompletion`.
   *
   * `sessionId`, `sessionState`, `ttl`, `expireTime` and `httpOptions` are
   * excluded: each has a dedicated request or constructor field that is
   * validated or filtered before the RPC, and accepting them here would route
   * around that.
   *
   * `displayName` and `labels` stay accepted, because their dedicated fields
   * above pass them straight through. A dedicated field wins when the request
   * sets both.
   */
  apiConfig?: Omit<
    CreateAgentEngineSessionConfig,
    'sessionId' | 'sessionState' | 'ttl' | 'expireTime' | 'httpOptions'
  >;
}

/**
 * A session service implementation that integrates with Vertex AI Agent Engine Sessions.
 */
@experimental
export class VertexAiSessionService extends BaseSessionService {
  private sessions: Sessions;
  private agentEngineId?: string;
  private expressModeApiKey?: string;
  private projectId?: string;
  private location?: string;
  private httpOptions?: HttpOptions;

  constructor(options: VertexAiSessionServiceOptions) {
    super();
    this.agentEngineId = options.agentEngineId;
    this.projectId = options.projectId;
    this.location = options.location;
    this.httpOptions = options.httpOptions;
    this.expressModeApiKey = getExpressModeApiKey(
      this.projectId,
      this.location,
      options.expressModeApiKey,
    );

    // sessions is primarily for testing to inject a mock client.
    this.sessions = options.sessions ?? this.createSessionsClient();
  }

  private createSessionsClient(): Sessions {
    // A project and location keep authenticating with Application Default
    // Credentials even when GOOGLE_API_KEY is set in the environment, rather
    // than silently switching those callers to API-key auth. adk-python
    // prefers the key here.
    if (this.projectId && this.location) {
      const client = new Client({
        project: this.projectId,
        location: this.location,
      });
      return client.agentEnginesInternal.sessions;
    }
    if (this.expressModeApiKey) {
      return createAgentEngineSessions(
        createExpressModeApiClient(this.expressModeApiKey),
      );
    }
    throw new Error('Project ID and Location are required.');
  }

  private getReasoningEngineId(appName: string): string {
    if (this.agentEngineId) {
      return this.agentEngineId;
    }
    if (/^\d+$/.test(appName)) {
      return appName;
    }
    const pattern =
      /^projects\/([a-zA-Z0-9-_]+)\/locations\/([a-zA-Z0-9-_]+)\/reasoningEngines\/(\d+)$/;
    const match = appName.match(pattern);
    if (!match) {
      throw new Error(
        `App name ${appName} is not valid. It should either be the full ReasoningEngine resource name, or the reasoning engine id.`,
      );
    }
    return match[3];
  }

  /**
   * Creates a session on Vertex AI Agent Engine.
   *
   * @throws if both `ttl` and `expireTime` are specified.
   */
  async createSession({
    appName,
    userId,
    state,
    sessionId,
    ttl,
    expireTime,
    displayName,
    labels,
    apiConfig,
  }: VertexAiCreateSessionRequest): Promise<Session> {
    // The API rejects both together; fail before the RPC.
    if (ttl != null && expireTime != null) {
      throw new Error(
        "Cannot specify both 'ttl' and 'expireTime' simultaneously.",
      );
    }

    const reasoningEngineId = this.getReasoningEngineId(appName);
    if (sessionId) {
      sessionId = normalizeSessionId(sessionId, reasoningEngineId);
    }
    const filteredState = state ? trimTempState(state) : undefined;
    let apiResponse = await this.sessions.createInternal({
      name: `reasoningEngines/${reasoningEngineId}`,
      userId: userId,
      config: {
        ...apiConfig,
        ...(filteredState ? {sessionState: filteredState} : {}),
        ...(sessionId ? {sessionId} : {}),
        ...(ttl != null ? {ttl} : {}),
        ...(expireTime != null ? {expireTime} : {}),
        ...(displayName != null ? {displayName} : {}),
        ...(labels != null ? {labels} : {}),
        ...this.httpOptionsConfig().config,
      },
    });

    const operationName = apiResponse.name!;

    let attempts = 0;
    while (!apiResponse.done && attempts < DEFAULT_MAX_ATTEMPTS) {
      const [nextResponse] = await Promise.all([
        this.sessions.getSessionOperationInternal({
          operationName: operationName,
          ...this.httpOptionsConfig(),
        }),
        sleep(CREATE_POLL_INTERVAL_MS),
      ]);
      apiResponse = nextResponse;
      attempts++;
    }

    if (!apiResponse.done) {
      throw new Error(
        `Session creation operation ${operationName} did not complete in time.`,
      );
    }

    const getSessionResponse = apiResponse.response as VertexAiSession;
    const id = getSessionResponse.name?.split('/').pop() || '';

    return createSession({
      id,
      appName,
      userId,
      state: getSessionResponse.sessionState,
      events: [],
      lastUpdateTime: getSessionResponse.updateTime
        ? Date.parse(getSessionResponse.updateTime)
        : Date.now(),
    });
  }

  async getSession({
    appName,
    userId,
    sessionId,
    config,
  }: GetSessionRequest): Promise<Session | undefined> {
    validateGetSessionConfig(config);

    const reasoningEngineId = this.getReasoningEngineId(appName);
    sessionId = normalizeSessionId(sessionId, reasoningEngineId);
    const sessionResourceName = `reasoningEngines/${reasoningEngineId}/sessions/${sessionId}`;

    try {
      let getSessionResponse: VertexAiSession | undefined;
      let eventsIterator: VertexAiSessionEvent[] = [];

      if (config && config.numRecentEvents === 0) {
        getSessionResponse = (await this.sessions.get({
          name: sessionResourceName,
          ...this.httpOptionsConfig(),
        })) as VertexAiSession;
      } else {
        const listConfig: ListAgentEngineSessionEventsConfig = {
          ...this.httpOptionsConfig().config,
        };
        if (config && config.afterTimestamp) {
          listConfig.filter = `timestamp>="${new Date(
            config.afterTimestamp,
          ).toISOString()}"`;
        }

        const [sessionRes, eventsRes] = await Promise.all([
          this.sessions.get({
            name: sessionResourceName,
            ...this.httpOptionsConfig(),
          }),
          this.sessions.events.listInternal({
            name: sessionResourceName,
            config: listConfig,
          }),
        ]);
        getSessionResponse = sessionRes as VertexAiSession;
        eventsIterator =
          (eventsRes as {sessionEvents?: VertexAiSessionEvent[]})
            .sessionEvents || [];
      }

      const sessionObj = getSessionResponse!;

      if (sessionObj.userId !== userId) {
        throw new Error(
          `Session ${sessionId} does not belong to user ${userId}.`,
        );
      }

      const session = createSession({
        id: sessionId,
        appName,
        userId,
        state: sessionObj.sessionState,
        events: [],
        lastUpdateTime: sessionObj.updateTime
          ? Date.parse(sessionObj.updateTime)
          : Date.now(),
      });

      for (const event of eventsIterator) {
        session.events.push(_fromApiEvent(event));
      }

      if (config && config.numRecentEvents) {
        session.events = session.events.slice(-config.numRecentEvents);
      }

      return session;
    } catch (error: unknown) {
      if (isNotFoundError(error)) {
        return undefined;
      }
      logger.error(
        `Error getting session from Vertex AI: ${formatError(error)}`,
      );
      throw error;
    }
  }

  async listSessions({
    appName,
    userId,
    limit,
    offset,
    page,
    order,
  }: ListSessionsRequest): Promise<ListSessionsResponse> {
    const reasoningEngineId = this.getReasoningEngineId(appName);
    const adkSessions: Session[] = [];
    let pageToken: string | undefined = undefined;

    do {
      const response = await this.sessions.listInternal({
        name: `reasoningEngines/${reasoningEngineId}`,
        config: {
          ...(userId ? {filter: `user_id=${quoteFilterLiteral(userId)}`} : {}),
          ...(pageToken ? {pageToken} : {}),
          ...this.httpOptionsConfig().config,
        },
      });

      const sessions =
        (response as {sessions?: VertexAiSession[]}).sessions || [];
      for (const sessionObj of sessions) {
        const id = sessionObj.name?.split('/').pop() || '';
        adkSessions.push(
          createSession({
            id,
            appName,
            userId: sessionObj.userId,
            state: sessionObj.sessionState,
            events: [],
            lastUpdateTime: sessionObj.updateTime
              ? new Date(sessionObj.updateTime).getTime()
              : Date.now(),
          }),
        );
      }
      pageToken = (response as {nextPageToken?: string}).nextPageToken;
    } while (pageToken);

    adkSessions.sort((a, b) => compareSessions(a, b, order === 'desc'));

    if (limit === undefined) {
      const totalItems = adkSessions.length;
      const sliced = offset ? adkSessions.slice(offset) : adkSessions;
      return {
        sessions: sliced,
        page: 1,
        limit: totalItems,
        totalItems,
        totalPages: totalItems === 0 ? 0 : 1,
      };
    }

    const totalItems = adkSessions.length;
    const totalPages = limit === 0 ? 0 : Math.ceil(totalItems / limit);

    let effectiveOffset: number;
    let effectivePage: number;
    if (page !== undefined) {
      effectiveOffset = (page - 1) * limit;
      effectivePage = page;
    } else {
      effectiveOffset = offset ?? 0;
      effectivePage = limit === 0 ? 1 : Math.floor(effectiveOffset / limit) + 1;
    }

    return {
      sessions: adkSessions.slice(effectiveOffset, effectiveOffset + limit),
      page: effectivePage,
      limit,
      totalItems,
      totalPages,
    };
  }

  async deleteSession({
    appName,
    userId,
    sessionId,
  }: DeleteSessionRequest): Promise<void> {
    const reasoningEngineId = this.getReasoningEngineId(appName);
    sessionId = normalizeSessionId(sessionId, reasoningEngineId);

    // A session may only be deleted by the user it belongs to. getSession
    // already enforces this and throws when the stored session's userId does
    // not match, so load the session first and stop if it is missing or not
    // owned by this user. This keeps deleteSession consistent with getSession
    // and with InMemorySessionService.deleteSession.
    const session = await this.getSession({
      appName,
      userId,
      sessionId,
      config: {numRecentEvents: 0},
    });
    if (!session) {
      return;
    }

    try {
      await this.sessions.delete({
        name: `reasoningEngines/${reasoningEngineId}/sessions/${sessionId}`,
        ...this.httpOptionsConfig(),
      });
    } catch (error: unknown) {
      logger.error(
        `Error deleting session ${sessionId}: ${formatError(error)}`,
      );
      throw error;
    }
  }

  /**
   * Not supported by the Vertex AI Agent Engine backend.
   *
   * The API does not expose user state independently of a session. To read
   * user state, enumerate sessions via {@link listSessions} and call
   * {@link getSession} on each result to access the merged state.
   *
   * @throws always.
   */
  async getUserState(_request: {
    appName: string;
    userId: string;
  }): Promise<Record<string, unknown>> {
    throw new NotImplementedError(
      'VertexAiSessionService does not support getUserState. The Vertex AI ' +
        'Agent Engine API does not expose user state independently of a ' +
        'session. To read user state, enumerate sessions via listSessions ' +
        'and call getSession on each result.',
    );
  }

  override async appendEvent({
    session,
    event,
  }: AppendEventRequest): Promise<Event> {
    await super.appendEvent({session, event});
    validateSessionId(session.id);
    session.lastUpdateTime = event.timestamp;

    const reasoningEngineId = this.getReasoningEngineId(session.appName);

    const customMetadata: Record<string, unknown> = {...event.customMetadata};
    if (isCompactedEvent(event)) {
      customMetadata._compaction = {
        startTime: event.startTime,
        endTime: event.endTime,
        compactedContent: event.compactedContent,
      };
    }
    if (event.usageMetadata) {
      customMetadata._usage_metadata = event.usageMetadata;
    }
    const workflowMetadata = toWorkflowMetadata(event);
    if (workflowMetadata) {
      customMetadata[WORKFLOW_CUSTOM_METADATA_KEY] = workflowMetadata;
    }

    const config = partialCopy<AppendAgentEngineSessionEventConfig>(event, [
      'errorCode',
      'errorMessage',
    ]);
    config.actions = toApiActions(event.actions);

    // Strip Part fields the Sessions API rejects (e.g. `partMetadata`) from
    // both the wire content and the `rawEvent` blob it is stored under, so the
    // append is not rejected with 400 INVALID_ARGUMENT.
    const content = dropUnsupportedPartFields(event.content);
    config.content = content;

    config.eventMetadata = {
      ...partialCopy<EventMetadata>(event, [
        'partial',
        'turnComplete',
        'interrupted',
        'branch',
        'longRunningToolIds',
        'groundingMetadata',
      ]),
      customMetadata:
        Object.keys(customMetadata).length > 0 ? customMetadata : undefined,
    };

    config.rawEvent = JSON.parse(JSON.stringify({...event, content})) as Record<
      string,
      unknown
    >;

    Object.assign(config, this.httpOptionsConfig().config);

    const params: AppendAgentEngineSessionEventRequestParameters = {
      name: `reasoningEngines/${reasoningEngineId}/sessions/${session.id}`,
      author: event.author || 'user',
      invocationId: event.invocationId || `inv-${Date.now()}`,
      timestamp: new Date(event.timestamp).toISOString(),
      config,
    };

    try {
      await appendWithRateLimitRetry(this.sessions, params);
    } catch (error) {
      // Only a rejected payload (400) is safe to retry without `rawEvent`. Any
      // other failure may already have persisted the event, so re-appending
      // would duplicate it; let it propagate.
      if (!isInvalidArgumentError(error)) {
        throw error;
      }
      logger.warn(
        'Failed to append event with rawEvent; retrying without it. The event ' +
          'will be reconstructed from its structured fields and ' +
          'customMetadata on read.',
        error,
      );
      delete config.rawEvent;
      await appendWithRateLimitRetry(this.sessions, params);
    }

    return event;
  }

  /**
   * This service's HTTP options as a request `config`, or nothing when it has
   * none, so requests then go out unchanged.
   *
   * Call sites that build a config of their own spread `.config` into it; the
   * two that carry no other fields spread the whole result, which omits the
   * `config` key entirely.
   */
  private httpOptionsConfig(): {config?: {httpOptions: HttpOptions}} {
    return this.httpOptions ? {config: {httpOptions: this.httpOptions}} : {};
  }
}

/**
 * True when the service rejected the request for exceeding its quota, which is
 * transient and safe to retry.
 *
 * Matched structurally on `status` and `code`, for the reason given in
 * getSession's catch.
 */
function isRateLimitError(error: unknown): boolean {
  const err = error as {code?: number; status?: number} | null;
  return (
    err?.status === HTTP_TOO_MANY_REQUESTS ||
    err?.code === HTTP_TOO_MANY_REQUESTS
  );
}

/**
 * Appends an event, retrying once after {@link APPEND_RETRY_DELAY_MS} when the
 * service answers 429.
 *
 * Only a quota rejection is retried: any other failure may already have
 * persisted the event, so re-appending would store it twice. The delay runs on
 * the failure path only, so a successful append is never slowed down.
 */
async function appendWithRateLimitRetry(
  sessions: Sessions,
  params: AppendAgentEngineSessionEventRequestParameters,
): Promise<void> {
  try {
    await sessions.events.append(params);
  } catch (error: unknown) {
    if (!isRateLimitError(error)) {
      throw error;
    }
    await sleep(APPEND_RETRY_DELAY_MS);
    await sessions.events.append(params);
  }
}

/**
 * Orders two sessions by last update time, then userId, then id.
 *
 * The API returns sessions in no guaranteed order, and a paged list has no
 * order at all across its pages, so listSessions applies this even when the
 * caller asked for none. It is adk-python's
 * `key=lambda s: (s.last_update_time, s.user_id, s.id)`. `descending` reverses
 * the time comparison only, leaving the tie-break ascending.
 */
function compareSessions(a: Session, b: Session, descending: boolean): number {
  const byTime = descending
    ? b.lastUpdateTime - a.lastUpdateTime
    : a.lastUpdateTime - b.lastUpdateTime;
  return byTime || a.userId.localeCompare(b.userId) || a.id.localeCompare(b.id);
}

interface WorkflowEventMetadata {
  output?: unknown;
  route?: Route;
  nodeInfo?: NodeInfo;
  isolationScope?: string;
  agentState?: Record<string, unknown>;
  endOfAgent?: boolean;
}

function toWorkflowMetadata(event: Event): WorkflowEventMetadata | undefined {
  const metadata: WorkflowEventMetadata = {};
  if (event.output !== undefined) {
    metadata.output = event.output;
  }
  if (event.route !== undefined) {
    metadata.route = event.route;
  }
  if (event.nodeInfo !== undefined) {
    metadata.nodeInfo = event.nodeInfo;
  }
  if (event.isolationScope !== undefined) {
    metadata.isolationScope = event.isolationScope;
  }
  if (event.actions?.agentState !== undefined) {
    metadata.agentState = event.actions.agentState;
  }
  if (event.actions?.endOfAgent !== undefined) {
    metadata.endOfAgent = event.actions.endOfAgent;
  }
  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

function applyWorkflowMetadata(
  event: Event,
  metadata: WorkflowEventMetadata,
): void {
  if (metadata.output !== undefined) {
    event.output = metadata.output;
  }
  if (metadata.route !== undefined) {
    event.route = metadata.route;
  }
  if (metadata.nodeInfo !== undefined) {
    event.nodeInfo = metadata.nodeInfo;
  }
  if (metadata.isolationScope !== undefined) {
    event.isolationScope = metadata.isolationScope;
  }
  if (metadata.agentState !== undefined) {
    event.actions.agentState = metadata.agentState;
  }
  if (metadata.endOfAgent !== undefined) {
    event.actions.endOfAgent = metadata.endOfAgent;
  }
}

/**
 * Renames `transferToAgent` to the `transferAgent` the Agent Engine sessions
 * API actually defines, mirroring what `_fromApiEvent` reads back and what
 * adk-python writes. Returns a new object: `partialCopy` is shallow, so
 * rewriting the event's own `actions` in place would mutate the caller's event.
 */
function toApiActions(
  actions: EventActions | undefined,
): ApiEventActions | undefined {
  if (!actions) {
    return undefined;
  }
  const {transferToAgent, ...rest} = actions;
  return {
    ...rest,
    ...(transferToAgent !== undefined ? {transferAgent: transferToAgent} : {}),
  } as ApiEventActions;
}

/**
 * Returns a copy of `content` without Part fields the Agent Engine Sessions
 * API rejects, passing `undefined` through unchanged.
 *
 * `partMetadata` is a Gemini Developer API-only field; the Sessions API fails
 * appendEvent with 400 INVALID_ARGUMENT ("Unknown name \"part_metadata\"").
 * The input is never mutated, so the caller's event keeps its metadata.
 */
function dropUnsupportedPartFields(
  content: Content | undefined,
): Content | undefined {
  if (!content?.parts) {
    return content;
  }
  return {
    ...content,
    parts: content.parts.map((part) => {
      const copy = {...part};
      delete copy.partMetadata;
      return copy;
    }),
  };
}

/**
 * True when the service rejected the request payload itself, which is what an
 * API that does not know `rawEvent` returns. Any other failure must propagate:
 * the event may already be persisted, so retrying would append it twice.
 *
 * Matched structurally on the `ApiError`'s `status`, for the reason given in
 * getSession's catch.
 */
function isInvalidArgumentError(error: unknown): boolean {
  return (error as {status?: number} | null)?.status === HTTP_BAD_REQUEST;
}

interface ExtendedEvent extends Event {
  isCompacted?: boolean;
  startTime?: number;
  endTime?: number;
  compactedContent?: string;
}

/**
 * The wire form of a session event also carries `raw_event`, the snake_case
 * spelling of `rawEvent`, which the SDK type does not model.
 */
interface ApiSessionEventWithRawAlias extends VertexAiSessionEvent {
  raw_event?: unknown;
}

/**
 * Returns the stored `rawEvent` payload, or undefined when there is nothing
 * usable to rebuild an event from.
 *
 * An empty object counts as nothing: taking the rawEvent branch for it would
 * produce an event with no author, content or actions, where the legacy
 * top-level fields still hold all three.
 */
function getRawEvent(
  apiEventObj: ApiSessionEventWithRawAlias,
): Record<string, unknown> | undefined {
  const rawEvent = decodeModel<Record<string, unknown>>(
    apiEventObj.rawEvent ?? apiEventObj.raw_event,
  );
  return rawEvent && Object.keys(rawEvent).length > 0 ? rawEvent : undefined;
}

function _fromApiEvent(apiEventObj: VertexAiSessionEvent): Event {
  const rawEvent = getRawEvent(apiEventObj);
  if (rawEvent) {
    const event = JSON.parse(JSON.stringify(rawEvent)) as Event;
    // Callers correlate a streamed event with its reloaded form by id, so keep
    // the id the event was created with. The server-assigned resource id is
    // only a fallback for a stored payload that lacks one.
    if (!event.id) {
      event.id = apiEventObj.name?.split('/').pop() || '';
    }
    event.invocationId = apiEventObj.invocationId || '';
    event.author = apiEventObj.author;
    if (apiEventObj.timestamp) {
      event.timestamp = new Date(apiEventObj.timestamp).getTime();
    }
    return event;
  }

  const actions = apiEventObj.actions || {};
  const eventMetadata = apiEventObj.eventMetadata || {};

  let customMetadata = eventMetadata.customMetadata as
    | Record<string, unknown>
    | undefined;
  let compactionData: {
    startTime: number;
    endTime: number;
    compactedContent: string;
  } | null = null;
  let usageMetadataData = null;
  let workflowData: WorkflowEventMetadata | undefined;

  if (customMetadata) {
    customMetadata = {...customMetadata};
    if (customMetadata._compaction) {
      compactionData = customMetadata._compaction as {
        startTime: number;
        endTime: number;
        compactedContent: string;
      };
      delete customMetadata._compaction;
    }
    if (customMetadata._usage_metadata) {
      usageMetadataData = customMetadata._usage_metadata;
      delete customMetadata._usage_metadata;
    }
    if (customMetadata[WORKFLOW_CUSTOM_METADATA_KEY]) {
      workflowData = customMetadata[
        WORKFLOW_CUSTOM_METADATA_KEY
      ] as WorkflowEventMetadata;
      delete customMetadata[WORKFLOW_CUSTOM_METADATA_KEY];
    }
    if (Object.keys(customMetadata).length === 0) {
      customMetadata = undefined;
    }
  }

  const eventActions: EventActions = {
    stateDelta: (actions['stateDelta'] as {[key: string]: unknown}) || {},
    artifactDelta: (actions['artifactDelta'] as {[key: string]: number}) || {},
    requestedAuthConfigs:
      (actions.requestedAuthConfigs as Record<string, AuthConfig>) || {},
    requestedToolConfirmations:
      ((actions as Record<string, unknown>)[
        'requestedToolConfirmations'
      ] as Record<string, ToolConfirmation>) || {},
    skipSummarization: actions['skipSummarization'] as boolean | undefined,
    // Earlier adk-js versions copied `event.actions` onto the request
    // verbatim, so sessions they wrote store ADK's own `transferToAgent` key.
    transferToAgent: (actions['transferAgent'] ??
      (actions as Record<string, unknown>)['transferToAgent']) as
      | string
      | undefined,
    escalate: actions['escalate'] as boolean | undefined,
  };

  const event: ExtendedEvent = {
    id: apiEventObj.name?.split('/').pop() || '',
    invocationId: apiEventObj.invocationId || '',
    author: apiEventObj.author,
    actions: eventActions,
    content: decodeModel<Content>(apiEventObj.content),
    timestamp: apiEventObj.timestamp
      ? new Date(apiEventObj.timestamp).getTime()
      : Date.now(),
    errorCode: apiEventObj.errorCode?.toString(),
    errorMessage: apiEventObj.errorMessage,
    partial: eventMetadata['partial'] as boolean | undefined,
    turnComplete: eventMetadata['turnComplete'] as boolean | undefined,
    interrupted: eventMetadata['interrupted'] as boolean | undefined,
    branch: eventMetadata['branch'] as string | undefined,
    customMetadata,
    longRunningToolIds: eventMetadata['longRunningToolIds'] as
      | string[]
      | undefined,
    groundingMetadata: decodeModel<GroundingMetadata>(
      eventMetadata['groundingMetadata'],
    ),
    usageMetadata:
      usageMetadataData as unknown as GenerateContentResponseUsageMetadata,
  };

  if (compactionData) {
    event.isCompacted = true;
    event.startTime = compactionData.startTime;
    event.endTime = compactionData.endTime;
    event.compactedContent = compactionData.compactedContent;
  }

  if (workflowData) {
    applyWorkflowMetadata(event, workflowData);
  }

  return event;
}
