/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {randomUUID} from 'node:crypto';

import {
  CollectionReference,
  DocumentReference,
  Firestore,
  Query,
  Timestamp,
} from '@google-cloud/firestore';
import {
  AppendEventRequest,
  BaseSessionService,
  createSession,
  CreateSessionRequest,
  DeleteSessionRequest,
  Event,
  getLogger,
  GetSessionConfig,
  GetSessionRequest,
  ListSessionsRequest,
  ListSessionsResponse,
  mergeStates,
  Session,
  splitStateDelta,
  trimTempDeltaState,
} from '@google/adk';

/** Root collection used when neither the option nor the env var is set. */
export const DEFAULT_ROOT_COLLECTION = 'adk-session';

/** Environment variable that overrides the default root collection. */
export const ROOT_COLLECTION_ENV_VAR = 'ADK_FIRESTORE_ROOT_COLLECTION';

/** Collection holding one user's session documents. */
export const SESSIONS_COLLECTION = 'sessions';

/** Collection holding one session's event documents. */
export const EVENTS_COLLECTION = 'events';

/** Top-level collection holding state shared by a whole app. */
export const APP_STATE_COLLECTION = 'app_states';

/** Top-level collection holding state shared by one user's sessions. */
export const USER_STATE_COLLECTION = 'user_states';

/** Path segment separating an app document from its user documents. */
export const USERS_COLLECTION = 'users';

/** Status written to a session document while it is being deleted. */
const DELETING_STATUS = 'DELETING';

/**
 * Deletes per write batch. Firestore caps the number of writes in one batched
 * write; adk-python's port batches at this same size.
 */
const MAX_DELETES_PER_BATCH = 500;

/** Field on an event document holding the serialized event. */
const EVENT_DATA_FIELD = 'event_data';

/**
 * A session document as read back.
 *
 * Every field is optional and loosely typed: a document may predate a field,
 * and `state` is a JSON string on documents this service writes but may be a
 * plain map on documents written by another client.
 */
interface StoredSession {
  state?: string | Record<string, unknown>;
  updateTime?: unknown;
  revision?: number;
  status?: string;
}

/** An event document as read back. */
interface StoredEvent {
  [EVENT_DATA_FIELD]?: Event;
}

/** Options for {@link FirestoreSessionService}. */
export interface FirestoreSessionServiceOptions {
  /** An existing Firestore client. A default client is created when omitted. */
  client?: Firestore;
  /**
   * Root collection name. Falls back to the `ADK_FIRESTORE_ROOT_COLLECTION`
   * environment variable, then to {@link DEFAULT_ROOT_COLLECTION}.
   */
  rootCollection?: string;
}

/** Narrows a value to a Firestore `Timestamp` without using `instanceof`. */
function isTimestamp(value: unknown): value is Timestamp {
  return (
    typeof value === 'object' &&
    value !== null &&
    'toMillis' in value &&
    typeof value.toMillis === 'function'
  );
}

/**
 * Converts a stored `updateTime` to epoch milliseconds, yielding 0 when the
 * field is absent or was not written as a `Timestamp`.
 */
function toLastUpdateTime(updateTime: unknown): number {
  return isTimestamp(updateTime) ? updateTime.toMillis() : 0;
}

/** Reads a session document's `state` field in either stored representation. */
function parseSessionState(
  raw: string | Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (typeof raw === 'string') {
    return JSON.parse(raw);
  }
  return raw ?? {};
}

/**
 * Serializes an event for storage, dropping `undefined` at every depth.
 *
 * This is the equivalent of Python's `model_dump(exclude_none=True)`.
 * Firestore rejects `undefined` unless the client was constructed with
 * `ignoreUndefinedProperties`, and the client may be caller-supplied, so the
 * service cannot rely on that setting.
 */
function toEventData(event: Event): Record<string, unknown> {
  return JSON.parse(JSON.stringify(event));
}

/** Reads a session's events, applying the window in `config`. */
async function fetchEvents(
  sessionRef: DocumentReference,
  config: GetSessionConfig | undefined,
): Promise<Event[]> {
  // A numRecentEvents of 0 asks for no events, but it is falsy, so it would
  // otherwise fall through the limit below and return every event. Returning
  // nothing matches VertexAiSessionService and the adk-python database,
  // sqlite, in-memory and Vertex AI backends.
  if (config?.numRecentEvents === 0) {
    return [];
  }

  let query: Query = sessionRef
    .collection(EVENTS_COLLECTION)
    .orderBy('timestamp');
  if (config?.afterTimestamp) {
    query = query.where(
      'timestamp',
      '>=',
      Timestamp.fromMillis(config.afterTimestamp),
    );
  }
  if (config?.numRecentEvents) {
    query = query.limitToLast(config.numRecentEvents);
  }

  const snapshot = await query.get();
  const events: Event[] = [];
  for (const doc of snapshot.docs) {
    const stored: StoredEvent = doc.data();
    if (stored[EVENT_DATA_FIELD]) {
      events.push(stored[EVENT_DATA_FIELD]);
    }
  }
  return events;
}

