/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A Redis-backed {@link BaseSessionService}.
 *
 * The key layout and the stored payloads match adk-python's
 * `google.adk.integrations.redis`, so one Redis instance can back an adk-js
 * runner and an adk-python runner at the same time. Three key families hold
 * the data, all under a configurable prefix:
 *
 * ```
 * {keyPrefix}{appName}:{userId}:{sessionId}   the session envelope
 * {keyPrefix}user_state:{appName}:{userId}    user-scoped state
 * {keyPrefix}app_state:{appName}              app-scoped state
 * ```
 */

import {AlreadyExistsError} from '../../errors/already_exists_error.js';
import {InputValidationError} from '../../errors/input_validation_error.js';
import {
  Event,
  transformToCamelCaseEvent,
  transformToSnakeCaseEvent,
} from '../../events/event.js';
import {
  AppendEventRequest,
  BaseSessionService,
  CreateSessionRequest,
  DeleteSessionRequest,
  GetSessionConfig,
  GetSessionRequest,
  ListSessionsRequest,
  ListSessionsResponse,
  mergeStates,
  paginateSessions,
} from '../../sessions/base_session_service.js';
import {createSession, Session} from '../../sessions/session.js';
import {State} from '../../sessions/state.js';
import {randomUUID} from '../../utils/env_aware_utils.js';
import {logger} from '../../utils/logger.js';
import {loadOptionalPeer} from '../../utils/optional_peer.js';
import {redactUriPassword} from '../../utils/redact_uri.js';

/** Default Redis hostname, matching adk-python's `_config.py`. */
const DEFAULT_HOST = 'localhost';
/** Default Redis port. */
const DEFAULT_PORT = 6379;
/** Default Redis database index. */
const DEFAULT_DB = 0;
/** Whether the default connection uses TLS. */
const DEFAULT_SSL = false;
/** Default expiry for every key this service writes: seven days. */
const DEFAULT_TTL_SECONDS = 604800;
/** Default prefix for every key this service writes. */
const DEFAULT_KEY_PREFIX = 'adk:session:';

/** Characters Redis reads as glob metacharacters in a `SCAN` pattern. */
const GLOB_METACHARACTERS = /[*?[\]^\\]/g;

/**
 * The slice of a node-redis client {@link RedisSessionService} uses.
 *
 * The service depends on this structural type rather than on node-redis, so
 * that `redis` stays out of the type graph of applications that never
 * construct the service, and so that a test can pass a double in.
 */
export interface RedisClientLike {
  /** Reads a key, resolving `null` when it is absent or expired. */
  get(key: string): Promise<string | null>;
  /**
   * Writes a key. Resolves to a falsy value when `NX` was requested and the
   * key already existed.
   *
   * node-redis v6 deprecates `EX` and `NX` in favour of `expiration` and
   * `condition`, but still honours them, and they are the only form the v5
   * half of the supported peer range accepts.
   */
  set(
    key: string,
    value: string,
    options?: {EX?: number; NX?: boolean},
  ): Promise<unknown>;
  /** Deletes a key. Does not fail when the key is absent. */
  del(key: string): Promise<unknown>;
  /** Iterates matching keys in batches. */
  scanIterator(options?: {
    MATCH?: string;
    COUNT?: number;
  }): AsyncIterable<string[]>;
  /** Closes the connection. */
  close(): Promise<void>;
}

/**
 * Connection and storage settings for {@link RedisSessionService}.
 *
 * The field set and every default match adk-python's
 * `google.adk.integrations.redis` configuration, because the defaults are what
 * make an adk-js runner and an adk-python runner address the same keys.
 */
export interface RedisSessionServiceConfig {
  /**
   * Connection URI, `redis://[:password@]host:port/db` or `rediss://...` for
   * TLS. Takes precedence over the discrete fields below.
   */
  uri?: string;
  /** Redis hostname. Defaults to `localhost`. */
  host?: string;
  /** Redis port. Defaults to `6379`. */
  port?: number;
  /** Password for Redis authentication. */
  password?: string;
  /** Whether to connect over TLS. Defaults to `false`. */
  ssl?: boolean;
  /** Redis database index. Defaults to `0`. */
  db?: number;
  /**
   * Expiry applied to every key this service writes, in seconds. Defaults to
   * `604800` (seven days). Zero or negative disables expiry.
   */
  ttlSeconds?: number;
  /** Prefix for every key this service writes. Defaults to `adk:session:`. */
  keyPrefix?: string;
}

