/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {expect} from 'vitest';
import type {
  FirestoreBatch,
  FirestoreClient,
  FirestoreCollection,
  FirestoreDocument,
  FirestoreQuery,
  FirestoreQueryDocument,
  FirestoreQuerySnapshot,
  FirestoreReadOptions,
  FirestoreSetOptions,
  FirestoreSnapshot,
  FirestoreTransaction,
} from '../../src/firestore/firestore_client.js';

/**
 * An in-memory stand-in for the Firestore client.
 *
 * Documents live in a flat map keyed by path, so a test can seed storage,
 * drive the service, and read back exactly what was written. Transactions
 * buffer their writes and apply them only when the callback resolves, so a
 * test can assert that a rejected transaction wrote nothing.
 */

/** Builds the path of a session document. */
export function sessionPath(
  appName: string,
  userId: string,
  sessionId: string,
  rootCollection = 'adk-session',
): string {
  return `${rootCollection}/${appName}/users/${userId}/sessions/${sessionId}`;
}

/** Builds the path of an event document under a session. */
export function eventPath(
  appName: string,
  userId: string,
  sessionId: string,
  eventId: string,
  rootCollection = 'adk-session',
): string {
  return `${sessionPath(appName, userId, sessionId, rootCollection)}/events/${eventId}`;
}

/** Builds the path of an app-state document. */
export function appStatePath(appName: string): string {
  return `app_states/${appName}`;
}

/** Builds the path of a user-state document. */
export function userStatePath(appName: string, userId: string): string {
  return `user_states/${appName}/users/${userId}`;
}

/** A write buffered by a transaction. */
export interface RecordedWrite {
  kind: 'set' | 'update';
  path: string;
  data: Record<string, unknown>;
  merge: boolean;
}

interface QueryFilter {
  field: string;
  operator: string;
  value: unknown;
}

function isDocument(
  value: FirestoreDocument | FirestoreReadOptions,
): value is FirestoreDocument {
  return 'get' in value && typeof value.get === 'function';
}

function isDate(value: unknown): value is Date {
  return Object.prototype.toString.call(value) === '[object Date]';
}

/** Maps a stored value onto something the fake can order and compare. */
function comparable(value: unknown): number | string {
  if (isDate(value)) {
    return value.getTime();
  }
  if (typeof value === 'number' || typeof value === 'string') {
    return value;
  }
  return String(value);
}

function matches(
  data: Record<string, unknown>,
  {field, operator, value}: QueryFilter,
): boolean {
  const stored = data[field];
  switch (operator) {
    case '==':
      return stored === value;
    case '>=':
      return comparable(stored) >= comparable(value);
    default:
      return expect.fail(
        `FakeFirestore does not implement operator ${operator}`,
      );
  }
}

class FakeSnapshot implements FirestoreSnapshot {
  constructor(
    readonly id: string,
    readonly ref: FirestoreDocument,
    private readonly value: Record<string, unknown> | undefined,
  ) {}

  get exists(): boolean {
    return this.value !== undefined;
  }

  data(): Record<string, unknown> | undefined {
    return this.value;
  }
}

class FakeQueryDocument implements FirestoreQueryDocument {
  constructor(
    readonly id: string,
    readonly ref: FirestoreDocument,
    private readonly value: Record<string, unknown>,
  ) {}

  data(): Record<string, unknown> {
    return this.value;
  }
}

class FakeQuery implements FirestoreQuery {
  constructor(
    protected readonly store: FakeFirestore,
    /** Collection path for a plain query, collection id for a group query. */
    protected readonly target: string,
    protected readonly isGroup: boolean,
    private readonly filters: QueryFilter[] = [],
    private readonly orderField?: string,
    private readonly lastCount?: number,
  ) {}

  where(field: string, operator: string, value: unknown): FirestoreQuery {
    return new FakeQuery(
      this.store,
      this.target,
      this.isGroup,
      [...this.filters, {field, operator, value}],
      this.orderField,
      this.lastCount,
    );
  }

  orderBy(field: string): FirestoreQuery {
    return new FakeQuery(
      this.store,
      this.target,
      this.isGroup,
      this.filters,
      field,
      this.lastCount,
    );
  }

  limitToLast(limit: number): FirestoreQuery {
    this.store.calls.push(`limitToLast:${this.target}`);
    return new FakeQuery(
      this.store,
      this.target,
      this.isGroup,
      this.filters,
      this.orderField,
      limit,
    );
  }

  get(): Promise<FirestoreQuerySnapshot> {
    this.store.calls.push(`query:${this.target}`);
    return Promise.resolve({docs: this.resolve()});
  }

  private resolve(): FakeQueryDocument[] {
    const paths = this.store.pathsIn(this.target, this.isGroup);
    let docs = paths.map(
      (path) =>
        new FakeQueryDocument(
          path.slice(path.lastIndexOf('/') + 1),
          this.store.docAt(path),
          this.store.documents.get(path) ?? {},
        ),
    );
    for (const filter of this.filters) {
      docs = docs.filter((doc) => matches(doc.data(), filter));
    }
    if (this.orderField) {
      const field = this.orderField;
      docs.sort((left, right) =>
        comparable(left.data()[field]) < comparable(right.data()[field])
          ? -1
          : comparable(left.data()[field]) > comparable(right.data()[field])
            ? 1
            : 0,
      );
    }
    return this.lastCount === undefined ? docs : docs.slice(-this.lastCount);
  }
}

class FakeCollection extends FakeQuery implements FirestoreCollection {
  constructor(store: FakeFirestore, path: string) {
    super(store, path, false);
  }