/**
 * Sorts and paginates sessions in memory, matching the arithmetic
 * `InMemorySessionService` applies.
 *
 * Firestore could paginate server side, but `totalItems` would then need a
 * separate count query, and the two other adk-js backends already paginate in
 * memory.
 */
function paginateSessions(
  sessions: Session[],
  {limit, offset, page, order}: ListSessionsRequest,
): ListSessionsResponse {
  if (order === 'asc') {
    sessions.sort(
      (a, b) => a.lastUpdateTime - b.lastUpdateTime || a.id.localeCompare(b.id),
    );
  } else if (order === 'desc') {
    sessions.sort(
      (a, b) => b.lastUpdateTime - a.lastUpdateTime || a.id.localeCompare(b.id),
    );
  }

  const totalItems = sessions.length;

  if (limit === undefined) {
    return {
      sessions: offset ? sessions.slice(offset) : sessions,
      page: 1,
      limit: totalItems,
      totalItems,
      totalPages: totalItems === 0 ? 0 : 1,
    };
  }

  const effectiveOffset =
    page !== undefined ? (page - 1) * limit : (offset ?? 0);
  const effectivePage =
    page !== undefined
      ? page
      : limit === 0
        ? 1
        : Math.floor(effectiveOffset / limit) + 1;

  return {
    sessions: sessions.slice(effectiveOffset, effectiveOffset + limit),
    page: effectivePage,
    limit,
    totalItems,
    totalPages: limit === 0 ? 0 : Math.ceil(totalItems / limit),
  };
}

/**
 * A session service backed by Google Cloud Firestore.
 *
 * Sessions and their events live under the root collection:
 *
 * ```
 * <rootCollection>/<appName>/users/<userId>/sessions/<sessionId>
 * <rootCollection>/<appName>/users/<userId>/sessions/<sessionId>/events/<eventId>
 * ```
 *
 * State shared by a whole app, or by one user's sessions, lives in two sibling
 * top-level collections and is merged back under the `app:` and `user:`
 * prefixes on read:
 *
 * ```
 * app_states/<appName>
 * user_states/<appName>/users/<userId>
 * ```
 *
 * `appendEvent` runs in a Firestore transaction whose writes all derive from
 * the session document it read, so concurrent appends — from this process or
 * another — are serialized by Firestore's own conflict detection and retry.
 */
export class FirestoreSessionService extends BaseSessionService {
  private readonly client: Firestore;
  private readonly rootCollection: string;

  constructor(options: FirestoreSessionServiceOptions = {}) {
    super();
    this.client = options.client ?? new Firestore();
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
    const {
      app: appDelta,
      user: userDelta,
      session: sessionState,
    } = splitStateDelta(state);

    const sessionRef = this.sessionRef(appName, userId, id);
    const appRef = this.appStateRef(appName);
    const userRef = this.userStateRef(appName, userId);
    const nowMillis = Date.now();
    const now = Timestamp.fromMillis(nowMillis);

    const [appState, userState] = await this.client.runTransaction(
      async (tx) => {
        // Firestore rejects a read issued after a write in the same
        // transaction, so all three reads are batched up front.
        const [sessionSnapshot, appSnapshot, userSnapshot] = await tx.getAll(
          sessionRef,
          appRef,
          userRef,
        );
        if (sessionSnapshot.exists) {
          throw new Error(`Session with id ${id} already exists.`);
        }

        // The snapshots are read for the merged state this returns; the
        // writes only need the deltas, because `merge` merges server side.
        const currentApp: Record<string, unknown> = appSnapshot.data() ?? {};
        const currentUser: Record<string, unknown> = userSnapshot.data() ?? {};

        if (Object.keys(appDelta).length > 0) {
          tx.set(appRef, appDelta, {merge: true});
        }
        if (Object.keys(userDelta).length > 0) {
          tx.set(userRef, userDelta, {merge: true});
        }

        tx.set(sessionRef, {
          id,
          appName,
          userId,
          state: JSON.stringify(sessionState),
          createTime: now,
          updateTime: now,
          revision: 0,
        });

        return [currentApp, currentUser];
      },
    );

    return createSession({
      id,
      appName,
      userId,
      state: mergeStates(
        {...appState, ...appDelta},
        {...userState, ...userDelta},
        sessionState,
      ),
      events: [],
      lastUpdateTime: nowMillis,
    });
  }

  async getSession({
    appName,
    userId,
    sessionId,
    config,
  }: GetSessionRequest): Promise<Session | undefined> {
    const sessionRef = this.sessionRef(appName, userId, sessionId);
    const data: StoredSession | undefined = (await sessionRef.get()).data();
    if (!data || Object.keys(data).length === 0) {
      return undefined;
    }

    const [events, appSnapshot, userSnapshot] = await Promise.all([
      fetchEvents(sessionRef, config),
      this.appStateRef(appName).get(),
      this.userStateRef(appName, userId).get(),
    ]);

    return createSession({
      id: sessionId,
      appName,
      userId,
      state: mergeStates(
        appSnapshot.data(),
        userSnapshot.data(),
        parseSessionState(data.state),
      ),
      events,
      lastUpdateTime: toLastUpdateTime(data.updateTime),
    });
  }

