/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Event,
  transformToCamelCaseEvent,
  transformToSnakeCaseEvent,
} from '../events/event.js';
import {randomUUID} from '../utils/env_aware_utils.js';
import {logger} from '../utils/logger.js';
import {redactUriPassword} from '../utils/redact_uri.js';
import {
  AppendEventRequest,
  BaseSessionService,
  CreateSessionRequest,
  DeleteSessionRequest,
  GetSessionRequest,
  ListSessionsRequest,
  ListSessionsResponse,
  mergeStates,
  paginateSessions,
  splitStateByScope,
} from './base_session_service.js';
import {createSession, Session} from './session.js';
import {State} from './state.js';

/** Hostname used when neither `uri` nor `host` is configured. */
const DEFAULT_HOST = 'localhost';

/** Port used when neither `uri` nor `port` is configured. */
const DEFAULT_PORT = 6379;

/** Redis database index used when `db` is not configured. */
const DEFAULT_DB = 0;

/** Key lifetime used when `ttlSeconds` is not configured: seven days. */
const DEFAULT_TTL_SECONDS = 604800;

/** Prefix applied to every key this service writes. */
const DEFAULT_KEY_PREFIX = 'adk:session:';

/** Thrown when the optional `redis` package is not installed. */
const REDIS_PACKAGE_MISSING_MESSAGE =
  "RedisSessionService requires the 'redis' package. " +
  'Install it with: npm install redis';

/**
 * Redis glob metacharacters. A `userId` of `*` would otherwise widen the
 * `listSessions` scan pattern and match other users' sessions.
 */
const GLOB_METACHARACTERS = /[*?[\]^\\]/g;

/**
 * Options accepted by {@link RedisClientLike.set}.
 *
 * The keys are the uppercase names node-redis uses for the `SET` modifiers.
 */
export interface RedisSetOptions {
  /** Key lifetime in seconds. */
  EX?: number;
  /** Only set the key when it does not already exist. */
  NX?: boolean;
}

/**
 * The subset of a node-redis client that {@link RedisSessionService} uses.
 *
 * Depending on this structural type instead of node-redis's own client type
 * keeps `redis` out of the type graph of every consumer of `@google/adk`, and
 * lets a caller inject any client that provides these four commands.
 *
 * `close` is deliberately absent: the service only ever closes a connection it
 * opened itself, and an injected client belongs to its caller.
 */
export interface RedisClientLike {
  /** Reads a key, resolving to `null` when it is absent or expired. */
  get(key: string): Promise<string | null>;
  /**
   * Writes a key. Resolves to a falsy value when `NX` was requested and the
   * key already existed.
   */
  set(key: string, value: string, options?: RedisSetOptions): Promise<unknown>;
  /** Deletes a key. */
  del(key: string): Promise<unknown>;
  /** Iterates matching keys, yielding one array of keys per `SCAN` batch. */
  scanIterator(options?: {
    MATCH?: string;
    COUNT?: number;
  }): AsyncIterable<string[]>;
}

/** A client this service opened, and is therefore responsible for closing. */
type OwnedRedisClient = RedisClientLike & {close(): Promise<void>};

/**
 * Connection and storage settings for {@link RedisSessionService}.
 *
 * The defaults match `google/adk-python`
 * (`src/google/adk/integrations/redis/_config.py`), so both runtimes address
 * the same keys when they share a Redis instance.
 */
export interface RedisSessionServiceConfig {
  /**
   * Redis connection URI, for example `redis://localhost:6379/0`. Takes
   * precedence over the discrete connection fields below.
   */
  uri?: string;
  /** Redis server hostname. Defaults to `localhost`. */
  host?: string;
  /** Redis server port. Defaults to `6379`. */
  port?: number;
  /** Password for Redis authentication. */
  password?: string;
  /** Whether to connect over TLS. Defaults to `false`. */
  ssl?: boolean;
  /** Redis database index. Defaults to `0`. */
  db?: number;
  /**
   * Lifetime of every key this service writes, in seconds. Defaults to
   * `604800` (seven days). A value of `0` or less disables expiry.
   */
  ttlSeconds?: number;
  /** Prefix for every key this service writes. Defaults to `adk:session:`. */
  keyPrefix?: string;
}

