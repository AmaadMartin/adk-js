/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  CollectionReference,
  DocumentReference,
  Firestore,
  Query,
  QueryDocumentSnapshot,
} from '@google-cloud/firestore';

/** The root collection used when nothing else is configured. */
export const DEFAULT_ROOT_COLLECTION = 'adk-session';

/** Holds one user's sessions, and the collection group `listSessions` queries. */
export const SESSIONS_COLLECTION = 'sessions';

/** Holds one session's events. */
export const EVENTS_COLLECTION = 'events';

/** Holds one document of app-scoped state per app. */
export const APP_STATE_COLLECTION = 'app_states';

/** Holds one document of user-scoped state per app and user. */
export const USER_STATE_COLLECTION = 'user_states';

/** The intermediate collection under an app in the session and user trees. */
export const USERS_COLLECTION = 'users';

/** How many writes Firestore accepts in one batch. */
export const FIRESTORE_MAX_BATCH_WRITES = 500;

const MILLIS_PER_SECOND = 1000;

/** A Firestore `Timestamp`, matched by shape rather than by identity. */
interface MillisConvertible {
  toMillis(): number;
}

/** A `Date`, matched by shape rather than by identity. */
interface TimeConvertible {
  getTime(): number;
}

function hasMethod<K extends string>(
  value: unknown,
  name: K,
): value is Record<K, () => number> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Record<string, unknown>)[name] === 'function'
  );
}

function isMillisConvertible(value: unknown): value is MillisConvertible {
  return hasMethod(value, 'toMillis');
}

function isTimeConvertible(value: unknown): value is TimeConvertible {
  return hasMethod(value, 'getTime');
}

/**
 * Reads a stored `updateTime` field as epoch milliseconds.
 *
 * Firestore hands back a `Timestamp` for a field it wrote itself, but the same
 * database can also hold a `Date` or a bare number: adk-python stores epoch
 * **seconds** there, while adk-js carries milliseconds throughout
 * (`Session.lastUpdateTime`, `Event.timestamp`). A bare number is therefore
 * read as seconds and scaled. A value this function cannot read becomes `0`,
 * which is what a session with no recorded update time reports.
 */
export function toEpochMillis(value: unknown): number {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value * MILLIS_PER_SECOND : 0;
  }
  if (isMillisConvertible(value)) {
    return value.toMillis();
  }
  if (isTimeConvertible(value)) {
    return value.getTime();
  }
  return 0;
}

/**
 * Returns true when a stream chunk is a query result document.
 *
 * `Query.stream()` is typed `NodeJS.ReadableStream`, whose async-iterator
 * signature yields `string | Buffer`, so the documents it really emits have to
 * be narrowed rather than cast.
 */
export function isQueryDocumentSnapshot(
  chunk: unknown,
): chunk is QueryDocumentSnapshot {
  return (
    typeof chunk === 'object' &&
    chunk !== null &&
    'ref' in chunk &&
    typeof (chunk as {data?: unknown}).data === 'function'
  );
}

/**
 * Iterates the documents a query matches, one at a time.
 *
 * Streaming rather than reading the whole result keeps a long transcript off
 * the heap, which is what makes batched deletion worth doing at all.
 */
export async function* streamQueryDocuments(
  query: Query,
): AsyncGenerator<QueryDocumentSnapshot> {
  for await (const chunk of query.stream()) {
    if (isQueryDocumentSnapshot(chunk)) {
      yield chunk;
    }
  }
}

/** The collection holding one user's sessions. */
export function sessionsCollection(
  client: Firestore,
  rootCollection: string,
  appName: string,
  userId: string,
): CollectionReference {
  return client
    .collection(rootCollection)
    .doc(appName)
    .collection(USERS_COLLECTION)
    .doc(userId)
    .collection(SESSIONS_COLLECTION);
}

/** The document holding one app's shared state. */
export function appStateDoc(
  client: Firestore,
  appName: string,
): DocumentReference {
  return client.collection(APP_STATE_COLLECTION).doc(appName);
}

/** The collection holding one app's per-user state documents. */
export function userStatesCollection(
  client: Firestore,
  appName: string,
): CollectionReference {
  return client
    .collection(USER_STATE_COLLECTION)
    .doc(appName)
    .collection(USERS_COLLECTION);
}

/** The document holding one user's state for one app. */
export function userStateDoc(
  client: Firestore,
  appName: string,
  userId: string,
): DocumentReference {
  return userStatesCollection(client, appName).doc(userId);
}