/**
 * Constructor options for {@link RedisSessionService}: the configuration, plus
 * the option of supplying the client instead of letting the service build one.
 */
export interface RedisSessionServiceOptions extends RedisSessionServiceConfig {
  /**
   * A connected client to use instead of one built from the fields above.
   * It belongs to its caller: the service never connects or closes it.
   */
  client?: RedisClientLike;
}

/** A {@link RedisSessionServiceConfig} with every default applied. */
interface ResolvedConfig extends RedisSessionServiceConfig {
  host: string;
  port: number;
  ssl: boolean;
  db: number;
  ttlSeconds: number;
  keyPrefix: string;
}

/**
 * Fills in the default of every setting the caller left out.
 *
 * The service resolves its configuration once, so no later reader has to know
 * which fields carry a default.
 *
 * @param config The caller's settings.
 * @return The same settings, fully populated.
 */
function resolveConfig(config: RedisSessionServiceConfig): ResolvedConfig {
  return {
    uri: config.uri,
    host: config.host ?? DEFAULT_HOST,
    port: config.port ?? DEFAULT_PORT,
    password: config.password,
    ssl: config.ssl ?? DEFAULT_SSL,
    db: config.db ?? DEFAULT_DB,
    ttlSeconds: config.ttlSeconds ?? DEFAULT_TTL_SECONDS,
    keyPrefix: config.keyPrefix ?? DEFAULT_KEY_PREFIX,
  };
}

/** The parameters for {@link RedisSessionService.getUserState}. */
export interface RedisGetUserStateRequest {
  /** The name of the application. */
  appName: string;
  /** The ID of the user. */
  userId: string;
}

/** The stored session payload, in adk-python's `snake_case` field names. */
interface StoredSessionEnvelope {
  id: string;
  app_name: string;
  user_id: string;
  state: Record<string, unknown>;
  events: Array<Record<string, unknown>>;
  last_update_time: number;
}

/** State keys grouped by the scope their prefix selects. */
interface ScopedState {
  /** `app:` keys, prefix stripped. */
  app: Record<string, unknown>;
  /** `user:` keys, prefix stripped. */
  user: Record<string, unknown>;
  /** Unprefixed keys. `temp:` keys are dropped. */
  session: Record<string, unknown>;
}

/**
 * Builds the key holding one session.
 *
 * The key builders and {@link escapeRedisGlob} below are exported for this
 * module's tests, not re-exported from `@google/adk`: the key layout is a
 * documented wire format, not a public API surface.
 *
 * @param keyPrefix The configured key prefix.
 * @param appName The name of the application.
 * @param userId The ID of the user.
 * @param sessionId The ID of the session.
 * @return The Redis key.
 */
export function redisSessionKey(
  keyPrefix: string,
  appName: string,
  userId: string,
  sessionId: string,
): string {
  return `${keyPrefix}${appName}:${userId}:${sessionId}`;
}

/**
 * Builds the key holding one user's shared state.
 *
 * @param keyPrefix The configured key prefix.
 * @param appName The name of the application.
 * @param userId The ID of the user.
 * @return The Redis key.
 */
export function redisUserStateKey(
  keyPrefix: string,
  appName: string,
  userId: string,
): string {
  return `${keyPrefix}user_state:${appName}:${userId}`;
}

/**
 * Builds the key holding one application's shared state.
 *
 * @param keyPrefix The configured key prefix.
 * @param appName The name of the application.
 * @return The Redis key.
 */
export function redisAppStateKey(keyPrefix: string, appName: string): string {
  return `${keyPrefix}app_state:${appName}`;
}

/**
 * Escapes the Redis glob metacharacters in one segment of a `SCAN` pattern.
 *
 * {@link RedisSessionService.listSessions} interpolates the application name
 * and the user ID into its pattern. A user ID of `*` would otherwise widen
 * that pattern and return another user's sessions.
 *
 * @param segment The value to interpolate.
 * @return The value with `* ? [ ] ^ \` escaped.
 */