/** Constructor options for {@link RedisSessionService}. */
export interface RedisSessionServiceOptions extends RedisSessionServiceConfig {
  /**
   * An already-connected client to use instead of building one. The caller
   * owns its lifecycle: the service never connects or closes it, and never
   * imports the `redis` package.
   */
  client?: RedisClientLike;
}

/** The snake_case envelope stored under a session key. */
interface StoredSession {
  id: string;
  app_name: string;
  user_id: string;
  state: Record<string, unknown>;
  events: Array<Record<string, unknown>>;
  last_update_time: number;
}

/**
 * Checks whether a URI selects the Redis session service.
 *
 * @param uri The URI to check.
 * @return True for a `redis://` or `rediss://` URI.
 */
export function isRedisConnectionString(uri?: string): boolean {
  if (!uri) {
    return false;
  }
  return uri.startsWith('redis://') || uri.startsWith('rediss://');
}

/**
 * Builds the key holding a single session.
 *
 * @param keyPrefix The configured key prefix.
 * @param appName The name of the application.
 * @param userId The ID of the user.
 * @param sessionId The ID of the session.
 * @return The Redis key.
 */
export function sessionKey(
  keyPrefix: string,
  appName: string,
  userId: string,
  sessionId: string,
): string {
  return `${keyPrefix}${appName}:${userId}:${sessionId}`;
}

/**
 * Builds the key holding the user-scoped state shared by one user's sessions.
 *
 * @param keyPrefix The configured key prefix.
 * @param appName The name of the application.
 * @param userId The ID of the user.
 * @return The Redis key.
 */
export function userStateKey(
  keyPrefix: string,
  appName: string,
  userId: string,
): string {
  return `${keyPrefix}user_state:${appName}:${userId}`;
}

/**
 * Builds the key holding the app-scoped state shared by every session.
 *
 * @param keyPrefix The configured key prefix.
 * @param appName The name of the application.
 * @return The Redis key.
 */
export function appStateKey(keyPrefix: string, appName: string): string {
  return `${keyPrefix}app_state:${appName}`;
}

/**
 * Escapes the Redis glob metacharacters in an interpolated pattern segment.
 *
 * @param value The segment to escape.
 * @return The segment, with every metacharacter preceded by a backslash.
 */
export function escapeGlob(value: string): string {
  return value.replace(GLOB_METACHARACTERS, (match) => `\\${match}`);
}

/**
 * Reads a scope-state map out of a raw Redis value.
 *
 * The result is a null-prototype map, for the reason given on `trimTempState`:
 * a stored `__proto__` key must not re-parent the map it is copied into.
 */
function parseStateMap(raw: string | null): Record<string, unknown> {
  return Object.assign(Object.create(null), raw ? JSON.parse(raw) : undefined);
}

/** Whether a parsed JSON value carries every field of a session envelope. */
function isStoredSession(value: unknown): value is StoredSession {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const {id, app_name, user_id, state, events, last_update_time} =
    value as Record<keyof StoredSession, unknown>;
  return (
    typeof id === 'string' &&
    typeof app_name === 'string' &&
    typeof user_id === 'string' &&
    typeof state === 'object' &&
    state !== null &&
    Array.isArray(events) &&
    typeof last_update_time === 'number'
  );
}

/**
 * Reads a session envelope out of a raw Redis value, returning `undefined`
 * when the value is not one. `listSessions` scans by key pattern, so it can
 * reach a key that holds something else entirely.
 */
function parseStoredSession(raw: string): StoredSession | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  return isStoredSession(parsed) ? parsed : undefined;
}

