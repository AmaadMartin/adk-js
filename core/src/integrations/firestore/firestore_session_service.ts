/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  CollectionReference,
  DocumentReference,
  FieldValue,
  Firestore,
  Query,
  QueryDocumentSnapshot,
  Settings,
  Transaction,
} from '@google-cloud/firestore';

import {AlreadyExistsError} from '../../errors/already_exists_error.js';
import {SessionNotFoundError} from '../../errors/session_not_found_error.js';
import {StaleSessionError} from '../../errors/stale_session_error.js';
import {Event} from '../../events/event.js';
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
  trimTempDeltaState,
} from '../../sessions/base_session_service.js';
import {
  CompositeSessionKey,
  createSession,
  Session,
} from '../../sessions/session.js';
import {State} from '../../sessions/state.js';
import {randomUUID} from '../../utils/env_aware_utils.js';
import {logger} from '../../utils/logger.js';
import {loadOptionalPeer} from '../../utils/optional_peer.js';

/** Default root collection, overridable per service or by environment. */
const DEFAULT_ROOT_COLLECTION = 'adk-session';

/** Environment variable that overrides the default root collection. */
const ROOT_COLLECTION_ENV_VAR = 'ADK_FIRESTORE_ROOT_COLLECTION';

const DEFAULT_SESSIONS_COLLECTION = 'sessions';
const DEFAULT_EVENTS_COLLECTION = 'events';
const DEFAULT_APP_STATE_COLLECTION = 'app_states';
const DEFAULT_USER_STATE_COLLECTION = 'user_states';

/** Subcollection holding one document per user, under an app document. */
const USERS_COLLECTION = 'users';

/** Value of the session `status` field while a delete is in progress. */
const DELETING_STATUS = 'DELETING';

/** Firestore caps a single batched write at 500 operations. */
const MAX_BATCH_SIZE = 500;

const STALE_SESSION_ERROR_MESSAGE =
  'The session has been modified in storage since it was loaded. ' +
  'Please reload the session before appending more events.';

const NON_SERIALIZABLE_STATE_MESSAGE =
  'Failed to serialize session state; some values are not JSON-serializable ' +
  '(e.g. functions) and were replaced with a string representation in the ' +
  'persisted state.';

/** The `@google-cloud/firestore` module namespace. */
type FirestoreModule = typeof import('@google-cloud/firestore');

/** A session document as this service writes it. */
interface StoredSessionDocument {
  id?: string;
  appName?: string;
  userId?: string;
  /** JSON-encoded session-scoped state. Older documents may store an object. */
  state?: string | Record<string, unknown>;
  updateTime?: unknown;
  revision?: number;
  status?: string;
}

/** An event document as this service writes it. */
interface StoredEventDocument {
  event_data?: Event;
}

/** The three scopes a state map splits into. */
interface ScopedState {
  app: Record<string, unknown>;
  user: Record<string, unknown>;
  session: Record<string, unknown>;
}

/** Pagination metadata carried by {@link ListSessionsResponse}. */
type PaginationMeta = Pick<
  ListSessionsResponse,
  'page' | 'limit' | 'totalItems' | 'totalPages'
>;

/** Options for {@link FirestoreSessionService}. */
export interface FirestoreSessionServiceOptions {
  /**
   * An existing Firestore client. One is constructed on first use when this is
   * omitted.
   */
  client?: Firestore;

  /**
   * Root collection name. Defaults to `ADK_FIRESTORE_ROOT_COLLECTION`, then to
   * `adk-session`.
   */
  rootCollection?: string;

  /**
   * Settings for the client this service constructs when `client` is omitted.
   *
   * This has no adk-python counterpart. The client is built lazily behind the
   * optional peer dependency, so this is the only way to point it at a
   * project without constructing the client yourself.
   */
  settings?: Settings;
}

/**
 * Splits a state map into its app, user and session scopes.
 *
 * `temp:` keys are dropped: they are never persisted. `app:` and `user:` keys
 * lose their prefix, because each scope is stored in its own document.
 *
 * `database_session_service.ts` inlines the same split for the SQL backend.
 */