export function escapeRedisGlob(segment: string): string {
  // A function replacement, because a string replacement would expand `$&`
  // and friends in caller-supplied text.
  return segment.replace(GLOB_METACHARACTERS, (match) => `\\${match}`);
}

/** Converts epoch milliseconds to the POSIX seconds adk-python stores. */
function toEpochSeconds(milliseconds: number): number {
  return milliseconds / 1000;
}

/** Converts stored POSIX seconds back to the epoch milliseconds adk-js uses. */
function toMilliseconds(seconds: number): number {
  return Math.round(seconds * 1000);
}

/** Returns true when `value` is a non-array object. */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Copies `source` into a fresh null-prototype map.
 *
 * State keys reach this service through `JSON.parse`, which makes `__proto__`
 * an ordinary own key. Copying such a key into a plain object literal would
 * reach the inherited `__proto__` setter and re-parent the map instead of
 * storing the entry, for the reason `trimTempState` documents.
 */
function toNullPrototypeRecord(
  source: Record<string, unknown>,
): Record<string, unknown> {
  const target: Record<string, unknown> = Object.create(null);
  for (const [key, value] of Object.entries(source)) {
    target[key] = value;
  }
  return target;
}

/**
 * Parses a stored shared-state value, resolving an empty map when the key is
 * absent.
 */
function parseSharedState(raw: string | null): Record<string, unknown> {
  if (!raw) {
    return Object.create(null);
  }
  const parsed: unknown = JSON.parse(raw);
  return isPlainRecord(parsed)
    ? toNullPrototypeRecord(parsed)
    : Object.create(null);
}

/** Groups the keys of `state` by the scope their prefix selects. */
function splitStateByScope(state: Record<string, unknown>): ScopedState {
  const scoped: ScopedState = {
    app: Object.create(null),
    user: Object.create(null),
    session: Object.create(null),
  };
  for (const [key, value] of Object.entries(state)) {
    if (key.startsWith(State.APP_PREFIX)) {
      scoped.app[key.slice(State.APP_PREFIX.length)] = value;
    } else if (key.startsWith(State.USER_PREFIX)) {
      scoped.user[key.slice(State.USER_PREFIX.length)] = value;
    } else if (!key.startsWith(State.TEMP_PREFIX)) {
      scoped.session[key] = value;
    }
  }
  return scoped;
}

/**
 * Returns true when `value` is a stored event.
 *
 * The clock is checked because {@link decodeEvent} converts it: adk-python
 * writes `Event.timestamp` as POSIX seconds and always sets it, so an entry
 * without a numeric one is not an event this service wrote or can read.
 */
function isStoredEvent(value: unknown): value is Record<string, unknown> {
  return isPlainRecord(value) && typeof value['timestamp'] === 'number';
}

/** Returns true when `value` has every field of a stored session envelope. */
function isSessionEnvelope(value: unknown): value is StoredSessionEnvelope {
  return (
    isPlainRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.app_name === 'string' &&
    typeof value.user_id === 'string' &&
    typeof value.last_update_time === 'number' &&
    isPlainRecord(value.state) &&
    Array.isArray(value.events) &&
    value.events.every(isStoredEvent)
  );
}

/**
 * Serializes an event, converting its clock to the seconds adk-python stores.
 *
 * `transformToSnakeCaseEvent` only renames keys. `Event.timestamp` carries the
 * same kind of value as `last_update_time`, so it needs the same conversion:
 * leaving it in milliseconds would put every adk-js event a thousand times
 * into the future for an adk-python reader of the same envelope.
 */
function encodeEvent(event: Event): Record<string, unknown> {
  const encoded = transformToSnakeCaseEvent(event);
  encoded['timestamp'] = toEpochSeconds(event.timestamp);
  return encoded;
}

/** Reads a stored event back, converting its clock to epoch milliseconds. */
function decodeEvent(stored: Record<string, unknown>): Event {
  const event = transformToCamelCaseEvent(stored);
  event.timestamp = toMilliseconds(event.timestamp);
  return event;
}

/** Serializes a session into the envelope adk-python reads. */
function encodeSessionEnvelope(session: Session): string {
  const envelope: StoredSessionEnvelope = {
    id: session.id,
    app_name: session.appName,
    user_id: session.userId,
    state: session.state,
    events: session.events.map(encodeEvent),
    last_update_time: toEpochSeconds(session.lastUpdateTime),
  };
  return JSON.stringify(envelope);
}

