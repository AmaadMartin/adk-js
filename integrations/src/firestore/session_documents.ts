/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  createEvent,
  Event,
  GetSessionConfig,
  transformToCamelCaseEvent,
} from '@google/adk';
import type {
  FirestoreClient,
  FirestoreCollection,
  FirestoreDocument,
  FirestoreQuery,
  FirestoreSnapshot,
} from './firestore_client.js';

/**
 * The Firestore layout this service reads and writes.
 *
 * ```
 * <root>/{appName}/users/{userId}/sessions/{sessionId}
 *   └─ events/{eventId}
 * app_states/{appName}
 * user_states/{appName}/users/{userId}
 * ```
 *
 * The collection names and the document field names below are the wire
 * contract shared with adk-python's `FirestoreSessionService`, so they are
 * spelled exactly as that implementation writes them — `appName` and
 * `event_data` side by side — rather than being normalised to one convention.
 */

/** Default name of the root collection holding every app's sessions. */
export const DEFAULT_ROOT_COLLECTION = 'adk-session';
/** Name of the per-user collection holding one user's sessions. */
export const DEFAULT_SESSIONS_COLLECTION = 'sessions';
/** Name of the per-session collection holding that session's events. */
export const DEFAULT_EVENTS_COLLECTION = 'events';
/** Name of the collection holding each app's shared state. */
export const DEFAULT_APP_STATE_COLLECTION = 'app_states';
/** Name of the collection holding each user's shared state. */
export const DEFAULT_USER_STATE_COLLECTION = 'user_states';

/** Sub-collection grouping the users of one app. */
const USERS_COLLECTION = 'users';

/** Value of the session document's `status` field while it is being deleted. */
export const DELETING_STATUS = 'DELETING';

/** Returns the collection holding one user's sessions. */
export function sessionsRef(
  client: FirestoreClient,
  rootCollection: string,
  appName: string,
  userId: string,
): FirestoreCollection {
  return client
    .collection(rootCollection)
    .doc(appName)
    .collection(USERS_COLLECTION)
    .doc(userId)
    .collection(DEFAULT_SESSIONS_COLLECTION);
}

/** Returns the document holding one app's shared state. */
export function appStateRef(
  client: FirestoreClient,
  appName: string,
): FirestoreDocument {
  return client.collection(DEFAULT_APP_STATE_COLLECTION).doc(appName);
}

/** Returns the collection holding the shared state of one app's users. */
export function userStatesRef(
  client: FirestoreClient,
  appName: string,
): FirestoreCollection {
  return client
    .collection(DEFAULT_USER_STATE_COLLECTION)
    .doc(appName)
    .collection(USERS_COLLECTION);
}

/** Returns the document holding one user's shared state. */
export function userStateRef(
  client: FirestoreClient,
  appName: string,
  userId: string,
): FirestoreDocument {
  return userStatesRef(client, appName).doc(userId);
}

/** Narrows a value read out of a document to a record. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Returns what a snapshot holds, or an empty record when it holds nothing. */
export function snapshotData(
  snapshot: FirestoreSnapshot,
): Record<string, unknown> {
  return snapshot.data() ?? {};
}

/** Returns a document's revision, treating an unwritten one as zero. */
export function toRevision(revision: unknown): number {
  return typeof revision === 'number' ? revision : 0;
}

function isDate(value: unknown): value is Date {
  return Object.prototype.toString.call(value) === '[object Date]';
}

function hasToMillis(value: unknown): value is {toMillis(): number} {
  return (
    typeof value === 'object' &&
    value !== null &&
    'toMillis' in value &&
    typeof value.toMillis === 'function'
  );
}

/**
 * Converts a stored `updateTime` to epoch milliseconds.
 *
 * Firestore reads a server timestamp back as a `Timestamp`, but a document
 * written by another client can hold a `Date` or a plain number instead.
 * Anything else reads as 0, the value an unwritten session carries.
 * Milliseconds, not seconds: a caller must be able to feed
 * `session.lastUpdateTime` straight back into `config.afterTimestamp`.
 */
export function toLastUpdateTime(updateTime: unknown): number {
  if (!updateTime) {
    return 0;
  }
  if (hasToMillis(updateTime)) {
    return updateTime.toMillis();
  }
  if (isDate(updateTime)) {
    return updateTime.getTime();
  }
  const millis = Number(updateTime);
  return Number.isFinite(millis) ? millis : 0;
}

/**
 * Reads the session-scoped state out of a stored session document.
 *
 * This service writes it as a JSON string. A document written by another
 * client can hold the object directly, so both forms are accepted.
 */
export function parseSessionState(raw: unknown): Record<string, unknown> {
  const parsed: unknown = typeof raw === 'string' ? JSON.parse(raw) : raw;
  return isRecord(parsed) ? parsed : {};
}

/** The identifying fields of a stored session document. */
export interface SessionRow {
  id: string;
  appName: string;
  userId: string;
  state: unknown;
  updateTime: unknown;
}

/**
 * Reads a stored session document, or returns undefined when it is not one.
 *
 * A collection-group query matches every `sessions` sub-collection in the
 * database, including documents this service never wrote, so a document
 * missing its identifying fields is skipped rather than trusted.
 */
export function toSessionRow(
  data: Record<string, unknown>,
): SessionRow | undefined {
  const {id, appName, userId} = data;
  if (
    typeof id !== 'string' ||
    typeof appName !== 'string' ||
    typeof userId !== 'string'
  ) {
    return undefined;
  }
  return {
    id,
    appName,
    userId,
    state: data['state'],
    updateTime: data['updateTime'],
  };
}

/**
 * Builds the query for a session's events, or returns undefined when the
 * caller asked for none.
 *
 * A requested count of zero asks for no event history at all — callers use it
 * to probe whether a session exists — so the query is skipped rather than
 * reading the whole transcript.
 */
function eventsQuery(
  sessionRef: FirestoreDocument,
  config?: GetSessionConfig,
): FirestoreQuery | undefined {
  if (config?.numRecentEvents === 0) {
    return undefined;
  }
  let query: FirestoreQuery = sessionRef
    .collection(DEFAULT_EVENTS_COLLECTION)
    .orderBy('timestamp');
  if (config?.afterTimestamp) {
    // The cursor is epoch milliseconds. Firestore encodes a Date as a UTC
    // timestamp, so it lands on exactly the instant the caller asked for.
    query = query.where('timestamp', '>=', new Date(config.afterTimestamp));
  }
  if (config?.numRecentEvents !== undefined) {
    query = query.limitToLast(config.numRecentEvents);
  }
  return query;
}

/** Reads a session's events, oldest first. */
export async function readEvents(
  sessionRef: FirestoreDocument,
  config?: GetSessionConfig,
): Promise<Event[]> {
  const query = eventsQuery(sessionRef, config);
  if (!query) {
    return [];
  }
  const snapshot = await query.get();
  const events: Event[] = [];
  for (const doc of snapshot.docs) {
    const eventData = doc.data()['event_data'];
    if (isRecord(eventData)) {
      events.push(createEvent(transformToCamelCaseEvent(eventData)));
    }
  }
  return events;
}
