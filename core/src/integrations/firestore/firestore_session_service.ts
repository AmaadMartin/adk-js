/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  DocumentData,
  DocumentReference,
  DocumentSnapshot,
  FieldValue,
  Firestore,
  Query,
  Settings,
  Timestamp,
  Transaction,
} from '@google-cloud/firestore';

import {AlreadyExistsError} from '../../errors/already_exists_error.js';
import {SessionNotFoundError} from '../../errors/session_not_found_error.js';
import {StaleSessionError} from '../../errors/stale_session_error.js';
import {
  Event,
  transformToCamelCaseEvent,
  transformToSnakeCaseEvent,
} from '../../events/event.js';
import {
  AppendEventRequest,
  applyTempState,
  BaseSessionService,
  CreateSessionRequest,
  DeleteSessionRequest,
  extractStateDelta,
  GetSessionRequest,
  GetUserStateRequest,
  ListSessionsRequest,
  ListSessionsResponse,
  mergeStates,
  ScopedStateDelta,
  trimTempDeltaState,
  validateGetSessionConfig,
} from '../../sessions/base_session_service.js';
import {createSession, Session} from '../../sessions/session.js';
import {makeJsonSafeState} from '../../sessions/session_util.js';
import {State} from '../../sessions/state.js';
import {randomUUID} from '../../utils/env_aware_utils.js';
import {formatError} from '../../utils/error_utils.js';
import {KeyedMutex} from '../../utils/keyed_mutex.js';
import {logger} from '../../utils/logger.js';
import {loadOptionalPeer} from '../../utils/optional_peer.js';

import {
  appStateDoc,
  DEFAULT_ROOT_COLLECTION,
  EVENTS_COLLECTION,
  FIRESTORE_MAX_BATCH_WRITES,
  SESSIONS_COLLECTION,
  sessionsCollection,
  streamQueryDocuments,
  toEpochMillis,
  userStateDoc,
  userStatesCollection,
} from './firestore_utils.js';

/**
 * The message a stale write is rejected with. The wording matches adk-python
 * and `DatabaseSessionService`, because it reaches the user.
 */
const STALE_SESSION_ERROR_MESSAGE =
  'The session has been modified in storage since it was loaded. ' +
  'Please reload the session before appending more events.';

/** The `status` a session carries while `deleteSession` is removing it. */
const DELETING_STATUS = 'DELETING';

/** The environment variable that names the root collection. */
const ROOT_COLLECTION_ENV_VAR = 'ADK_FIRESTORE_ROOT_COLLECTION';

/** The parameters for {@link FirestoreSessionService}. */
export interface FirestoreSessionServiceOptions {
  /** A pre-configured client. One is created on first use when omitted. */
  client?: Firestore;
  /** Settings for the client this service creates. Ignored when `client` is set. */
  settings?: Settings;
  /**
   * The root collection sessions are stored under. Defaults to the
   * `ADK_FIRESTORE_ROOT_COLLECTION` environment variable, then to
   * `'adk-session'`.
   */
  rootCollection?: string;
}

/**
 * The client and the module-level values the service writes with.
 *
 * `FieldValue.serverTimestamp()` and `Timestamp.fromMillis()` are module
 * exports rather than client members, so the namespace is kept alongside the
 * client.
 */
interface FirestoreRuntime {
  client: Firestore;
  FieldValue: typeof FieldValue;
  Timestamp: typeof Timestamp;
}

/** The fields a session document holds. */
interface SessionDocument {
  id: string;
  appName: string;
  userId: string;
  /** The session-scoped state, JSON-encoded. */
  state: string;
  createTime: FieldValue;
  updateTime: FieldValue;
  /** The optimistic-concurrency token, incremented by every append. */
  revision: number;
}

/** Reads the data of a snapshot as a plain record, or `{}` when it has none. */
function snapshotData(snapshot?: DocumentSnapshot): Record<string, unknown> {
  return snapshot?.exists ? (snapshot.data() ?? {}) : {};
}

/**
 * Decodes a stored session-state field.
 *
 * The field is written as a JSON string, but a database an older service wrote
 * can hold a map instead, so both are accepted.
 */