/**
 * Reads a stored envelope back into a session.
 *
 * `SCAN` matches by pattern, so a key written by something else can come back
 * from a listing. A value that is not a session envelope is reported and
 * skipped rather than thrown, so one foreign key cannot fail a whole listing.
 *
 * @param raw The stored value.
 * @param key The Redis key it came from, for the warning.
 * @return The session, or undefined when the value is not an envelope.
 */
function decodeSessionEnvelope(raw: string, key: string): Session | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err: unknown) {
    logger.warn(`Redis key ${key} does not hold valid JSON: ${String(err)}`);
    return undefined;
  }
  if (!isSessionEnvelope(parsed)) {
    logger.warn(`Redis key ${key} does not hold an ADK session envelope.`);
    return undefined;
  }
  return createSession({
    id: parsed.id,
    appName: parsed.app_name,
    userId: parsed.user_id,
    state: toNullPrototypeRecord(parsed.state),
    events: parsed.events.map(decodeEvent),
    lastUpdateTime: toMilliseconds(parsed.last_update_time),
  });
}

/** Rejects a {@link GetSessionConfig} that asks for a negative event count. */
function validateGetSessionConfig(config?: GetSessionConfig): void {
  if (config?.numRecentEvents !== undefined && config.numRecentEvents < 0) {
    throw new InputValidationError(
      'numRecentEvents must be greater than or equal to 0.',
    );
  }
}

/**
 * Applies a {@link GetSessionConfig} to an event list.
 *
 * `numRecentEvents` is applied before `afterTimestamp`, which is the order
 * adk-python applies them in and is observable when both are set.
 */
function filterEvents(events: Event[], config?: GetSessionConfig): Event[] {
  if (!config) {
    return events;
  }
  let filtered = events;
  const {numRecentEvents, afterTimestamp} = config;
  if (numRecentEvents !== undefined) {
    // `slice(-0)` returns the whole array, so zero needs its own branch.
    filtered = numRecentEvents === 0 ? [] : filtered.slice(-numRecentEvents);
  }
  if (afterTimestamp !== undefined) {
    filtered = filtered.filter((event) => event.timestamp >= afterTimestamp);
  }
  return filtered;
}

/** Collects every key matching `pattern`, flattening the scan batches. */
async function scanKeys(
  client: RedisClientLike,
  pattern: string,
): Promise<string[]> {
  const keys: string[] = [];
  for await (const batch of client.scanIterator({MATCH: pattern})) {
    keys.push(...batch);
  }
  return keys;
}

/**
 * A session service that stores sessions, events and state in Redis.
 *
 * Sessions survive a process restart and are visible to every process pointed
 * at the same instance, including an adk-python runner. `redis` (node-redis
 * v5 or v6) is an optional peer dependency: install it, or pass a client that
 * is already connected.
 *
 * ```ts
 * const service = new RedisSessionService({uri: 'redis://localhost:6379/0'});
 * const session = await service.createSession({
 *   appName: 'my_app',
 *   userId: 'user-123',
 *   state: {'app:tier': 'gold', 'user:locale': 'en-US', turn: 0},
 * });
 * ```
 */
export class RedisSessionService extends BaseSessionService {
  private readonly config: ResolvedConfig;
  /** The client the caller supplied, which the service never closes. */
  private readonly injectedClient: RedisClientLike | undefined;
  private readonly keyPrefix: string;
  /** The `EX` argument for every write, or undefined when expiry is off. */
  private readonly expiry: number | undefined;
  private clientPromise?: Promise<RedisClientLike>;

  constructor(options: RedisSessionServiceOptions = {}) {
    super();
    this.config = resolveConfig(options);
    this.injectedClient = options.client;
    this.keyPrefix = this.config.keyPrefix;
    this.expiry =
      this.config.ttlSeconds > 0 ? this.config.ttlSeconds : undefined;
  }