function extractStateDelta(state: Record<string, unknown>): ScopedState {
  // Null-prototype maps: a `__proto__` key copied into a plain object literal
  // reaches the inherited setter and re-parents the map instead of storing the
  // entry. See `trimTempState` in `base_session_service.ts`.
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
 * Coerces a state map into a form that survives `JSON.stringify`.
 *
 * A bare `JSON.stringify` drops a function-valued or symbol-valued key without
 * a word, so the key disappears from storage. Replacing the value with its
 * string form keeps the key and makes the lossy write visible in the log. A
 * value carrying `toJSON` goes through it, so a `Date` persists as its ISO
 * string.
 */
function makeJsonSafeState(
  state: Record<string, unknown>,
): Record<string, unknown> {
  let replaced = false;
  const replace = (_key: string, value: unknown): unknown => {
    const type = typeof value;
    if (type !== 'function' && type !== 'symbol' && type !== 'bigint') {
      return value;
    }
    replaced = true;
    return String(value);
  };

  let safe: Record<string, unknown>;
  try {
    safe = JSON.parse(JSON.stringify(state, replace)) as Record<
      string,
      unknown
    >;
  } catch {
    // A circular reference defeats the whole-map pass. Isolate it to the key
    // that holds it rather than losing every other key with it.
    replaced = true;
    safe = {};
    for (const [key, value] of Object.entries(state)) {
      safe[key] = toJsonSafeValue(value, replace);
    }
  }

  if (replaced) {
    logger.warn(NON_SERIALIZABLE_STATE_MESSAGE);
  }
  return safe;
}

/** Coerces one state value, falling back to its string form. */
function toJsonSafeValue(
  value: unknown,
  replace: (key: string, value: unknown) => unknown,
): unknown {
  try {
    const json = JSON.stringify(value, replace);
    return json === undefined ? undefined : (JSON.parse(json) as unknown);
  } catch {
    return String(value);
  }
}

/** True when `value` exposes `method` as a callable returning a number. */
function hasNumericMethod<K extends string>(
  value: unknown,
  method: K,
): value is Record<K, () => number> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Record<string, unknown>)[method] === 'function'
  );
}

/**
 * Reads a stored `updateTime` as milliseconds since the epoch, or `0`.
 *
 * This service writes the field as a Firestore server timestamp, which reads
 * back as a `Timestamp`. A `Date` or a raw number only reaches here from a
 * hand-written document, and a raw number is passed through unchanged: adk-js
 * measures `lastUpdateTime` in milliseconds throughout.
 */
function toLastUpdateTime(value: unknown): number {
  if (typeof value === 'number') {
    return value;
  }
  if (hasNumericMethod(value, 'toMillis')) {
    return value.toMillis();
  }
  if (hasNumericMethod(value, 'getTime')) {
    return value.getTime();
  }
  return 0;
}

/** Reads a stored `state` field, which may be JSON text or a map. */
function parseStoredState(
  raw: string | Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (typeof raw === 'string') {
    return JSON.parse(raw) as Record<string, unknown>;
  }
  return raw ?? {};
}

/**
 * Applies the `temp:` keys of an event delta to the in-memory session state.
 *
 * adk-python's `BaseSessionService` does this for every service; adk-js's does
 * not, so this service does it itself. A later agent in the same invocation
 * reads the values back (e.g. `outputKey: 'temp:x'` inside a SequentialAgent).
 * The keys are trimmed from the event before it is persisted.
 */