function decodeStoredState(raw: unknown): Record<string, unknown> {
  if (typeof raw === 'string') {
    return JSON.parse(raw) as Record<string, unknown>;
  }
  if (typeof raw === 'object' && raw !== null) {
    return raw as Record<string, unknown>;
  }
  return {};
}

/** True when a scoped bucket has anything to write. */
function hasEntries(bucket: Record<string, unknown>): boolean {
  return Object.keys(bucket).length > 0;
}

/**
 * The session-scoped view of a session's state, with the delta applied.
 *
 * `session.state` carries the merged view, including the `app:`, `user:` and
 * `temp:` keys, and the base class merges every raw delta back into it. Only
 * the unprefixed keys belong in the session document, and the result is
 * coerced as a whole because a value from an earlier turn may not survive
 * `JSON.stringify` on its own.
 */
function sessionScopedState(
  session: Session,
  delta: Record<string, unknown>,
): Record<string, unknown> {
  const scoped: Record<string, unknown> = Object.create(null);
  for (const [key, value] of Object.entries(session.state)) {
    if (
      !key.startsWith(State.APP_PREFIX) &&
      !key.startsWith(State.USER_PREFIX) &&
      !key.startsWith(State.TEMP_PREFIX)
    ) {
      scoped[key] = value;
    }
  }
  Object.assign(scoped, delta);
  return makeJsonSafeState(scoped);
}

/**
 * Builds the query that selects a session's events, oldest first.
 *
 * The cursor is a `Timestamp`, because the stored `timestamp` field is one and
 * Firestore compares the two types by value only when both are timestamps.
 */
function buildEventsQuery(
  sessionRef: DocumentReference,
  Timestamp: FirestoreRuntime['Timestamp'],
  config: GetSessionRequest['config'],
): Query {
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
  if (config?.numRecentEvents !== undefined) {
    query = query.limitToLast(config.numRecentEvents);
  }
  return query;
}

/** Reads the events a query matched, dropping any document with no body. */
async function readEvents(query: Query): Promise<Event[]> {
  const snapshot = await query.get();
  const events: Event[] = [];
  for (const doc of snapshot.docs) {
    const eventData: unknown = doc.data()?.['event_data'];
    if (typeof eventData === 'object' && eventData !== null) {
      events.push(
        transformToCamelCaseEvent(eventData as Record<string, unknown>),
      );
    }
  }
  return events;
}

/** Orders listed sessions by update time, then user id, then session id. */
function compareSessions(
  order: ListSessionsRequest['order'],
): (a: Session, b: Session) => number {
  const direction = order === 'desc' ? -1 : 1;
  return (a, b) =>
    direction * (a.lastUpdateTime - b.lastUpdateTime) ||
    a.userId.localeCompare(b.userId) ||
    a.id.localeCompare(b.id);
}

/**
 * Slices a sorted session list into the page the request asked for.
 *
 * Matches `InMemorySessionService`: with no `limit` the whole list comes back
 * as one page, and `page` takes precedence over `offset`.
 */
function paginate(
  all: Session[],
  {limit, offset, page}: ListSessionsRequest,
): ListSessionsResponse {
  const totalItems = all.length;
  if (limit === undefined) {
    return {
      sessions: offset ? all.slice(offset) : all,
      page: 1,
      limit: totalItems,
      totalItems,
      totalPages: totalItems === 0 ? 0 : 1,
    };
  }

  const effectiveOffset =
    page !== undefined ? (page - 1) * limit : (offset ?? 0);
  const effectivePage =
    page ?? (limit === 0 ? 1 : Math.floor(effectiveOffset / limit) + 1);

  return {
    sessions: all.slice(effectiveOffset, effectiveOffset + limit),
    page: effectivePage,
    limit,
    totalItems,
    totalPages: limit === 0 ? 0 : Math.ceil(totalItems / limit),
  };
}