  /**
   * Resolves the client, connecting on first use.
   *
   * The promise is cached rather than the client, so two concurrent first
   * calls share one connection instead of opening two. An injected client
   * never enters that cache, which is what leaves it for its owner to close.
   */
  private getClient(): Promise<RedisClientLike> {
    if (this.injectedClient) {
      return Promise.resolve(this.injectedClient);
    }
    if (this.clientPromise === undefined) {
      const pending = this.connect();
      // One failed attempt must not poison the service: drop the rejected
      // promise so the next call reconnects instead of replaying the old
      // error for the life of the process.
      pending.catch(() => {
        if (this.clientPromise === pending) {
          this.clientPromise = undefined;
        }
      });
      this.clientPromise = pending;
    }
    return this.clientPromise;
  }

  /** Loads the `redis` peer, builds a client from the config and connects it. */
  private async connect(): Promise<RedisClientLike> {
    const {createClient} = await loadOptionalPeer(
      {packageName: 'redis', feature: 'RedisSessionService'},
      () => import('redis'),
    );
    const {uri, host, port, password, ssl, db} = this.config;
    const client = uri
      ? createClient({url: uri})
      : createClient({
          socket: ssl ? {host, port, tls: true} : {host, port},
          password,
          database: db,
        });

    const target = uri ? redactUriPassword(uri) : `${host}:${port}`;
    // node-redis is an EventEmitter, and an `error` event with no listener is
    // rethrown and takes the process down. Attach one before connecting.
    client.on('error', (err: Error) => {
      logger.error(`Redis connection to ${target} failed: ${err.message}`);
    });
    try {
      await client.connect();
    } catch (err: unknown) {
      // node-redis keeps its reconnect timer running after a failed connect,
      // so release the client. A close failure must not mask the connect
      // failure, which is the one the caller needs to see.
      await client.close().catch(() => undefined);
      throw err;
    }
    return client;
  }

  /**
   * Closes the connection this service opened.
   *
   * A client passed in through {@link RedisSessionServiceOptions.client} never
   * enters the connection cache, so it belongs to its caller and is left
   * open.
   */
  async close(): Promise<void> {
    const pending = this.clientPromise;
    if (pending === undefined) {
      return;
    }
    this.clientPromise = undefined;
    const client = await pending;
    await client.close();
  }

  /**
   * Merges `delta` into the shared state at `key` and writes it back.
   *
   * @param client The connected client.
   * @param key The shared-state key.
   * @param delta The scope-stripped keys to apply.
   * @param stored The current value, when the caller has already read it.
   *     An empty delta writes nothing, so a session that touches no shared
   *     state does not refresh the expiry of state nobody changed.
   */
  private async writeSharedState(
    client: RedisClientLike,
    key: string,
    delta: Record<string, unknown>,
    stored?: Record<string, unknown>,
  ): Promise<void> {
    if (Object.keys(delta).length === 0) {
      return;
    }
    const current = stored ?? parseSharedState(await client.get(key));
    for (const [name, value] of Object.entries(delta)) {
      current[name] = value;
    }
    await client.set(key, JSON.stringify(current), {EX: this.expiry});
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
    const scoped = splitStateByScope(initialState);

    const appKey = redisAppStateKey(this.keyPrefix, appName);
    const userKey = redisUserStateKey(this.keyPrefix, appName, userId);
    const [appRaw, userRaw] = await Promise.all([
      client.get(appKey),
      client.get(userKey),
    ]);
    const appState = parseSharedState(appRaw);
    const userState = parseSharedState(userRaw);
    await Promise.all([
      this.writeSharedState(client, appKey, scoped.app, appState),
      this.writeSharedState(client, userKey, scoped.user, userState),
    ]);

    const lastUpdateTime = Date.now();
    const stored = createSession({
      id,
      appName,
      userId,
      state: scoped.session,
      events: [],
      lastUpdateTime,
    });
    const created = await client.set(
      redisSessionKey(this.keyPrefix, appName, userId, id),
      encodeSessionEnvelope(stored),
      {EX: this.expiry, NX: true},
    );
    if (!created) {
      throw new AlreadyExistsError(
        `Session ${id} already exists for user ${userId} in app ${appName}.`,
      );
    }

    // The returned session also carries the caller's `temp:` keys, which are
    // never persisted and so live only on this object.
    const mergedState = mergeStates(appState, userState, scoped.session);
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
    validateGetSessionConfig(config);

    const client = await this.getClient();
    const key = redisSessionKey(this.keyPrefix, appName, userId, sessionId);
    const [raw, appRaw, userRaw] = await Promise.all([
      client.get(key),
      client.get(redisAppStateKey(this.keyPrefix, appName)),
      client.get(redisUserStateKey(this.keyPrefix, appName, userId)),
    ]);
    if (!raw) {
      return undefined;
    }
    const session = decodeSessionEnvelope(raw, key);
    if (!session) {
      return undefined;
    }

    session.state = mergeStates(
      parseSharedState(appRaw),
      parseSharedState(userRaw),
      session.state,
    );
    session.events = filterEvents(session.events, config);
    return session;
  }

