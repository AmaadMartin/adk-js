/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {randomUUID} from 'node:crypto';

import {
  CollectionReference,
  DocumentReference,
  FieldValue,
  Firestore,
  Query,
  QueryDocumentSnapshot,
  Transaction,
} from '@google-cloud/firestore';
import {
  AlreadyExistsError,
  AppendEventRequest,
  applyTempDeltaState,
  BaseSessionService,
  CompositeSessionKey,
  createSession,
  CreateSessionRequest,
  DeleteSessionRequest,
  Event,
  extractStateDelta,
  getLogger,
  GetSessionConfig,
  GetSessionRequest,
  ListSessionsRequest,
  ListSessionsResponse,
  makeJsonSafeState,
  mergeStates,
  Session,
  SessionNotFoundError,
  StaleSessionError,
  toJsonSerializable,
  transformToCamelCaseEvent,
  transformToSnakeCaseEvent,
  trimTempDeltaState,
} from '@google/adk';

const logger = getLogger();

/** Default root collection, overridable per service or by environment. */
export const DEFAULT_ROOT_COLLECTION = 'adk-session';

/** Environment variable that overrides the default root collection. */
const ROOT_COLLECTION_ENV_VAR = 'ADK_FIRESTORE_ROOT_COLLECTION';

/** Subcollection holding one document per session, under a user. */
export const DEFAULT_SESSIONS_COLLECTION = 'sessions';
/** Subcollection holding one document per event, under a session. */
export const DEFAULT_EVENTS_COLLECTION = 'events';
/** Collection holding one app-scoped state document per app. */
export const DEFAULT_APP_STATE_COLLECTION = 'app_states';
/** Collection holding user-scoped state documents, keyed by app. */
export const DEFAULT_USER_STATE_COLLECTION = 'user_states';

/** Subcollection holding one document per user, under an app document. */
const USERS_COLLECTION = 'users';

/** Value of the session `status` field while a delete is in progress. */
const DELETING_STATUS = 'DELETING';

/** Firestore caps a single batched write at 500 operations. */
const MAX_BATCH_DELETES = 500;

const STALE_SESSION_ERROR_MESSAGE =
  'The session has been modified in storage since it was loaded. ' +
  'Please reload the session before appending more events.';

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
  /** The event, snake_cased. See {@link toEventData}. */
  event_data?: Record<string, unknown>;
}

/** Pagination metadata carried by {@link ListSessionsResponse}. */
type PaginationMeta = Pick<
  ListSessionsResponse,
  'page' | 'limit' | 'totalItems' | 'totalPages'
>;

/** Options for {@link FirestoreSessionService}. */
export interface FirestoreSessionServiceOptions {
  /**
   * An existing Firestore client. A default client, reading Application
   * Default Credentials, is created when this is omitted.
   */
  client?: Firestore;

  /**
   * Root collection name. Defaults to `ADK_FIRESTORE_ROOT_COLLECTION`, then to
   * {@link DEFAULT_ROOT_COLLECTION}.
   */
  rootCollection?: string;
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
export function toLastUpdateTime(value: unknown): number {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : 0;
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
function parseSessionState(raw: unknown): Record<string, unknown> {
  if (typeof raw === 'string') {
    return JSON.parse(raw) as Record<string, unknown>;
  }
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};
}

/**
 * The event as the plain JSON stored in its document's `event_data` field.
 *
 * adk-python persists `event.model_dump(mode='json')`, and its `Event` model
 * sets `alias_generator=to_camel` without `serialize_by_alias`, so the stored
 * keys are snake_case. This is the cross-language wire contract, so adk-js
 * writes snake_case too. `DatabaseSessionService` stores event bodies through
 * the same pair of transforms.
 */
function toEventData(event: Event): unknown {
  // The event carries the same state delta the session state does, so it hits
  // the same unserializable values and needs the same coercion.
  return toJsonSerializable(transformToSnakeCaseEvent(event));
}

/** Orders sessions by last update time, then user, then id — all ascending. */
function compareSessions(a: Session, b: Session): number {
  if (a.lastUpdateTime !== b.lastUpdateTime) {
    return a.lastUpdateTime - b.lastUpdateTime;
  }
  if (a.userId !== b.userId) {
    return a.userId < b.userId ? -1 : 1;
  }
  return a.id < b.id ? -1 : 1;
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
    // adk-js measures every timestamp in milliseconds, as
    // `DatabaseSessionService` does; adk-python measures them in seconds.
    query = query.where('timestamp', '>=', new Date(config.afterTimestamp));
  }
  if (config?.numRecentEvents !== undefined) {
    query = query.limitToLast(config.numRecentEvents);
  }
  return query;
}

