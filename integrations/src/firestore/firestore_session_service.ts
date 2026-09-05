/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AlreadyExistsError,
  AppendEventRequest,
  BaseSessionService,
  createSession,
  CreateSessionRequest,
  DeleteSessionRequest,
  Event,
  extractStateDelta,
  GetSessionRequest,
  ListSessionsRequest,
  ListSessionsResponse,
  loadOptionalPeer,
  makeJsonSafeState,
  mergeStates,
  OptionalPeer,
  paginateSessions,
  randomUUID,
  Session,
  SessionNotFoundError,
  StaleSessionError,
  toJsonSafe,
  transformToSnakeCaseEvent,
  trimTempDeltaState,
} from '@google/adk';
import type {FirestoreClient} from './firestore_client.js';
import {KeyedMutex} from './keyed_mutex.js';
import {
  appStateRef,
  DEFAULT_EVENTS_COLLECTION,
  DEFAULT_ROOT_COLLECTION,
  DEFAULT_SESSIONS_COLLECTION,
  DELETING_STATUS,
  parseSessionState,
  readEvents,
  sessionsRef,
  snapshotData,
  toLastUpdateTime,
  toRevision,
  toSessionRow,
  userStateRef,
  userStatesRef,
} from './session_documents.js';

export {DEFAULT_ROOT_COLLECTION} from './session_documents.js';

/** Environment variable that overrides the default root collection name. */
const ROOT_COLLECTION_ENV_VAR = 'ADK_FIRESTORE_ROOT_COLLECTION';

/** The optional peer dependency this service loads on first use. */
export const FIRESTORE_PEER: OptionalPeer = {
  packageName: '@google-cloud/firestore',
  feature: 'FirestoreSessionService',
};

/** Firestore commits at most this many writes in one batch. */
const MAX_BATCH_WRITES = 500;

/** Options for {@link FirestoreSessionService}. */
export interface FirestoreSessionServiceOptions {
  /**
   * An existing Firestore client. One is created with the default project and
   * credentials when this is omitted. A `Firestore` from
   * `@google-cloud/firestore` satisfies {@link FirestoreClient}.
   */
  client?: FirestoreClient;
  /**
   * Name of the root collection holding every app's sessions. Defaults to the
   * `ADK_FIRESTORE_ROOT_COLLECTION` environment variable, then to
   * `DEFAULT_ROOT_COLLECTION`.
   */
  rootCollection?: string;
}

/** The Firestore client and the timestamp factory that goes with it. */
interface FirestoreRuntime {
  client: FirestoreClient;
  serverTimestamp: () => unknown;
}

/**
 * Returns the client to use: the caller's, or a new one built from the
 * ambient project and credentials.
 */
export function resolveClient(
  injected: FirestoreClient | undefined,
  firestore: {Firestore: new () => FirestoreClient},
): FirestoreClient {
  return injected ?? new firestore.Firestore();
}

/** Serializes appends against one session. */
function lockKey({appName, userId, id}: Session): string {
  return `${appName}\u0000${userId}\u0000${id}`;
}

/** Orders sessions by last update time, then user, then id. */
function compareSessions(left: Session, right: Session): number {
  return (
    left.lastUpdateTime - right.lastUpdateTime ||
    left.userId.localeCompare(right.userId) ||
    left.id.localeCompare(right.id)
  );
}

/**
 * A {@link BaseSessionService} backed by Google Cloud Firestore.
 *
 * Sessions live under a root collection, one sub-collection of events per
 * session, with app-scoped and user-scoped state in collections of their own
 * so that they are shared across sessions:
 *
 * ```
 * adk-session/{appName}/users/{userId}/sessions/{sessionId}/events/{eventId}
 * app_states/{appName}
 * user_states/{appName}/users/{userId}
 * ```
 *
 * Every append bumps a revision on the session document. A session carries
 * the revision it was loaded at in `storageUpdateMarker`, and an append whose
 * marker no longer matches storage is rejected with {@link StaleSessionError}
 * rather than overwriting another writer's work.
 *
 * `@google-cloud/firestore` is an optional peer dependency: it is loaded on
 * first use, so an application that does not store sessions in Firestore does
 * not have to install it.
 */
export class FirestoreSessionService extends BaseSessionService {
  private readonly injectedClient?: FirestoreClient;
  private readonly rootCollection: string;
  private readonly locks = new KeyedMutex();
  private runtime?: Promise<FirestoreRuntime>;

  constructor(options: FirestoreSessionServiceOptions = {}) {
    super();
    this.injectedClient = options.client;
    this.rootCollection =
      options.rootCollection ||
      process.env[ROOT_COLLECTION_ENV_VAR] ||
      DEFAULT_ROOT_COLLECTION;
  }