  doc(documentPath: string): FirestoreDocument {
    return this.store.docAt(`${this.target}/${documentPath}`);
  }
}

class FakeDocument implements FirestoreDocument {
  constructor(
    private readonly store: FakeFirestore,
    readonly path: string,
  ) {}

  get id(): string {
    return this.path.slice(this.path.lastIndexOf('/') + 1);
  }

  collection(collectionPath: string): FirestoreCollection {
    return new FakeCollection(this.store, `${this.path}/${collectionPath}`);
  }

  get(): Promise<FirestoreSnapshot> {
    this.store.calls.push(`get:${this.path}`);
    return Promise.resolve(
      new FakeSnapshot(this.id, this, this.store.documents.get(this.path)),
    );
  }

  delete(): Promise<unknown> {
    this.store.calls.push(`delete:${this.path}`);
    this.store.documents.delete(this.path);
    return Promise.resolve(undefined);
  }
}

/** A transaction that buffers its writes until the callback resolves. */
export class FakeTransaction implements FirestoreTransaction {
  readonly writes: RecordedWrite[] = [];

  constructor(private readonly store: FakeFirestore) {}

  get(documentRef: FirestoreDocument): Promise<FirestoreSnapshot> {
    return documentRef.get();
  }

  set(
    documentRef: FirestoreDocument,
    data: Record<string, unknown>,
    options?: FirestoreSetOptions,
  ): unknown {
    this.writes.push({
      kind: 'set',
      path: documentRef.path,
      data,
      merge: options?.merge === true,
    });
    return undefined;
  }

  update(
    documentRef: FirestoreDocument,
    data: Record<string, unknown>,
  ): unknown {
    this.writes.push({
      kind: 'update',
      path: documentRef.path,
      data,
      merge: false,
    });
    return undefined;
  }

  /** Applies the buffered writes, in the order they were made. */
  commit(): void {
    for (const write of this.writes) {
      const current = this.store.documents.get(write.path);
      const replace = write.kind === 'set' && !write.merge;
      this.store.documents.set(
        write.path,
        replace ? {...write.data} : {...current, ...write.data},
      );
    }
  }
}

/** A write batch that deletes documents when it commits. */
export class FakeBatch implements FirestoreBatch {
  readonly deletes: string[] = [];
  commits = 0;

  constructor(private readonly store: FakeFirestore) {}

  delete(documentRef: FirestoreDocument): unknown {
    this.deletes.push(documentRef.path);
    this.store.deleted.push(documentRef.path);
    return undefined;
  }

  commit(): Promise<unknown> {
    this.commits++;
    for (const path of this.deletes) {
      this.store.documents.delete(path);
    }
    this.deletes.length = 0;
    return Promise.resolve(undefined);
  }
}

/** The fake client itself. */
export class FakeFirestore implements FirestoreClient {
  /** Every stored document, by path. */
  readonly documents = new Map<string, Record<string, unknown>>();
  /** Every read, query and delete, oldest first. */
  readonly calls: string[] = [];
  /** Every transaction that was started. */
  readonly transactions: FakeTransaction[] = [];
  /** Every batch that was created. */
  readonly batches: FakeBatch[] = [];
  /** Every path queued for deletion by a batch, across all batches. */
  readonly deleted: string[] = [];
  /** When set, the next `runTransaction` rejects with this instead of running. */
  failNextTransaction?: Error;

  collection(collectionPath: string): FirestoreCollection {
    return new FakeCollection(this, collectionPath);
  }

  collectionGroup(collectionId: string): FirestoreQuery {
    this.calls.push(`collectionGroup:${collectionId}`);
    return new FakeQuery(this, collectionId, true);
  }

  getAll(
    ...documentRefs: Array<FirestoreDocument | FirestoreReadOptions>
  ): Promise<FirestoreSnapshot[]> {
    const refs = documentRefs.filter(isDocument);
    this.calls.push(`getAll:${refs.length}`);
    return Promise.all(refs.map((ref) => ref.get()));
  }

  async runTransaction<T>(
    updateFunction: (transaction: FirestoreTransaction) => Promise<T>,
  ): Promise<T> {
    const failure = this.failNextTransaction;
    if (failure) {
      this.failNextTransaction = undefined;
      throw failure;
    }
    const transaction = new FakeTransaction(this);
    this.transactions.push(transaction);
    const result = await updateFunction(transaction);
    transaction.commit();
    return result;
  }

  batch(): FirestoreBatch {
    const batch = new FakeBatch(this);
    this.batches.push(batch);
    return batch;
  }

  /** Returns a handle on the document at `path`. */
  docAt(path: string): FirestoreDocument {
    return new FakeDocument(this, path);
  }

  /** Returns the paths a plain or collection-group query covers. */
  pathsIn(target: string, isGroup: boolean): string[] {
    const depth = target.split('/').length + 1;
    return [...this.documents.keys()].filter((path) => {
      const segments = path.split('/');
      return isGroup
        ? segments.length >= 2 && segments[segments.length - 2] === target
        : segments.length === depth && path.startsWith(`${target}/`);
    });
  }

  /** Seeds a document, replacing whatever was there. */
  put(path: string, data: Record<string, unknown>): void {
    this.documents.set(path, data);
  }

  /** Returns a stored document, or undefined. */
  read(path: string): Record<string, unknown> | undefined {
    return this.documents.get(path);
  }

  /** Returns every write made by every transaction, oldest first. */
  get writes(): RecordedWrite[] {
    return this.transactions.flatMap((transaction) => transaction.writes);
  }
}