  async listSessions(
    request: ListSessionsRequest,
  ): Promise<ListSessionsResponse> {
    const {appName, userId, order} = request;
    const client = await this.getClient();
    const pattern =
      userId === undefined
        ? `${this.keyPrefix}${escapeRedisGlob(appName)}:*`
        : `${this.keyPrefix}${escapeRedisGlob(appName)}:${escapeRedisGlob(userId)}:*`;

    const appState = parseSharedState(
      await client.get(redisAppStateKey(this.keyPrefix, appName)),
    );
    // One read of each user's shared state serves every session of that user.
    const userStates = new Map<string, Record<string, unknown>>();

    const sessions: Session[] = [];
    for (const key of await scanKeys(client, pattern)) {
      const raw = await client.get(key);
      if (!raw) {
        continue;
      }
      const session = decodeSessionEnvelope(raw, key);
      if (!session) {
        continue;
      }
      let userState = userStates.get(session.userId);
      if (userState === undefined) {
        userState = parseSharedState(
          await client.get(
            redisUserStateKey(this.keyPrefix, appName, session.userId),
          ),
        );
        userStates.set(session.userId, userState);
      }
      sessions.push(
        createSession({
          id: session.id,
          appName: session.appName,
          userId: session.userId,
          state: mergeStates(appState, userState, session.state),
          // `ListSessionsResponse` documents that events are not set.
          events: [],
          lastUpdateTime: session.lastUpdateTime,
        }),
      );
    }

    // `SCAN` returns keys in an order that varies between calls, so leaving
    // them unordered would make the result nondeterministic. adk-python sorts
    // descending unconditionally, which makes descending the default here too.
    const descending = order !== 'asc';
    sessions.sort(
      (a, b) =>
        (descending
          ? b.lastUpdateTime - a.lastUpdateTime
          : a.lastUpdateTime - b.lastUpdateTime) || a.id.localeCompare(b.id),
    );

    return paginateSessions(sessions, request);
  }

  async deleteSession({
    appName,
    userId,
    sessionId,
  }: DeleteSessionRequest): Promise<void> {
    const client = await this.getClient();
    await client.del(
      redisSessionKey(this.keyPrefix, appName, userId, sessionId),
    );
  }

  /**
   * Reads one user's shared state.
   *
   * @param request The application and user to read.
   * @return The stored keys, without their `user:` prefix, or an empty map.
   */
  async getUserState({
    appName,
    userId,
  }: RedisGetUserStateRequest): Promise<Record<string, unknown>> {
    const client = await this.getClient();
    return parseSharedState(
      await client.get(redisUserStateKey(this.keyPrefix, appName, userId)),
    );
  }

  override async appendEvent({
    session,
    event,
  }: AppendEventRequest): Promise<Event> {
    if (event.partial) {
      return event;
    }
    const client = await this.getClient();
    await super.appendEvent({session, event});
    session.lastUpdateTime = event.timestamp;

    const stateDelta = event.actions?.stateDelta;
    if (stateDelta) {
      const scoped = splitStateByScope(stateDelta);
      await Promise.all([
        this.writeSharedState(
          client,
          redisAppStateKey(this.keyPrefix, session.appName),
          scoped.app,
        ),
        this.writeSharedState(
          client,
          redisUserStateKey(this.keyPrefix, session.appName, session.userId),
          scoped.user,
        ),
      ]);
    }

    const stored = createSession({
      id: session.id,
      appName: session.appName,
      userId: session.userId,
      state: splitStateByScope(session.state).session,
      events: session.events,
      lastUpdateTime: session.lastUpdateTime,
    });
    await client.set(
      redisSessionKey(
        this.keyPrefix,
        session.appName,
        session.userId,
        session.id,
      ),
      encodeSessionEnvelope(stored),
      {EX: this.expiry},
    );
    return event;
  }
}