/**
 * A lock key for one session.
 *
 * A JSON tuple cannot collide: a separator-joined string would, if an
 * identifier contained the separator.
 */
function toSessionLockKey({
  appName,
  userId,
  sessionId,
}: CompositeSessionKey): string {
  return JSON.stringify([appName, userId, sessionId]);
}

/** Swallows a settled append's outcome; the caller already has it. */
function ignoreSettlement(): void {}

/** Reads a state document inside a transaction, defaulting to an empty map. */
async function readStateDocument(
  t: Transaction,
  ref: DocumentReference,
): Promise<Record<string, unknown>> {
  const snap = await t.get(ref);
  return snap.data() ?? {};
}

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
 * Authentication uses Application Default Credentials unless the caller
 * supplies its own client.
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

  private readonly client: Firestore;

  /** Appends in flight per session, so writes to one session serialize. */
  private readonly sessionLocks = new Map<string, Promise<unknown>>();

  constructor(options: FirestoreSessionServiceOptions = {}) {
    super();
    this.client = options.client ?? new Firestore();
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
    const db = this.client;
    const now = FieldValue.serverTimestamp();

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
    const db = this.client;
    const sessionRef = this.getSessionsRef(db, appName, userId).doc(sessionId);
    const snap = await sessionRef.get();
    // An absent document reads back as no data at all, and an empty body
    // carries no session either.
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
        events.push(transformToCamelCaseEvent(stored.event_data));
      }
    }

    return createSession({
      id: sessionId,
      appName,
      userId,
      state: mergeStates(
        appSnap.data() ?? {},
        userSnap.data() ?? {},
        parseSessionState(data.state),
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
    const db = this.client;

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
        appName,
        userId: data.userId ?? '',
        state: mergeStates(
          appState,
          userStates.get(data.userId ?? '') ?? {},
          parseSessionState(data.state),
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
    const db = this.client;
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
      if (pending >= MAX_BATCH_DELETES) {
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

    // Temp values have to reach the in-memory session before the delta is
    // trimmed, so a later agent in the same invocation can read them.
    applyTempDeltaState(session, event);
    event = trimTempDeltaState(event);

    const db = this.client;
    const scoped = extractStateDelta(event.actions?.stateDelta ?? {});
    const sessionRef = this.getSessionsRef(
      db,
      session.appName,
      session.userId,
    ).doc(session.id);
    const appRef = this.getAppStateRef(db, session.appName);
    const userRef = this.getUserStateRef(db, session.appName, session.userId);
    const now = FieldValue.serverTimestamp();

    // Two appends racing on one session would both read the same revision and
    // one would lose its write. Firestore's transaction retry cannot help: the
    // loser is stale by then and must be rejected, not retried.
    const revision = await this.withSessionLock(
      toSessionLockKey({
        appName: session.appName,
        userId: session.userId,
        sessionId: session.id,
      }),
      () =>
        db.runTransaction(async (t) => {
          // 1. Reads
          const snap = await t.get(sessionRef);
          const data = snap.data() as StoredSessionDocument | undefined;
          if (!data) {
            throw new SessionNotFoundError(`Session ${session.id} not found.`);
          }
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
   * Runs `work` after every append already queued for the same session.
   *
   * Appends to one session run one at a time, in submission order, so two
   * turns of one conversation cannot both read the same revision. This is the
   * promise-chain equivalent of adk-python's per-session `asyncio.Lock`. The
   * map drops its entry once the last append settles, including a failed one,
   * so it does not grow for the life of the process.
   */
  private withSessionLock<T>(key: string, work: () => Promise<T>): Promise<T> {
    const queued = this.sessionLocks.get(key);
    const result = queued ? queued.then(work) : work();

    // The queued promise must never reject, or one failure would fail every
    // append waiting behind it.
    const settled = result.then(ignoreSettlement, ignoreSettlement);
    this.sessionLocks.set(key, settled);
    void settled.then(() => {
      // Drop the entry only when nothing queued behind this append.
      if (this.sessionLocks.get(key) === settled) {
        this.sessionLocks.delete(key);
      }
    });
    return result;
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
}