/**
 * A session service backed by Google Cloud Firestore.
 *
 * Sessions and their events are stored under the root collection:
 *
 * ```text
 * <rootCollection>/<appName>/users/<userId>/sessions/<sessionId>/events/<eventId>
 * ```
 *
 * App-scoped and user-scoped state live outside that tree, in `app_states` and
 * `user_states`, so every session of an app or a user reads one copy. The
 * layout and the stored field names match adk-python's
 * `FirestoreSessionService`, so both SDKs can read one database.
 *
 * `@google-cloud/firestore` is an optional peer dependency, loaded on first
 * use. Install it to use this service.
 */
export class FirestoreSessionService extends BaseSessionService {
  /** The root collection, resolved once. */
  readonly rootCollection: string;

  private readonly injectedClient?: Firestore;
  private readonly settings?: Settings;
  private readonly sessionLocks = new KeyedMutex();
  private runtimePromise?: Promise<FirestoreRuntime>;

  constructor(options: FirestoreSessionServiceOptions = {}) {
    super();
    this.injectedClient = options.client;
    this.settings = options.settings;
    this.rootCollection =
      options.rootCollection ??
      process.env[ROOT_COLLECTION_ENV_VAR] ??
      DEFAULT_ROOT_COLLECTION;
  }

  /**
   * Resolves the client and the module values, loading the
   * `@google-cloud/firestore` optional peer on first use.
   *
   * The namespace is loaded even when a client is injected, because
   * `FieldValue` and `Timestamp` are module exports. A caller that injected a
   * client has the package installed, so that load cannot fail for them.
   */
  private getRuntime(): Promise<FirestoreRuntime> {
    this.runtimePromise ??= loadOptionalPeer(
      {
        packageName: '@google-cloud/firestore',
        feature: 'FirestoreSessionService',
      },
      () => import('@google-cloud/firestore'),
    ).then((ns) => ({
      client: this.injectedClient ?? new ns.Firestore(this.settings),
      FieldValue: ns.FieldValue,
      Timestamp: ns.Timestamp,
    }));
    return this.runtimePromise;
  }

  private sessionDoc(
    client: Firestore,
    appName: string,
    userId: string,
    sessionId: string,
  ): DocumentReference {
    return sessionsCollection(client, this.rootCollection, appName, userId).doc(
      sessionId,
    );
  }