  private firestore(): Promise<FirestoreRuntime> {
    this.runtime ??= loadOptionalPeer(
      FIRESTORE_PEER,
      () => import('@google-cloud/firestore'),
    ).then((firestore) => ({
      client: resolveClient(this.injectedClient, firestore),
      serverTimestamp: () => firestore.FieldValue.serverTimestamp(),
    }));
    return this.runtime;
  }

  async createSession({
    appName,
    userId,
    state,
    sessionId,
  }: CreateSessionRequest): Promise<Session> {
    const {client, serverTimestamp} = await this.firestore();
    const id = sessionId || randomUUID();

    // App and user state are written natively so that rich types survive; only
    // the session bucket is JSON-stringified, so only it is coerced.
    const delta = extractStateDelta(state);
    const sessionState = makeJsonSafeState(delta.session);

    const sessionRef = sessionsRef(
      client,
      this.rootCollection,
      appName,
      userId,
    ).doc(id);
    const appRef = appStateRef(client, appName);
    const userRef = userStateRef(client, appName, userId);
    const now = serverTimestamp();

    const [storedAppState, storedUserState] = await client.runTransaction(
      async (transaction) => {
        const [sessionSnapshot, appSnapshot, userSnapshot] = await Promise.all([
          transaction.get(sessionRef),
          transaction.get(appRef),
          transaction.get(userRef),
        ]);
        if (sessionSnapshot.exists) {
          throw new AlreadyExistsError(`Session ${id} already exists.`);
        }

        const appState = {...snapshotData(appSnapshot), ...delta.app};
        const userState = {...snapshotData(userSnapshot), ...delta.user};
        if (Object.keys(delta.app).length > 0) {
          transaction.set(appRef, appState, {merge: true});
        }
        if (Object.keys(delta.user).length > 0) {
          transaction.set(userRef, userState, {merge: true});
        }
        transaction.set(sessionRef, {
          id,
          appName,
          userId,
          state: JSON.stringify(sessionState),
          createTime: now,
          updateTime: now,
          revision: 0,
        });
        return [appState, userState];
      },
    );

    const session = createSession({
      id,
      appName,
      userId,
      state: mergeStates(storedAppState, storedUserState, sessionState),
      events: [],
      lastUpdateTime: Date.now(),
    });
    session.storageUpdateMarker = '0';
    return session;
  }

  async getSession({
    appName,
    userId,
    sessionId,
    config,
  }: GetSessionRequest): Promise<Session | undefined> {
    const {client} = await this.firestore();
    const sessionRef = sessionsRef(
      client,
      this.rootCollection,
      appName,
      userId,
    ).doc(sessionId);

    const snapshot = await sessionRef.get();
    if (!snapshot.exists) {
      return undefined;
    }
    const data = snapshotData(snapshot);
    if (Object.keys(data).length === 0) {
      return undefined;
    }

    const [events, appSnapshot, userSnapshot] = await Promise.all([
      readEvents(sessionRef, config),
      appStateRef(client, appName).get(),
      userStateRef(client, appName, userId).get(),
    ]);

    const session = createSession({
      id: sessionId,
      appName,
      userId,
      state: mergeStates(
        snapshotData(appSnapshot),
        snapshotData(userSnapshot),
        parseSessionState(data['state']),
      ),
      events,
      lastUpdateTime: toLastUpdateTime(data['updateTime']),
    });
    session.storageUpdateMarker = String(toRevision(data['revision']));
    return session;
  }

  async listSessions(
    request: ListSessionsRequest,
  ): Promise<ListSessionsResponse> {
    const {appName, userId, order} = request;
    const {client} = await this.firestore();

    const query = userId
      ? sessionsRef(client, this.rootCollection, appName, userId).where(
          'appName',
          '==',
          appName,
        )
      : client
          .collectionGroup(DEFAULT_SESSIONS_COLLECTION)
          .where('appName', '==', appName);

    const [snapshot, appSnapshot] = await Promise.all([
      query.get(),
      appStateRef(client, appName).get(),
    ]);

    const rows = snapshot.docs
      .map((doc) => toSessionRow(doc.data()))
      .filter((row): row is NonNullable<typeof row> => row !== undefined);
    const appState = snapshotData(appSnapshot);
    const userStates = await this.readUserStates(client, appName, userId, rows);

    const sessions = rows.map((row) =>
      createSession({
        id: row.id,
        appName: row.appName,
        userId: row.userId,
        state: mergeStates(
          appState,
          userStates.get(row.userId) ?? {},
          parseSessionState(row.state),
        ),
        events: [],
        lastUpdateTime: toLastUpdateTime(row.updateTime),
      }),
    );

    // A collection-group query has no inherent order, so the reference
    // implementation's ordering is applied here rather than in Firestore.
    sessions.sort(compareSessions);
    if (order === 'desc') {
      sessions.reverse();
    }
    return paginateSessions(sessions, request);
  }

