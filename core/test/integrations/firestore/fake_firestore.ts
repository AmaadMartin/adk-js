/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * An in-memory stand-in for the slice of `@google-cloud/firestore` that
 * `FirestoreSessionService` uses.
 *
 * Every instance reads and writes one module-level {@link fakeFirestore}
 * store, so a test seeds documents before the service creates its client and
 * reads back what the service wrote. Call `fakeFirestore.reset()` between
 * tests.
 *
 * Follows `core/test/artifacts/gcs_artifact_service_test.ts`, which fakes
 * `@google-cloud/storage` the same way.
 */

import {Readable} from 'node:stream';

/** A document, addressed by its full slash-separated path. */
type StoredDocument = Record<string, unknown>;

/** One write staged on a transaction, recorded when it is staged. */
export interface RecordedWrite {
  kind: 'set' | 'update';
  path: string;
  /** The data as the caller passed it, with any sentinel left unresolved. */
  data: StoredDocument;
  /** True when the write was a `set` with `{merge: true}`. */
  merge: boolean;
}

/** One query, recorded when it runs. */
export interface RecordedQuery {
  /** The collection or collection group the query reads. */
  path: string;
  wheres: Array<{field: string; op: string; value: unknown}>;
  orderBys: string[];
  limitToLast?: number;
  /** How the query was run. */
  via: 'get' | 'stream';
}

/**
 * A resolved `FieldValue.serverTimestamp()`.
 *
 * The store cannot hold the sentinel itself: ordering and range filters need a
 * real instant. It carries `toMillis` so that `toEpochMillis` and the query
 * comparator read it the same way they read a real `Timestamp`.
 */
export class FakeServerTimestamp {
  constructor(private readonly millis: number) {}

  toMillis(): number {
    return this.millis;
  }
}

/**
 * True for a `FieldValue` sentinel such as `FieldValue.serverTimestamp()`.
 *
 * A `Timestamp` also carries `isEqual`, so it is told apart by `toMillis`,
 * which only the timestamp has.
 */
function isFieldValueSentinel(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as {isEqual?: unknown; toMillis?: unknown};
  return (
    typeof candidate.isEqual === 'function' &&
    typeof candidate.toMillis !== 'function'
  );
}

/** Reads a stored value as epoch milliseconds, for ordering and filtering. */
function comparableMillis(value: unknown): number {
  if (typeof value === 'number') {
    return value;
  }
  if (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as {toMillis?: unknown}).toMillis === 'function'
  ) {
    return (value as {toMillis(): number}).toMillis();
  }
  return 0;
}

/** The database and the call log every fake client shares. */
class FakeFirestoreStore {
  readonly documents = new Map<string, StoredDocument>();
  readonly writes: RecordedWrite[] = [];
  readonly queries: RecordedQuery[] = [];
  readonly collectionIds: string[] = [];
  readonly collectionGroupIds: string[] = [];
  readonly getAllPaths: string[][] = [];
  readonly deletedPaths: string[] = [];
  readonly batchDeletedPaths: string[] = [];
  /** How many clients the service has constructed. */
  clientCount = 0;
  batchCount = 0;
  batchCommitCount = 0;
  /** Rejects the next `runTransaction` call with this error when set. */
  transactionFailure?: Error;
  private clock = 1_700_000_000_000;

  reset(): void {
    this.documents.clear();
    this.writes.length = 0;
    this.queries.length = 0;
    this.collectionIds.length = 0;
    this.collectionGroupIds.length = 0;
    this.getAllPaths.length = 0;
    this.deletedPaths.length = 0;
    this.batchDeletedPaths.length = 0;
    this.clientCount = 0;
    this.batchCount = 0;
    this.batchCommitCount = 0;
    this.transactionFailure = undefined;
    this.clock = 1_700_000_000_000;
  }

  /** Seeds a document, replacing any document already at `path`. */
  setDocument(path: string, data: StoredDocument): void {
    this.documents.set(path, {...data});
  }

  /** The stored document at `path`, or undefined. */
  getDocument(path: string): StoredDocument | undefined {
    return this.documents.get(path);
  }

  /** The writes staged against `path`, oldest first. */
  writesTo(path: string): RecordedWrite[] {
    return this.writes.filter((write) => write.path === path);
  }