/**
 * Orders sessions by last update time, breaking ties by id in ascending code
 * unit order so that repeated scans of the same key set agree.
 */
function compareSessions(
  a: Session,
  b: Session,
  direction: 'asc' | 'desc',
): number {
  if (a.lastUpdateTime !== b.lastUpdateTime) {
    const delta = a.lastUpdateTime - b.lastUpdateTime;
    return direction === 'asc' ? delta : -delta;
  }
  if (a.id === b.id) {
    return 0;
  }
  return a.id < b.id ? -1 : 1;
}

/**
 * Imports node-redis, builds a client from `config` and connects it.
 *
 * @throws Error when the optional `redis` package is not installed.
 */
async function connectRedisClient(
  config: RedisSessionServiceConfig,
): Promise<OwnedRedisClient> {
  let createClient: typeof import('redis').createClient;
  try {
    ({createClient} = await import('redis'));
  } catch {
    throw new Error(REDIS_PACKAGE_MISSING_MESSAGE);
  }

  const host = config.host ?? DEFAULT_HOST;
  const port = config.port ?? DEFAULT_PORT;
  const client = config.uri
    ? createClient({url: config.uri})
    : createClient({
        socket: config.ssl ? {host, port, tls: true} : {host, port},
        password: config.password,
        database: config.db ?? DEFAULT_DB,
      });

  // node-redis is an EventEmitter, and an `error` event with no listener is
  // rethrown and takes the process down. Attach before connecting.
  const target = config.uri ? redactUriPassword(config.uri) : `${host}:${port}`;
  client.on('error', (error) => {
    logger.error(`Redis client error for ${target}:`, error);
  });

  await client.connect();
  return client;
}

/**
 * A session service that stores sessions, events and state in Redis.
 *
 * Sessions, user-scoped state and app-scoped state live in three separate
 * keys, so that two sessions belonging to one user always observe the same
 * user state:
 *
 * ```
 * {keyPrefix}{appName}:{userId}:{sessionId}
 * {keyPrefix}user_state:{appName}:{userId}
 * {keyPrefix}app_state:{appName}
 * ```
 *
 * The stored payloads are snake_case and the key layout matches
 * `google/adk-python` (`src/google/adk/integrations/redis/`), so both runtimes
 * can share one Redis instance. `lastUpdateTime` is written in milliseconds,
 * which is the adk-js unit throughout; adk-python writes float seconds.
 *
 * Only session-scoped state is stored under the session key. The `app:` and
 * `user:` scopes are merged back in on read, and `temp:` keys are never
 * persisted.
 *
 * Every key this service writes carries the configured TTL, so an abandoned
 * session eventually disappears without a sweeper.
 *
 * The `redis` package is an optional peer dependency, imported lazily the
 * first time this service needs to build a client. Importing `@google/adk`,
 * constructing the service, or injecting an already-connected client never
 * loads it.
 *
 * `listSessions` reads the whole match set before it sorts and paginates,
 * because `SCAN` can neither order nor page server-side. Unlike the other
 * session services it orders by last update time descending when `order` is
 * omitted, since `SCAN` order is otherwise arbitrary and would differ between
 * two calls.
 *
 * @example
 * ```ts
 * const sessionService = new RedisSessionService({
 *   uri: 'redis://localhost:6379/0',
 * });
 * const runner = new Runner({appName: 'my_app', agent, sessionService});
 * ```
 */
export class RedisSessionService extends BaseSessionService {
  private readonly config: RedisSessionServiceConfig;
  private readonly injectedClient?: RedisClientLike;
  private readonly ttlSeconds: number;
  private readonly keyPrefix: string;
  private clientPromise?: Promise<OwnedRedisClient>;

  constructor({client, ...config}: RedisSessionServiceOptions = {}) {
    super();
    this.config = config;
    this.injectedClient = client;
    this.ttlSeconds = config.ttlSeconds ?? DEFAULT_TTL_SECONDS;
    this.keyPrefix = config.keyPrefix ?? DEFAULT_KEY_PREFIX;
  }

