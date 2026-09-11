/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The slice of the `@google-cloud/firestore` client surface a session service
 * uses.
 *
 * The service is declared against these interfaces rather than against the
 * SDK's concrete classes so that it can be driven by an in-memory double: the
 * classes carry dozens of members and no test-constructible form, so a
 * stand-in could only satisfy them through an unchecked cast. A real
 * `Firestore` satisfies every member below, which the `accepts a real
 * Firestore client` case in
 * `integrations/test/firestore/firestore_session_service_test.ts` asserts
 * against the SDK's own type.
 */

/** A document, as read or written. */
export interface FirestoreSnapshot {
  readonly id: string;
  readonly exists: boolean;
  readonly ref: FirestoreDocument;
  data(): Record<string, unknown> | undefined;
}

/** A document returned by a query, which always exists. */
export interface FirestoreQueryDocument {
  readonly id: string;
  readonly ref: FirestoreDocument;
  data(): Record<string, unknown>;
}

/** The result of running a query. */
export interface FirestoreQuerySnapshot {
  readonly docs: FirestoreQueryDocument[];
}

/** A query over a collection, or over every collection with one id. */
export interface FirestoreQuery {
  where(field: string, operator: string, value: unknown): FirestoreQuery;
  orderBy(field: string): FirestoreQuery;
  limitToLast(limit: number): FirestoreQuery;
  get(): Promise<FirestoreQuerySnapshot>;
}

/** A collection of documents. */
export interface FirestoreCollection extends FirestoreQuery {
  doc(documentPath: string): FirestoreDocument;
}

/** A reference to one document. */
export interface FirestoreDocument {
  readonly id: string;
  readonly path: string;
  collection(collectionPath: string): FirestoreCollection;
  get(): Promise<FirestoreSnapshot>;
  delete(): Promise<unknown>;
}

/** How a `set` combines with what the document already holds. */
export interface FirestoreSetOptions {
  readonly merge?: boolean;
}

/** Reads and writes that commit together, or not at all. */
export interface FirestoreTransaction {
  get(documentRef: FirestoreDocument): Promise<FirestoreSnapshot>;
  set(
    documentRef: FirestoreDocument,
    data: Record<string, unknown>,
    options?: FirestoreSetOptions,
  ): unknown;
  update(
    documentRef: FirestoreDocument,
    data: Record<string, unknown>,
  ): unknown;
}

/** Writes that commit together, without reads. */
export interface FirestoreBatch {
  delete(documentRef: FirestoreDocument): unknown;
  commit(): Promise<unknown>;
}

/**
 * A trailing field mask on a batch read.
 *
 * The service never passes one, but the SDK's `getAll` accepts it, so the
 * parameter type has to allow it for a real `Firestore` to satisfy this
 * interface.
 */
export interface FirestoreReadOptions {
  readonly fieldMask?: readonly unknown[];
}

/** The Firestore client itself. */
export interface FirestoreClient {
  collection(collectionPath: string): FirestoreCollection;
  collectionGroup(collectionId: string): FirestoreQuery;
  getAll(
    ...documentRefs: Array<FirestoreDocument | FirestoreReadOptions>
  ): Promise<FirestoreSnapshot[]>;
  runTransaction<T>(
    updateFunction: (transaction: FirestoreTransaction) => Promise<T>,
  ): Promise<T>;
  batch(): FirestoreBatch;
}