  /** The queries recorded against a collection whose path ends with `suffix`. */
  queriesEndingWith(suffix: string): RecordedQuery[] {
    return this.queries.filter((query) => query.path.endsWith(suffix));
  }

  /** The next server timestamp. Each call advances the fake clock by 1ms. */
  nextServerTimestamp(): FakeServerTimestamp {
    this.clock += 1;
    return new FakeServerTimestamp(this.clock);
  }

  /** Replaces every sentinel in `data` with a resolved server timestamp. */
  resolveSentinels(data: StoredDocument): StoredDocument {
    const resolved: StoredDocument = {};
    for (const [key, value] of Object.entries(data)) {
      resolved[key] = isFieldValueSentinel(value)
        ? this.nextServerTimestamp()
        : value;
    }
    return resolved;
  }

  applySet(path: string, data: StoredDocument, merge: boolean): void {
    const resolved = this.resolveSentinels(data);
    const existing = merge ? (this.documents.get(path) ?? {}) : {};
    this.documents.set(path, {...existing, ...resolved});
  }

  applyUpdate(path: string, data: StoredDocument): void {
    const existing = this.documents.get(path);
    if (existing === undefined) {
      throw new Error(`No document to update at ${path}`);
    }
    this.documents.set(path, {...existing, ...this.resolveSentinels(data)});
  }
}

/** The store the fake clients in this process share. */
export const fakeFirestore = new FakeFirestoreStore();

/** A document snapshot, as `get()` and a query return one. */
class FakeDocumentSnapshot {
  constructor(
    readonly ref: FakeDocumentReference,
    private readonly stored?: StoredDocument,
  ) {}

  get id(): string {
    return this.ref.id;
  }

  get exists(): boolean {
    return this.stored !== undefined;
  }

  data(): StoredDocument | undefined {
    return this.stored === undefined ? undefined : {...this.stored};
  }
}

/** A reference to one document. */
class FakeDocumentReference {
  constructor(readonly path: string) {}

  get id(): string {
    return this.path.slice(this.path.lastIndexOf('/') + 1);
  }

  collection(collectionId: string): FakeCollectionReference {
    return new FakeCollectionReference(`${this.path}/${collectionId}`);
  }

  get(): Promise<FakeDocumentSnapshot> {
    return Promise.resolve(
      new FakeDocumentSnapshot(this, fakeFirestore.getDocument(this.path)),
    );
  }

  delete(): Promise<void> {
    fakeFirestore.deletedPaths.push(this.path);
    fakeFirestore.documents.delete(this.path);
    return Promise.resolve();
  }
}

interface QueryFilter {
  field: string;
  op: string;
  value: unknown;
}

/** A query over a collection or a collection group. */
class FakeQuery {
  constructor(
    /** The collection path, or the collection id for a group query. */
    protected readonly path: string,
    /** True when the query spans every collection with this id. */
    protected readonly isGroup: boolean,
    protected readonly filters: QueryFilter[] = [],
    protected readonly orderBys: string[] = [],
    protected readonly limit?: number,
  ) {}

  where(field: string, op: string, value: unknown): FakeQuery {
    return new FakeQuery(
      this.path,
      this.isGroup,
      [...this.filters, {field, op, value}],
      this.orderBys,
      this.limit,
    );
  }

  orderBy(field: string): FakeQuery {
    return new FakeQuery(
      this.path,
      this.isGroup,
      this.filters,
      [...this.orderBys, field],
      this.limit,
    );
  }

  limitToLast(limit: number): FakeQuery {
    return new FakeQuery(
      this.path,
      this.isGroup,
      this.filters,
      this.orderBys,
      limit,
    );
  }

  async get(): Promise<{docs: FakeDocumentSnapshot[]}> {
    return {docs: this.run('get')};
  }

  stream(): Readable {
    return Readable.from(this.run('stream'));
  }