  async createSession({
    appName,
    userId,
    state,
    sessionId,
  }: CreateSessionRequest): Promise<Session> {
    const client = await this.getClient();
    const id = sessionId || randomUUID();
    const initialState = state ?? {};
    const {
      appState: appDelta,
      userState: userDelta,
      sessionState,
    } = splitStateByScope(initialState);

    const appKey = appStateKey(this.keyPrefix, appName);
    const userKey = userStateKey(this.keyPrefix, appName, userId);
    const [appRaw, userRaw] = await Promise.all([
      client.get(appKey),
      client.get(userKey),
    ]);
    const appState = parseStateMap(appRaw);
    const userState = parseStateMap(userRaw);

    if (Object.keys(appDelta).length > 0) {
      Object.assign(appState, appDelta);
      await client.set(appKey, JSON.stringify(appState), this.setOptions());
    }
    if (Object.keys(userDelta).length > 0) {
      Object.assign(userState, userDelta);
      await client.set(userKey, JSON.stringify(userState), this.setOptions());
    }

    const lastUpdateTime = Date.now();
    const stored: StoredSession = {
      id,
      app_name: appName,
      user_id: userId,
      state: sessionState,
      events: [],
      last_update_time: lastUpdateTime,
    };
    const created = await client.set(
      sessionKey(this.keyPrefix, appName, userId, id),
      JSON.stringify(stored),
      {...this.setOptions(), NX: true},
    );
    if (!created) {
      throw new Error(`Session with id ${id} already exists.`);
    }

    const mergedState = mergeStates(appState, userState, sessionState);
    for (const [key, value] of Object.entries(initialState)) {
      if (key.startsWith(State.TEMP_PREFIX)) {
        mergedState[key] = value;
      }
    }

    return createSession({
      id,
      appName,
      userId,
      state: mergedState,
      events: [],
      lastUpdateTime,
    });
  }

  async getSession({
    appName,
    userId,
    sessionId,
    config,
  }: GetSessionRequest): Promise<Session | undefined> {
    const client = await this.getClient();
    const [raw, appRaw, userRaw] = await Promise.all([
      client.get(sessionKey(this.keyPrefix, appName, userId, sessionId)),
      client.get(appStateKey(this.keyPrefix, appName)),
      client.get(userStateKey(this.keyPrefix, appName, userId)),
    ]);
    if (!raw) {
      return undefined;
    }
    const stored = parseStoredSession(raw);
    if (!stored) {
      logger.warn(`Ignoring the unreadable session payload for ${sessionId}.`);
      return undefined;
    }

    let events = stored.events.map(transformToCamelCaseEvent);
    if (config) {
      const {numRecentEvents, afterTimestamp} = config;
      if (numRecentEvents !== undefined) {
        events = numRecentEvents > 0 ? events.slice(-numRecentEvents) : [];
      }
      if (afterTimestamp !== undefined) {
        events = events.filter((event) => event.timestamp >= afterTimestamp);
      }
    }

    return createSession({
      id: stored.id,
      appName,
      userId,
      state: mergeStates(
        parseStateMap(appRaw),
        parseStateMap(userRaw),
        stored.state,
      ),
      events,
      lastUpdateTime: stored.last_update_time,
    });
  }