  async listSessions(
    request: ListSessionsRequest,
  ): Promise<ListSessionsResponse> {
    const {appName, userId} = request;
    const [snapshot, appSnapshot, userSnapshot] = await Promise.all([
      this.sessionsRef(appName, userId).get(),
      this.appStateRef(appName).get(),
      this.userStateRef(appName, userId).get(),
    ]);

    const appState = appSnapshot.data();
    const userState = userSnapshot.data();
    const sessions = snapshot.docs.map((doc) => {
      const data: StoredSession = doc.data();
      return createSession({
        id: doc.id,
        appName,
        userId,
        state: mergeStates(appState, userState, parseSessionState(data.state)),
        events: [],
        lastUpdateTime: toLastUpdateTime(data.updateTime),
      });
    });

    return paginateSessions(sessions, request);
  }

  async deleteSession({
    appName,
    userId,
    sessionId,
  }: DeleteSessionRequest): Promise<void> {
    const sessionRef = this.sessionRef(appName, userId, sessionId);

    // The marker lets a concurrent append fail rather than resurrect a
    // half-deleted session. It is best effort: failing to write it must not
    // block the delete.
    try {
      await this.client.runTransaction(async (tx) => {
        if ((await tx.get(sessionRef)).exists) {
          tx.update(sessionRef, {status: DELETING_STATUS});
        }
      });
    } catch (e: unknown) {
      getLogger().debug(
        `Failed to mark session ${sessionId} as deleting: ${String(e)}`,
      );
    }

    const eventRefs = await sessionRef
      .collection(EVENTS_COLLECTION)
      .listDocuments();
    for (let i = 0; i < eventRefs.length; i += MAX_DELETES_PER_BATCH) {
      const batch = this.client.batch();
      for (const ref of eventRefs.slice(i, i + MAX_DELETES_PER_BATCH)) {
        batch.delete(ref);
      }
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

    const trimmed = trimTempDeltaState(event);
    const {
      app: appDelta,
      user: userDelta,
      session: sessionDelta,
    } = splitStateDelta(trimmed.actions.stateDelta);
    const hasAppDelta = Object.keys(appDelta).length > 0;
    const hasUserDelta = Object.keys(userDelta).length > 0;

    const sessionRef = this.sessionRef(
      session.appName,
      session.userId,
      session.id,
    );

    await this.client.runTransaction(async (tx) => {
      const data: StoredSession | undefined = (await tx.get(sessionRef)).data();
      if (!data) {
        throw new Error(`Session ${session.id} not found for appendEvent`);
      }
      if (data.status === DELETING_STATUS) {
        throw new Error(`Session ${session.id} is currently being deleted.`);
      }

      // Both written values derive from the snapshot just read, so they sit in
      // the transaction's read set and Firestore aborts and re-runs this
      // callback if a concurrent writer commits first. Deriving the state from
      // the caller's in-memory `session.state` instead would put it outside the
      // read set, leaving the conflict undetectable and letting a stale caller
      // clobber another writer's keys.
      tx.update(sessionRef, {
        state: JSON.stringify({
          ...parseSessionState(data.state),
          ...sessionDelta,
        }),
        updateTime: Timestamp.fromMillis(trimmed.timestamp),
        revision: (data.revision ?? 0) + 1,
      });

      // `merge` merges field by field on the server, so these need no read.
      if (hasAppDelta) {
        tx.set(this.appStateRef(session.appName), appDelta, {merge: true});
      }
      if (hasUserDelta) {
        tx.set(this.userStateRef(session.appName, session.userId), userDelta, {
          merge: true,
        });
      }

      tx.set(sessionRef.collection(EVENTS_COLLECTION).doc(trimmed.id), {
        [EVENT_DATA_FIELD]: toEventData(trimmed),
        timestamp: Timestamp.fromMillis(trimmed.timestamp),
        appName: session.appName,
        userId: session.userId,
      });
    });

    session.lastUpdateTime = trimmed.timestamp;
    return super.appendEvent({session, event: trimmed});
  }

  private sessionsRef(appName: string, userId: string): CollectionReference {
    return this.client
      .collection(this.rootCollection)
      .doc(appName)
      .collection(USERS_COLLECTION)
      .doc(userId)
      .collection(SESSIONS_COLLECTION);
  }

  private sessionRef(
    appName: string,
    userId: string,
    sessionId: string,
  ): DocumentReference {
    return this.sessionsRef(appName, userId).doc(sessionId);
  }

  private appStateRef(appName: string): DocumentReference {
    return this.client.collection(APP_STATE_COLLECTION).doc(appName);
  }

  private userStateRef(appName: string, userId: string): DocumentReference {
    return this.client
      .collection(USER_STATE_COLLECTION)
      .doc(appName)
      .collection(USERS_COLLECTION)
      .doc(userId);
  }
}