function applyTempState(session: Session, event: Event): void {
  const stateDelta = event.actions?.stateDelta;
  if (!stateDelta) {
    return;
  }
  for (const [key, value] of Object.entries(stateDelta)) {
    if (!key.startsWith(State.TEMP_PREFIX)) {
      continue;
    }
    // `defineProperty` always creates an own property; a plain assignment of
    // `__proto__` would reach the inherited setter instead.
    Object.defineProperty(session.state, key, {
      value,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
}

/** The event as the plain JSON stored in its document's `event_data` field. */
function toEventData(event: Event): Record<string, unknown> {
  return JSON.parse(JSON.stringify(event)) as Record<string, unknown>;
}

/** Orders sessions by last update time, then user, then id — all ascending. */
function compareSessions(a: Session, b: Session): number {
  return (
    a.lastUpdateTime - b.lastUpdateTime ||
    compareStrings(a.userId, b.userId) ||
    compareStrings(a.id, b.id)
  );
}

function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

/**
 * Applies adk-js's pagination contract to an ordered list.
 *
 * Firestore cannot offset a collection-group scan cheaply, and the whole
 * result set is materialised to merge state into it anyway, so the slice
 * happens here. The metadata matches `DatabaseSessionService.listSessions`.
 */
function paginate(
  sessions: Session[],
  {limit, offset, page}: ListSessionsRequest,
): {sessions: Session[]; meta: PaginationMeta} {
  const totalItems = sessions.length;

  if (limit === undefined) {
    return {
      sessions: offset ? sessions.slice(offset) : sessions,
      meta: {
        page: 1,
        limit: totalItems,
        totalItems,
        totalPages: totalItems === 0 ? 0 : 1,
      },
    };
  }

  const start = page !== undefined ? (page - 1) * limit : (offset ?? 0);
  const effectivePage =
    page ?? (limit === 0 ? 1 : Math.floor(start / limit) + 1);
  return {
    sessions: sessions.slice(start, start + limit),
    meta: {
      page: effectivePage,
      limit,
      totalItems,
      totalPages: limit === 0 ? 0 : Math.ceil(totalItems / limit),
    },
  };
}

/** Builds the ordered, filtered events query for {@link GetSessionConfig}. */
function buildEventsQuery(
  events: CollectionReference,
  config: GetSessionConfig | undefined,
): Query {
  let query: Query = events.orderBy('timestamp');
  if (config?.afterTimestamp) {
    query = query.where('timestamp', '>=', new Date(config.afterTimestamp));
  }
  if (config?.numRecentEvents !== undefined) {
    query = query.limitToLast(config.numRecentEvents);
  }
  return query;
}

/** A lock key that no session id containing a separator can collide with. */
function toSessionLockKey({
  appName,
  userId,
  sessionId,
}: CompositeSessionKey): string {
  return `${appName}\u0000${userId}\u0000${sessionId}`;
}

function ignore(): void {}

/**
 * Session service backed by Google Cloud Firestore.
 *
 * Sessions and their events:
 *
 * ```
 * <rootCollection>
 * └── <app name>
 *     └── users
 *         └── <user id>
 *             └── sessions
 *                 └── <session id>
 *                     └── events
 *                         └── <event id>
 * ```
 *
 * Shared app and user state:
 *
 * ```
 * app_states
 * └── <app name>
 *
 * user_states
 * └── <app name>
 *     └── users
 *         └── <user id>
 * ```
 *
 * The layout matches adk-python's `FirestoreSessionService`, so both SDKs read
 * and write the same database.
 *
 * Every session this service returns carries the storage revision it was read
 * at. `appendEvent` rejects a write whose revision storage has moved past,
 * with {@link StaleSessionError}, instead of overwriting newer history.
 *
 * Requires the optional peer dependency `@google-cloud/firestore`.
 */
export class FirestoreSessionService extends BaseSessionService {
  /** Root collection holding one document per app. */
  readonly rootCollection: string;
  /** Subcollection holding one document per session, under a user. */
  readonly sessionsCollection = DEFAULT_SESSIONS_COLLECTION;
  /** Subcollection holding one document per event, under a session. */
  readonly eventsCollection = DEFAULT_EVENTS_COLLECTION;
  /** Collection holding one app-scoped state document per app. */
  readonly appStateCollection = DEFAULT_APP_STATE_COLLECTION;
  /** Collection holding user-scoped state documents, keyed by app. */
  readonly userStateCollection = DEFAULT_USER_STATE_COLLECTION;

  private readonly injectedClient?: Firestore;
  private readonly settings?: Settings;
  private clientPromise?: Promise<Firestore>;
  private modulePromise?: Promise<FirestoreModule>;

  /** Appends in flight per session, so writes to one session serialize. */
  private readonly sessionLocks = new Map<string, Promise<unknown>>();

  constructor(options: FirestoreSessionServiceOptions = {}) {
    super();
    this.injectedClient = options.client;
    this.settings = options.settings;
    // Truthiness, matching adk-python's `or` chain: an empty string falls
    // through to the environment variable and then to the default.
    this.rootCollection =
      options.rootCollection ||
      process.env[ROOT_COLLECTION_ENV_VAR] ||
      DEFAULT_ROOT_COLLECTION;
  }

  async createSession({
    appName,
    userId,
    state,
    sessionId,
  }: CreateSessionRequest): Promise<Session> {
    const id = sessionId || randomUUID();
    const db = await this.getClient();
    const now = await this.serverTimestamp();

    const sessionRef = this.getSessionsRef(db, appName, userId).doc(id);
    const appRef = this.getAppStateRef(db, appName);
    const userRef = this.getUserStateRef(db, appName, userId);

    // App and user state are written natively, so a Date stays a Date. Only
    // the session bucket is JSON-encoded, so only it is coerced.
    const scoped = extractStateDelta(state ?? {});
    const sessionState = makeJsonSafeState(scoped.session);

    const sessionData = {
      id,
      appName,
      userId,
      state: JSON.stringify(sessionState),
      createTime: now,
      updateTime: now,
      revision: 0,
    };

    const [storedApp, storedUser] = await db.runTransaction(async (t) => {
      // 1. Reads
      const snap = await t.get(sessionRef);
      if (snap.exists) {
        throw new AlreadyExistsError(`Session ${id} already exists.`);
      }
      const currentApp = await readStateDocument(t, appRef);
      const currentUser = await readStateDocument(t, userRef);

      // 2. Writes
      if (Object.keys(scoped.app).length > 0) {
        Object.assign(currentApp, scoped.app);
        t.set(appRef, currentApp, {merge: true});
      }
      if (Object.keys(scoped.user).length > 0) {
        Object.assign(currentUser, scoped.user);
        t.set(userRef, currentUser, {merge: true});
      }
      t.set(sessionRef, sessionData);
      return [currentApp, currentUser];
    });

    return createSession({
      id,
      appName,
      userId,
      state: mergeStates(storedApp, storedUser, sessionState),
      events: [],
      // The server timestamp is not readable until the write lands, so the
      // local clock stands in, as it does in adk-python.
      lastUpdateTime: Date.now(),
      storageUpdateMarker: '0',
    });
  }

  async getSession({
    appName,
    userId,
    sessionId,
    config,
  }: GetSessionRequest): Promise<Session | undefined> {
    const db = await this.getClient();
    const sessionRef = this.getSessionsRef(db, appName, userId).doc(sessionId);
    const snap = await sessionRef.get();
    if (!snap.exists) {
      return undefined;
    }

    const data = snap.data() as StoredSessionDocument | undefined;
    if (!data || Object.keys(data).length === 0) {
      return undefined;
    }

    // A requested count of zero asks for no history at all — callers use it to
    // probe whether a session exists — so skip the query rather than falling
    // through and reading the whole transcript.
    const eventsWanted = config?.numRecentEvents !== 0;
    const [eventDocs, appSnap, userSnap] = await Promise.all([
      eventsWanted
        ? buildEventsQuery(sessionRef.collection(this.eventsCollection), config)
            .get()
            .then((query) => query.docs)
        : Promise.resolve([]),
      this.getAppStateRef(db, appName).get(),
      this.getUserStateRef(db, appName, userId).get(),
    ]);

    const events: Event[] = [];
    for (const doc of eventDocs) {
      const stored = doc.data() as StoredEventDocument | undefined;
      if (stored?.event_data) {
        events.push(stored.event_data);
      }
    }

    return createSession({
      id: sessionId,
      appName,
      userId,
      state: mergeStates(
        appSnap.data() ?? {},
        userSnap.data() ?? {},
        parseStoredState(data.state),
      ),
      events,
      lastUpdateTime: toLastUpdateTime(data.updateTime),
      storageUpdateMarker: String(data.revision ?? 0),
    });
  }

  async listSessions(
    request: ListSessionsRequest,
  ): Promise<ListSessionsResponse> {
    const {appName, userId, order} = request;
    const db = await this.getClient();

    // The `appName` filter is what keeps other apps out of the
    // collection-group scan, which spans every app's `sessions` subcollection.
    const query = userId
      ? this.getSessionsRef(db, appName, userId).where('appName', '==', appName)
      : db
          .collectionGroup(this.sessionsCollection)
          .where('appName', '==', appName);
    const stored = (await query.get()).docs
      .map((doc) => doc.data() as StoredSessionDocument | undefined)
      .filter((data): data is StoredSessionDocument => !!data);

    const appSnap = await this.getAppStateRef(db, appName).get();
    const appState = appSnap.data() ?? {};
    const userStates = await this.readUserStates(db, appName, userId, stored);

    const sessions = stored.map((data) =>
      createSession({
        id: data.id ?? '',
        appName: data.appName ?? appName,
        userId: data.userId ?? '',
        state: mergeStates(
          appState,
          userStates.get(data.userId ?? '') ?? {},
          parseStoredState(data.state),
        ),
        events: [],
        lastUpdateTime: toLastUpdateTime(data.updateTime),
      }),
    );

    sessions.sort(compareSessions);
    if (order === 'desc') {
      sessions.reverse();
    }
    const page = paginate(sessions, request);
    return {sessions: page.sessions, ...page.meta};
  }

  async deleteSession({
    appName,
    userId,
    sessionId,
  }: DeleteSessionRequest): Promise<void> {
    const db = await this.getClient();
    const sessionRef = this.getSessionsRef(db, appName, userId).doc(sessionId);

    // Best effort: the delete must proceed even when the marker cannot be
    // written, so a reader that races the delete simply misses the marker.
    try {
      await db.runTransaction(async (t) => {
        const snap = await t.get(sessionRef);
        if (snap.exists) {
          t.update(sessionRef, {status: DELETING_STATUS});
        }
      });
    } catch (err: unknown) {
      logger.debug('Could not mark session %s as deleting.', sessionId, err);
    }

    const events = sessionRef
      .collection(this.eventsCollection)
      .stream() as AsyncIterable<QueryDocumentSnapshot>;

    let batch = db.batch();
    let pending = 0;
    for await (const doc of events) {
      batch.delete(doc.ref);
      pending++;
      if (pending >= MAX_BATCH_SIZE) {
        await batch.commit();
        batch = db.batch();
        pending = 0;
      }
    }
    if (pending > 0) {
      await batch.commit();
    }

    await sessionRef.delete();
  }

  override async appendEvent({
    session,
    event,
  }: AppendEventRequest): Promise<Event> {
    if (event.partial) {
      return event;
    }

    applyTempState(session, event);
    event = trimTempDeltaState(event);

    const db = await this.getClient();
    const scoped = extractStateDelta(event.actions?.stateDelta ?? {});
    const sessionRef = this.getSessionsRef(
      db,
      session.appName,
      session.userId,
    ).doc(session.id);
    const appRef = this.getAppStateRef(db, session.appName);
    const userRef = this.getUserStateRef(db, session.appName, session.userId);
    const now = await this.serverTimestamp();

    const revision = await this.withSessionLock(
      {
        appName: session.appName,
        userId: session.userId,
        sessionId: session.id,
      },
      () =>
        db.runTransaction(async (t) => {
          // 1. Reads
          const snap = await t.get(sessionRef);
          if (!snap.exists) {
            throw new SessionNotFoundError(`Session ${session.id} not found.`);
          }
          const data = (snap.data() ?? {}) as StoredSessionDocument;
          if (data.status === DELETING_STATUS) {
            throw new Error(
              `Session ${session.id} is currently being deleted.`,
            );
          }
          const currentRevision = data.revision ?? 0;
          if (
            session.storageUpdateMarker !== undefined &&
            session.storageUpdateMarker !== String(currentRevision)
          ) {
            throw new StaleSessionError(STALE_SESSION_ERROR_MESSAGE);
          }

          const hasAppUpdates = Object.keys(scoped.app).length > 0;
          const hasUserUpdates = Object.keys(scoped.user).length > 0;
          const currentApp = hasAppUpdates
            ? await readStateDocument(t, appRef)
            : undefined;
          const currentUser = hasUserUpdates
            ? await readStateDocument(t, userRef)
            : undefined;

          // 2. Writes
          if (currentApp) {
            t.set(appRef, Object.assign(currentApp, scoped.app), {merge: true});
          }
          if (currentUser) {
            t.set(userRef, Object.assign(currentUser, scoped.user), {
              merge: true,
            });
          }

          // The base class merges the *raw* delta back into `session.state` on
          // every append, so a value that cannot be serialized survives there
          // and reaches this write from an earlier event. Coerce the whole
          // merged map, not just this event's delta.
          const merged = Object.assign(
            extractStateDelta(session.state).session,
            scoped.session,
          );
          const newRevision = currentRevision + 1;
          t.update(sessionRef, {
            state: JSON.stringify(makeJsonSafeState(merged)),
            updateTime: now,
            revision: newRevision,
          });

          t.set(sessionRef.collection(this.eventsCollection).doc(event.id), {
            event_data: toEventData(event),
            timestamp: now,
            appName: session.appName,
            userId: session.userId,
          });

          return newRevision;
        }),
    );

    session.storageUpdateMarker = String(revision);
    session.lastUpdateTime = event.timestamp;
    return super.appendEvent({session, event});
  }

  /**
   * Loads `@google-cloud/firestore` once, translating a missing install into
   * an error naming the feature and the install command.
   */
  private loadModule(): Promise<FirestoreModule> {
    this.modulePromise ??= loadOptionalPeer(
      {
        packageName: '@google-cloud/firestore',
        feature: 'FirestoreSessionService',
      },
      () => import('@google-cloud/firestore'),
    );
    return this.modulePromise;
  }

  /** Resolves the client, constructing one on first use when none was given. */
  private getClient(): Promise<Firestore> {
    this.clientPromise ??= this.injectedClient
      ? Promise.resolve(this.injectedClient)
      : this.loadModule().then(
          ({Firestore: Client}) => new Client(this.settings),
        );
    return this.clientPromise;
  }

  /** The sentinel Firestore replaces with the commit time of the write. */
  private async serverTimestamp(): Promise<FieldValue> {
    const {FieldValue: Field} = await this.loadModule();
    return Field.serverTimestamp();
  }

  private getSessionsRef(
    db: Firestore,
    appName: string,
    userId: string,
  ): CollectionReference {
    return db
      .collection(this.rootCollection)
      .doc(appName)
      .collection(USERS_COLLECTION)
      .doc(userId)
      .collection(this.sessionsCollection);
  }

  private getAppStateRef(db: Firestore, appName: string): DocumentReference {
    return db.collection(this.appStateCollection).doc(appName);
  }

  private getUserStateRef(
    db: Firestore,
    appName: string,
    userId: string,
  ): DocumentReference {
    return db
      .collection(this.userStateCollection)
      .doc(appName)
      .collection(USERS_COLLECTION)
      .doc(userId);
  }

  /**
   * Reads the user-scoped state each listed session needs.
   *
   * One document read when the caller named a user, otherwise one batched read
   * covering every user in the result set.
   */
  private async readUserStates(
    db: Firestore,
    appName: string,
    userId: string | undefined,
    stored: StoredSessionDocument[],
  ): Promise<Map<string, Record<string, unknown>>> {
    const states = new Map<string, Record<string, unknown>>();

    if (userId) {
      const snap = await this.getUserStateRef(db, appName, userId).get();
      const data = snap.data();
      if (data) {
        states.set(userId, data);
      }
      return states;
    }

    const userIds = [
      ...new Set(
        stored
          .map((data) => data.userId)
          .filter((id): id is string => id !== undefined),
      ),
    ].sort();
    if (userIds.length === 0) {
      return states;
    }

    const users = db
      .collection(this.userStateCollection)
      .doc(appName)
      .collection(USERS_COLLECTION);
    const snaps = await db.getAll(...userIds.map((id) => users.doc(id)));
    for (const snap of snaps) {
      const data = snap.data();
      if (data) {
        states.set(snap.id, data);
      }
    }
    return states;
  }

  /**
   * Runs `work` after every append already queued for the same session.
   *
   * Two appends racing on one session would both read the same revision and
   * one would lose its write. Firestore's own transaction retry cannot help:
   * the second append is stale by then and must be rejected, not retried.
   */
  private withSessionLock<T>(
    key: CompositeSessionKey,
    work: () => Promise<T>,
  ): Promise<T> {
    const lockKey = toSessionLockKey(key);
    const queued = this.sessionLocks.get(lockKey);
    const result = queued ? queued.then(work) : work();

    // The queued promise must never reject, or a failed append would fail
    // every append waiting behind it.
    const settled = result.then(ignore, ignore);
    this.sessionLocks.set(lockKey, settled);
    void settled.then(() => {
      // Drop the entry only when nothing queued behind this call, so the map
      // does not keep one entry per session for the life of the process.
      if (this.sessionLocks.get(lockKey) === settled) {
        this.sessionLocks.delete(lockKey);
      }
    });
    return result;
  }
}

/** Reads a state document inside a transaction, defaulting to an empty map. */
async function readStateDocument(
  t: Transaction,
  ref: DocumentReference,
): Promise<Record<string, unknown>> {
  const snap = await t.get(ref);
  return snap.exists ? (snap.data() ?? {}) : {};
}