  async createSession({
    appName,
    userId,
    state,
    sessionId,
  }: CreateSessionRequest): Promise<Session> {
    const {client, FieldValue} = await this.getRuntime();
    const id = sessionId || randomUUID();

    // App and user state is written natively, so a Date reaches Firestore as a
    // timestamp; only the session bucket is JSON-encoded, so only it is
    // coerced.
    const delta = extractStateDelta(state ?? {});
    const sessionState = makeJsonSafeState(delta.session);

    const sessionRef = this.sessionDoc(client, appName, userId, id);
    const appRef = appStateDoc(client, appName);
    const userRef = userStateDoc(client, appName, userId);

    const now = FieldValue.serverTimestamp();
    const sessionData: SessionDocument = {
      id,
      appName,
      userId,
      state: JSON.stringify(sessionState),
      createTime: now,
      updateTime: now,
      revision: 0,
    };

    const [storedApp, storedUser] = await client.runTransaction(async (t) => {
      const snapshot = await t.get(sessionRef);
      if (snapshot.exists) {
        throw new AlreadyExistsError(`Session ${id} already exists.`);
      }
      const currentApp = snapshotData(await t.get(appRef));
      const currentUser = snapshotData(await t.get(userRef));

      if (hasEntries(delta.app)) {
        Object.assign(currentApp, delta.app);
        t.set(appRef, currentApp, {merge: true});
      }
      if (hasEntries(delta.user)) {
        Object.assign(currentUser, delta.user);
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
    validateGetSessionConfig(config);

    const {client, Timestamp} = await this.getRuntime();
    const sessionRef = this.sessionDoc(client, appName, userId, sessionId);
    const snapshot = await sessionRef.get();
    if (!snapshot.exists) {
      return undefined;
    }
    const data = snapshot.data();
    // Python's `if not data` also rejects an existing document with no fields.
    if (!data || Object.keys(data).length === 0) {
      return undefined;
    }

    const appRef = appStateDoc(client, appName);
    const userRef = userStateDoc(client, appName, userId);

    // A count of zero asks for no history at all — callers use it to probe
    // whether a session exists — so the events query is skipped rather than
    // issued and thrown away.
    const eventsPromise =
      config?.numRecentEvents === 0
        ? Promise.resolve<Event[]>([])
        : readEvents(buildEventsQuery(sessionRef, Timestamp, config));

    const [events, appSnapshot, userSnapshot] = await Promise.all([
      eventsPromise,
      appRef.get(),
      userRef.get(),
    ]);

    return createSession({
      id: sessionId,
      appName,
      userId,
      state: mergeStates(
        snapshotData(appSnapshot),
        snapshotData(userSnapshot),
        decodeStoredState(data['state']),
      ),
      events,
      lastUpdateTime: toEpochMillis(data['updateTime']),
      storageUpdateMarker: String(data['revision'] ?? 0),
    });
  }

  async listSessions(
    request: ListSessionsRequest,
  ): Promise<ListSessionsResponse> {
    const {appName, userId, order} = request;
    const {client} = await this.getRuntime();

    const query = userId
      ? sessionsCollection(client, this.rootCollection, appName, userId).where(
          'appName',
          '==',
          appName,
        )
      : client
          .collectionGroup(SESSIONS_COLLECTION)
          .where('appName', '==', appName);

    const [snapshot, appSnapshot] = await Promise.all([
      query.get(),
      appStateDoc(client, appName).get(),
    ]);
    const appState = snapshotData(appSnapshot);

    const documents = snapshot.docs
      .map((doc) => doc.data())
      .filter(
        (data): data is DocumentData => Object.keys(data ?? {}).length > 0,
      );

    const userStates = await this.readUserStates(
      client,
      appName,
      userId,
      documents,
    );

    const all = documents.map((data) => {
      const sessionUserId = String(data['userId']);
      return createSession({
        id: String(data['id']),
        appName: String(data['appName']),
        userId: sessionUserId,
        state: mergeStates(
          appState,
          userStates.get(sessionUserId) ?? {},
          decodeStoredState(data['state']),
        ),
        events: [],
        lastUpdateTime: toEpochMillis(data['updateTime']),
      });
    });
    all.sort(compareSessions(order));

    return paginate(all, request);
  }

  /**
   * Reads the user-state document of every user the listed sessions belong to.
   *
   * One request when the caller named a user, and one `getAll` for the
   * distinct users otherwise.
   */
  private async readUserStates(
    client: Firestore,
    appName: string,
    userId: string | undefined,
    documents: DocumentData[],
  ): Promise<Map<string, Record<string, unknown>>> {
    const states = new Map<string, Record<string, unknown>>();
    if (userId) {
      const snapshot = await userStateDoc(client, appName, userId).get();
      if (snapshot.exists) {
        states.set(userId, snapshotData(snapshot));
      }
      return states;
    }

    const userIds = [
      ...new Set(
        documents
          .filter((data) => typeof data['userId'] === 'string')
          .map((data) => String(data['userId'])),
      ),
    ].sort();
    if (userIds.length === 0) {
      return states;
    }

    const users = userStatesCollection(client, appName);
    const snapshots = await client.getAll(
      ...userIds.map((id) => users.doc(id)),
    );
    for (const snapshot of snapshots) {
      if (snapshot.exists) {
        states.set(snapshot.id, snapshotData(snapshot));
      }
    }
    return states;
  }

  async deleteSession({
    appName,
    userId,
    sessionId,
  }: DeleteSessionRequest): Promise<void> {
    const {client} = await this.getRuntime();
    const sessionRef = this.sessionDoc(client, appName, userId, sessionId);

    // The marker tells a concurrent `appendEvent` to give up. Losing it costs
    // that warning, not the delete, so the delete goes ahead either way.
    try {
      await client.runTransaction(async (t) => {
        const snapshot = await t.get(sessionRef);
        if (snapshot.exists) {
          t.update(sessionRef, {status: DELETING_STATUS});
        }
      });
    } catch (err: unknown) {
      logger.debug(
        `Failed to mark session ${sessionId} as deleting: ${formatError(err)}`,
      );
    }

    let batch = client.batch();
    let pending = 0;
    for await (const doc of streamQueryDocuments(
      sessionRef.collection(EVENTS_COLLECTION),
    )) {
      batch.delete(doc.ref);
      pending += 1;
      if (pending >= FIRESTORE_MAX_BATCH_WRITES) {
        await batch.commit();
        batch = client.batch();
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

    // Temp state stays readable for the rest of the invocation, so apply it to
    // the in-memory session before trimming it out of the persisted event.
    applyTempState({session, event});
    const trimmed = trimTempDeltaState(event);
    const delta = extractStateDelta(trimmed.actions?.stateDelta ?? {});

    // JSON-encode the tuple so that ('a|b', 'c') and ('a', 'b|c') cannot
    // collide on one lock.
    const lockKey = JSON.stringify([
      session.appName,
      session.userId,
      session.id,
    ]);
    const revision = await this.sessionLocks.runExclusive(lockKey, () =>
      this.writeEvent(session, trimmed, delta),
    );

    session.storageUpdateMarker = String(revision);
    session.lastUpdateTime = trimmed.timestamp;

    return super.appendEvent({session, event: trimmed});
  }

  /**
   * Writes one event and its state delta in a single transaction.
   *
   * @returns The revision the session reaches once the write commits.
   * @throws {SessionNotFoundError} When storage does not hold the session.
   * @throws {StaleSessionError} When storage has moved past the session's
   *     revision.
   */
  private async writeEvent(
    session: Session,
    event: Event,
    delta: ScopedStateDelta,
  ): Promise<number> {
    const {client, FieldValue} = await this.getRuntime();
    const sessionRef = this.sessionDoc(
      client,
      session.appName,
      session.userId,
      session.id,
    );
    const appRef = appStateDoc(client, session.appName);
    const userRef = userStateDoc(client, session.appName, session.userId);
    const writeApp = hasEntries(delta.app);
    const writeUser = hasEntries(delta.user);

    return client.runTransaction(async (t: Transaction) => {
      const snapshot = await t.get(sessionRef);
      if (!snapshot.exists) {
        throw new SessionNotFoundError(`Session ${session.id} not found.`);
      }
      const data = snapshot.data() ?? {};
      if (data['status'] === DELETING_STATUS) {
        throw new Error(`Session ${session.id} is currently being deleted.`);
      }
      const currentRevision = Number(data['revision'] ?? 0);
      if (
        session.storageUpdateMarker !== undefined &&
        session.storageUpdateMarker !== String(currentRevision)
      ) {
        throw new StaleSessionError(STALE_SESSION_ERROR_MESSAGE);
      }

      const currentApp = writeApp ? snapshotData(await t.get(appRef)) : {};
      const currentUser = writeUser ? snapshotData(await t.get(userRef)) : {};

      if (writeApp) {
        Object.assign(currentApp, delta.app);
        t.set(appRef, currentApp, {merge: true});
      }
      if (writeUser) {
        Object.assign(currentUser, delta.user);
        t.set(userRef, currentUser, {merge: true});
      }

      const newRevision = currentRevision + 1;
      t.update(sessionRef, {
        state: JSON.stringify(sessionScopedState(session, delta.session)),
        updateTime: FieldValue.serverTimestamp(),
        revision: newRevision,
      });
      t.set(sessionRef.collection(EVENTS_COLLECTION).doc(event.id), {
        event_data: transformToSnakeCaseEvent(event),
        timestamp: FieldValue.serverTimestamp(),
        appName: session.appName,
        userId: session.userId,
      });
      return newRevision;
    });
  }

  /**
   * Reads the user-scoped state of one user.
   *
   * Firestore holds it in one document, so this needs no session sweep. The
   * keys come back without the `user:` prefix.
   */
  override async getUserState({
    appName,
    userId,
  }: GetUserStateRequest): Promise<Record<string, unknown>> {
    const {client} = await this.getRuntime();
    const snapshot = await userStateDoc(client, appName, userId).get();
    return snapshotData(snapshot);
  }
}