  /**
   * Reads the shared state of every user the listed sessions belong to, in
   * one round trip rather than one read per session.
   */
  private async readUserStates(
    client: FirestoreClient,
    appName: string,
    userId: string | undefined,
    rows: Array<{userId: string}>,
  ): Promise<Map<string, Record<string, unknown>>> {
    const states = new Map<string, Record<string, unknown>>();
    if (userId) {
      const snapshot = await userStateRef(client, appName, userId).get();
      if (snapshot.exists) {
        states.set(userId, snapshotData(snapshot));
      }
      return states;
    }

    const userIds = [...new Set(rows.map((row) => row.userId))].sort();
    if (userIds.length === 0) {
      return states;
    }
    const usersRef = userStatesRef(client, appName);
    const snapshots = await client.getAll(
      ...userIds.map((id) => usersRef.doc(id)),
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
    const {client} = await this.firestore();
    const sessionRef = sessionsRef(
      client,
      this.rootCollection,
      appName,
      userId,
    ).doc(sessionId);

    // Best effort: the marker stops a concurrent append from writing into a
    // session that is going away, but failing to set it must not stop the
    // deletion itself.
    try {
      await client.runTransaction(async (transaction) => {
        const snapshot = await transaction.get(sessionRef);
        if (snapshot.exists) {
          transaction.update(sessionRef, {status: DELETING_STATUS});
        }
      });
    } catch {
      // Deleted below regardless.
    }

    const events = await sessionRef.collection(DEFAULT_EVENTS_COLLECTION).get();
    let batch = client.batch();
    let queued = 0;
    for (const doc of events.docs) {
      batch.delete(doc.ref);
      queued++;
      if (queued >= MAX_BATCH_WRITES) {
        await batch.commit();
        batch = client.batch();
        queued = 0;
      }
    }
    if (queued > 0) {
      await batch.commit();
    }

    await sessionRef.delete();
  }

  async appendEvent({session, event}: AppendEventRequest): Promise<Event> {
    if (event.partial) {
      return event;
    }
    const {client, serverTimestamp} = await this.firestore();

    // adk-js drops `temp:` keys entirely rather than keeping them readable for
    // the rest of the invocation; see `BaseSessionService.appendEvent`.
    event = trimTempDeltaState(event);
    const delta = extractStateDelta(event.actions.stateDelta);

    const sessionRef = sessionsRef(
      client,
      this.rootCollection,
      session.appName,
      session.userId,
    ).doc(session.id);
    const appRef = appStateRef(client, session.appName);
    const userRef = userStateRef(client, session.appName, session.userId);

    const revision = await this.locks.runExclusive(lockKey(session), () =>
      client.runTransaction(async (transaction) => {
        const snapshot = await transaction.get(sessionRef);
        if (!snapshot.exists) {
          throw new SessionNotFoundError(`Session ${session.id} not found.`);
        }
        const data = snapshotData(snapshot);
        if (data['status'] === DELETING_STATUS) {
          throw new Error(`Session ${session.id} is currently being deleted.`);
        }

        const storedRevision = toRevision(data['revision']);
        if (
          session.storageUpdateMarker !== undefined &&
          session.storageUpdateMarker !== String(storedRevision)
        ) {
          throw new StaleSessionError();
        }

        const [appSnapshot, userSnapshot] = await Promise.all([
          Object.keys(delta.app).length > 0
            ? transaction.get(appRef)
            : undefined,
          Object.keys(delta.user).length > 0
            ? transaction.get(userRef)
            : undefined,
        ]);
        if (appSnapshot) {
          transaction.set(
            appRef,
            {...snapshotData(appSnapshot), ...delta.app},
            {merge: true},
          );
        }
        if (userSnapshot) {
          transaction.set(
            userRef,
            {...snapshotData(userSnapshot), ...delta.user},
            {merge: true},
          );
        }

        // The base class merges the raw delta back into `session.state` on
        // every append, so a value from an earlier turn that JSON cannot
        // represent is still sitting there: the whole merged bucket is
        // coerced, not just this event's delta.
        const sessionState = makeJsonSafeState({
          ...extractStateDelta(session.state).session,
          ...delta.session,
        });
        transaction.update(sessionRef, {
          state: JSON.stringify(sessionState),
          updateTime: serverTimestamp(),
          revision: storedRevision + 1,
        });
        transaction.set(
          sessionRef.collection(DEFAULT_EVENTS_COLLECTION).doc(event.id),
          {
            event_data: toJsonSafe(transformToSnakeCaseEvent(event)).record,
            timestamp: serverTimestamp(),
            appName: session.appName,
            userId: session.userId,
          },
        );
        return storedRevision + 1;
      }),
    );

    session.storageUpdateMarker = String(revision);
    session.lastUpdateTime = event.timestamp;
    return super.appendEvent({session, event});
  }
}