  private run(via: RecordedQuery['via']): FakeDocumentSnapshot[] {
    fakeFirestore.queries.push({
      path: this.path,
      wheres: this.filters.map((filter) => ({...filter})),
      orderBys: [...this.orderBys],
      limitToLast: this.limit,
      via,
    });

    const matches: FakeDocumentSnapshot[] = [];
    for (const [path, stored] of fakeFirestore.documents) {
      if (!this.covers(path) || !this.accepts(stored)) {
        continue;
      }
      matches.push(
        new FakeDocumentSnapshot(new FakeDocumentReference(path), stored),
      );
    }

    // Successive stable sorts, least significant key first.
    for (const field of [...this.orderBys].reverse()) {
      matches.sort(
        (a, b) =>
          comparableMillis(a.data()?.[field]) -
          comparableMillis(b.data()?.[field]),
      );
    }
    return this.limit === undefined ? matches : matches.slice(-this.limit);
  }

  /** True when the document at `path` belongs to the queried collection. */
  private covers(path: string): boolean {
    const parent = path.slice(0, path.lastIndexOf('/'));
    if (!this.isGroup) {
      return parent === this.path;
    }
    return parent.slice(parent.lastIndexOf('/') + 1) === this.path;
  }

  private accepts(stored: StoredDocument): boolean {
    return this.filters.every((filter) => {
      const value = stored[filter.field];
      switch (filter.op) {
        case '==':
          return value === filter.value;
        case '>=':
          return comparableMillis(value) >= comparableMillis(filter.value);
        default:
          throw new Error(`Unsupported query operator: ${filter.op}`);
      }
    });
  }
}

/** A reference to one collection. */
class FakeCollectionReference extends FakeQuery {
  constructor(path: string) {
    super(path, false);
  }

  doc(documentId: string): FakeDocumentReference {
    return new FakeDocumentReference(`${this.path}/${documentId}`);
  }
}

/** The transaction handle `runTransaction` hands its callback. */
class FakeTransaction {
  private readonly staged: Array<() => void> = [];

  get(ref: FakeDocumentReference): Promise<FakeDocumentSnapshot> {
    return ref.get();
  }

  set(
    ref: FakeDocumentReference,
    data: StoredDocument,
    options?: {merge?: boolean},
  ): void {
    const merge = options?.merge === true;
    fakeFirestore.writes.push({kind: 'set', path: ref.path, data, merge});
    this.staged.push(() => fakeFirestore.applySet(ref.path, data, merge));
  }

  update(ref: FakeDocumentReference, data: StoredDocument): void {
    fakeFirestore.writes.push({
      kind: 'update',
      path: ref.path,
      data,
      merge: false,
    });
    this.staged.push(() => fakeFirestore.applyUpdate(ref.path, data));
  }

  /** Applies the staged writes. Called only when the callback resolves. */
  commit(): void {
    for (const write of this.staged) {
      write();
    }
  }
}

/** A batch of deletes, as `deleteSession` uses it. */
class FakeWriteBatch {
  private readonly staged: string[] = [];

  delete(ref: FakeDocumentReference): void {
    fakeFirestore.batchDeletedPaths.push(ref.path);
    this.staged.push(ref.path);
  }

  commit(): Promise<void> {
    fakeFirestore.batchCommitCount += 1;
    for (const path of this.staged) {
      fakeFirestore.documents.delete(path);
    }
    this.staged.length = 0;
    return Promise.resolve();
  }
}

/** The `Firestore` stand-in the mocked module exports. */
export class FakeFirestore {
  constructor() {
    fakeFirestore.clientCount += 1;
  }

  collection(collectionId: string): FakeCollectionReference {
    fakeFirestore.collectionIds.push(collectionId);
    return new FakeCollectionReference(collectionId);
  }

  collectionGroup(collectionId: string): FakeQuery {
    fakeFirestore.collectionGroupIds.push(collectionId);
    return new FakeQuery(collectionId, true);
  }

  getAll(...refs: FakeDocumentReference[]): Promise<FakeDocumentSnapshot[]> {
    fakeFirestore.getAllPaths.push(refs.map((ref) => ref.path));
    return Promise.all(refs.map((ref) => ref.get()));
  }

  async runTransaction<T>(fn: (t: FakeTransaction) => Promise<T>): Promise<T> {
    if (fakeFirestore.transactionFailure) {
      throw fakeFirestore.transactionFailure;
    }
    const transaction = new FakeTransaction();
    const result = await fn(transaction);
    transaction.commit();
    return result;
  }

  batch(): FakeWriteBatch {
    fakeFirestore.batchCount += 1;
    return new FakeWriteBatch();
  }
}