  async listSessions(
    request: ListSessionsRequest,
  ): Promise<ListSessionsResponse> {
    const {appName, userId, order} = request;
    const client = await this.getClient();
    const scope = escapeGlob(appName);
    const pattern = userId
      ? `${this.keyPrefix}${scope}:${escapeGlob(userId)}:*`
      : `${this.keyPrefix}${scope}:*`;

    const appState = parseStateMap(
      await client.get(appStateKey(this.keyPrefix, appName)),
    );
    const userStates = new Map<string, Record<string, unknown>>();

    const keys: string[] = [];
    for await (const batch of client.scanIterator({MATCH: pattern})) {
      keys.push(...batch);
    }

    const sessions: Session[] = [];
    for (const key of keys) {
      const raw = await client.get(key);
      if (!raw) {
        continue;
      }
      const stored = parseStoredSession(raw);
      if (!stored) {
        logger.warn(`Skipping the key ${key}, which holds no session.`);
        continue;
      }

      let userState = userStates.get(stored.user_id);
      if (!userState) {
        userState = parseStateMap(
          await client.get(
            userStateKey(this.keyPrefix, appName, stored.user_id),
          ),
        );
        userStates.set(stored.user_id, userState);
      }

      sessions.push(
        createSession({
          id: stored.id,
          appName: stored.app_name,
          userId: stored.user_id,
          state: mergeStates(appState, userState, stored.state),
          events: [],
          lastUpdateTime: stored.last_update_time,
        }),
      );
    }

    sessions.sort((a, b) => compareSessions(a, b, order ?? 'desc'));
    return paginateSessions(sessions, request);
  }

  async deleteSession({
    appName,
    userId,
    sessionId,
  }: DeleteSessionRequest): Promise<void> {
    const client = await this.getClient();
    await client.del(sessionKey(this.keyPrefix, appName, userId, sessionId));
  }

  override async appendEvent({
    session,
    event,
  }: AppendEventRequest): Promise<Event> {
    if (event.partial) {
      return event;
    }

    const client = await this.getClient();
    const appended = await super.appendEvent({session, event});
    session.lastUpdateTime = appended.timestamp;

    const {appState: appDelta, userState: userDelta} = splitStateByScope(
      appended.actions?.stateDelta,
    );
    await this.syncScopeState(
      client,
      appStateKey(this.keyPrefix, session.appName),
      appDelta,
    );
    await this.syncScopeState(
      client,
      userStateKey(this.keyPrefix, session.appName, session.userId),
      userDelta,
    );

    const {sessionState} = splitStateByScope(session.state);
    const stored: StoredSession = {
      id: session.id,
      app_name: session.appName,
      user_id: session.userId,
      state: sessionState,
      events: session.events.map(transformToSnakeCaseEvent),
      last_update_time: session.lastUpdateTime,
    };
    await client.set(
      sessionKey(this.keyPrefix, session.appName, session.userId, session.id),
      JSON.stringify(stored),
      this.setOptions(),
    );

    return appended;
  }

  /**
   * Releases the connection this service opened, if any. An injected client is
   * left alone, because its caller owns it. Safe to call more than once.
   */
  async close(): Promise<void> {
    const pending = this.clientPromise;
    if (!pending) {
      return;
    }
    this.clientPromise = undefined;
    const client = await pending;
    await client.close();
  }

  /**
   * Returns the injected client, or builds and connects one on first use.
   *
   * The pending promise is memoised rather than the resolved client, so two
   * concurrent callers share a single connect. A failed connect is forgotten,
   * so the next call retries instead of replaying the failure forever.
   */
  private async getClient(): Promise<RedisClientLike> {
    if (this.injectedClient) {
      return this.injectedClient;
    }
    if (!this.clientPromise) {
      this.clientPromise = connectRedisClient(this.config).catch((error) => {
        this.clientPromise = undefined;
        throw error;
      });
    }
    return this.clientPromise;
  }

  /** The `SET` options for a write, omitting `EX` when TTL is disabled. */
  private setOptions(): RedisSetOptions | undefined {
    return this.ttlSeconds > 0 ? {EX: this.ttlSeconds} : undefined;
  }

  /** Merges `delta` into the scope map at `key`, unless `delta` is empty. */
  private async syncScopeState(
    client: RedisClientLike,
    key: string,
    delta: Record<string, unknown>,
  ): Promise<void> {
    if (Object.keys(delta).length === 0) {
      return;
    }
    const state = parseStateMap(await client.get(key));
    Object.assign(state, delta);
    await client.set(key, JSON.stringify(state), this.setOptions());
  }
}
