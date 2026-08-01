/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Firestore, Timestamp} from '@google-cloud/firestore';

/** A stored document: a flat map of field name to value. */
export type StoredDocument = Record<string, unknown>;

/** Options accepted by `set`. */
interface SetOptions {
  merge?: boolean;
}

/** The narrowing applied to a query before it is run. */
interface QuerySpec {
  ordered?: boolean;
  minTimestampMillis?: number;
  limitToLast?: number;
}

/** The only field this fake can order or filter on. */
const TIMESTAMP_FIELD = 'timestamp';

/**
 * An in-memory Firestore, holding every document in one flat map keyed by its
 * full slash-separated path. Children are derived by path prefix, so there is
 * no document tree to keep consistent.
 *
 * It implements only the slice of the Firestore surface
 * `FirestoreSessionService` uses, and throws on anything outside that slice
 * rather than quietly returning a wrong answer.
 */
export class FakeStore {
  private readonly docs = new Map<string, StoredDocument>();

  /** Path of every query run, in order, for asserting a query did not run. */
  readonly queryPaths: string[] = [];

  /**
   * Every document read and write, in order, as `<verb> <path>`, for asserting
   * how two concurrent transactions interleaved.
   */
  readonly operations: string[] = [];

  /** Number of write batches committed. */
  batchCommitCount = 0;

  /** Every stored document, keyed by full path. */
  get documents(): ReadonlyMap<string, StoredDocument> {
    return this.docs;
  }

  /** Writes a document outright, replacing any existing one. */
  write(path: string, data: StoredDocument): void {
    this.docs.set(path, {...data});
  }

  /** Writes a document, merging into the existing one when asked. */
  set(path: string, data: StoredDocument, merge: boolean): void {
    this.operations.push(`write ${path}`);
    const existing = merge ? this.docs.get(path) : undefined;
    this.docs.set(path, {...existing, ...data});
  }

  /** Merges fields into an existing document, as Firestore's update does. */
  update(path: string, data: StoredDocument): void {
    this.operations.push(`write ${path}`);
    const existing = this.docs.get(path);
    if (!existing) {
      throw new Error(
        `fake Firestore: cannot update missing document '${path}'`,
      );
    }
    this.docs.set(path, {...existing, ...data});
  }

  /** Removes a document, if present. */
  delete(path: string): void {
    this.docs.delete(path);
  }

  /**
   * Returns a shallow copy of a document's fields, as Firestore does, so a
   * caller mutating the result cannot reach into the store.
   */
  read(path: string): StoredDocument | undefined {
    const stored = this.docs.get(path);
    return stored && {...stored};
  }

  /** Paths of the documents directly inside a collection. */
  childPaths(collectionPath: string): string[] {
    const prefix = `${collectionPath}/`;
    return [...this.docs.keys()].filter(
      (path) =>
        path.startsWith(prefix) && !path.slice(prefix.length).includes('/'),
    );
  }

  private barrier?: {wait: Promise<void>; release: () => void};

  /**
   * Suspends the caller until the end of the current tick, releasing every
   * caller that arrived in the same tick together.
   *
   * Transaction reads await this so concurrent transactions genuinely
   * interleave. A plain `setTimeout` would not: Node drains the microtask
   * queue between timer callbacks, so each transaction would run to
   * completion before the next one resumed and an unserialized
   * read-modify-write would never be caught losing an update.
   */
  yieldToPeers(): Promise<void> {
    if (!this.barrier) {
      let release!: () => void;
      const wait = new Promise<void>((resolve) => {
        release = resolve;
      });
      this.barrier = {wait, release};
      setTimeout(() => {
        const pending = this.barrier;
        this.barrier = undefined;
        pending?.release();
      }, 0);
    }
    return this.barrier.wait;
  }
}

/** A document snapshot over the flat store. */
class FakeDocumentSnapshot {
  constructor(
    readonly id: string,
    private readonly stored: StoredDocument | undefined,
  ) {}

  get exists(): boolean {
    return this.stored !== undefined;
  }

  data(): StoredDocument | undefined {
    return this.stored;
  }
}

/** A query snapshot over the flat store. */
class FakeQuerySnapshot {
  constructor(readonly docs: FakeDocumentSnapshot[]) {}
}

/** Reads the orderable timestamp field off a stored document. */
function timestampMillis(data: StoredDocument): number {
  const value = data[TIMESTAMP_FIELD];
  if (!(value instanceof Timestamp)) {
    throw new Error(
      `fake Firestore: document is missing a Timestamp '${TIMESTAMP_FIELD}'`,
    );
  }
  return value.toMillis();
}

/** A query over one collection. */
class FakeQuery {
  constructor(
    protected readonly store: FakeStore,
    protected readonly path: string,
    private readonly spec: QuerySpec = {},
  ) {}

  orderBy(field: string): FakeQuery {
    if (field !== TIMESTAMP_FIELD) {
      throw new Error(
        `fake Firestore: orderBy is only implemented for '${TIMESTAMP_FIELD}', got '${field}'`,
      );
    }
    return new FakeQuery(this.store, this.path, {...this.spec, ordered: true});
  }

  where(field: string, operator: string, value: Timestamp): FakeQuery {
    if (field !== TIMESTAMP_FIELD || operator !== '>=') {
      throw new Error(
        `fake Firestore: where is only implemented for '${TIMESTAMP_FIELD} >=', got '${field} ${operator}'`,
      );
    }
    return new FakeQuery(this.store, this.path, {
      ...this.spec,
      minTimestampMillis: value.toMillis(),
    });
  }

  limitToLast(limit: number): FakeQuery {
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new Error(
        'fake Firestore: limitToLast() requires a positive integer',
      );
    }
    return new FakeQuery(this.store, this.path, {
      ...this.spec,
      limitToLast: limit,
    });
  }

  get(): Promise<FakeQuerySnapshot> {
    this.store.queryPaths.push(this.path);

    let paths = this.store.childPaths(this.path);
    const {minTimestampMillis, ordered, limitToLast} = this.spec;
    if (minTimestampMillis !== undefined) {
      paths = paths.filter((path) => this.millisAt(path) >= minTimestampMillis);
    }
    if (ordered) {
      paths.sort((a, b) => this.millisAt(a) - this.millisAt(b));
    }
    if (limitToLast !== undefined) {
      paths = paths.slice(-limitToLast);
    }

    return Promise.resolve(
      new FakeQuerySnapshot(
        paths.map(
          (path) =>
            new FakeDocumentSnapshot(documentId(path), this.store.read(path)),
        ),
      ),
    );
  }

  private millisAt(path: string): number {
    const data = this.store.read(path);
    if (!data) {
      throw new Error(`fake Firestore: document '${path}' disappeared`);
    }
    return timestampMillis(data);
  }
}

/** A collection reference; a query that can also address its documents. */
class FakeCollectionReference extends FakeQuery {
  doc(id: string): FakeDocumentReference {
    return new FakeDocumentReference(this.store, `${this.path}/${id}`);
  }

  listDocuments(): Promise<FakeDocumentReference[]> {
    return Promise.resolve(
      this.store
        .childPaths(this.path)
        .map((path) => new FakeDocumentReference(this.store, path)),
    );
  }
}

/** A document reference over the flat store. */
class FakeDocumentReference {
  constructor(
    readonly store: FakeStore,
    readonly path: string,
  ) {}

  collection(name: string): FakeCollectionReference {
    return new FakeCollectionReference(this.store, `${this.path}/${name}`);
  }

  get(): Promise<FakeDocumentSnapshot> {
    this.store.operations.push(`read ${this.path}`);
    return Promise.resolve(
      new FakeDocumentSnapshot(
        documentId(this.path),
        this.store.read(this.path),
      ),
    );
  }

  delete(): Promise<void> {
    this.store.delete(this.path);
    return Promise.resolve();
  }
}

/** Last path segment of a document path. */
function documentId(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/**
 * A transaction that buffers its writes and applies them only once the
 * callback resolves, so a throwing callback leaves the store untouched.
 */
class FakeTransaction {
  private readonly writes: Array<() => void> = [];

  constructor(private readonly store: FakeStore) {}

  async get(ref: FakeDocumentReference): Promise<FakeDocumentSnapshot> {
    await this.store.yieldToPeers();
    return ref.get();
  }

  async getAll(
    ...refs: FakeDocumentReference[]
  ): Promise<FakeDocumentSnapshot[]> {
    await this.store.yieldToPeers();
    return Promise.all(refs.map((ref) => ref.get()));
  }

  set(
    ref: FakeDocumentReference,
    data: StoredDocument,
    options: SetOptions = {},
  ): void {
    this.writes.push(() =>
      this.store.set(ref.path, data, options.merge ?? false),
    );
  }

  update(ref: FakeDocumentReference, data: StoredDocument): void {
    this.writes.push(() => this.store.update(ref.path, data));
  }

  commit(): void {
    for (const write of this.writes) {
      write();
    }
  }
}

/** A write batch supporting the deletes `deleteSession` issues. */
class FakeWriteBatch {
  private readonly deletions: string[] = [];

  constructor(private readonly store: FakeStore) {}

  delete(ref: FakeDocumentReference): void {
    this.deletions.push(ref.path);
  }

  commit(): Promise<void> {
    this.store.batchCommitCount++;
    for (const path of this.deletions) {
      this.store.delete(path);
    }
    return Promise.resolve();
  }
}

/** The client handed to the service under test. */
class FakeFirestoreClient {
  constructor(private readonly store: FakeStore) {}

  collection(path: string): FakeCollectionReference {
    return new FakeCollectionReference(this.store, path);
  }

  batch(): FakeWriteBatch {
    return new FakeWriteBatch(this.store);
  }

  async runTransaction<T>(
    updateFunction: (transaction: FakeTransaction) => Promise<T>,
  ): Promise<T> {
    const transaction = new FakeTransaction(this.store);
    const result = await updateFunction(transaction);
    transaction.commit();
    return result;
  }
}

/** An in-memory Firestore plus the store backing it. */
export interface FakeFirestore {
  /** The client to pass to `FirestoreSessionService`. */
  client: Firestore;
  /** The backing store, for seeding documents and asserting on them. */
  store: FakeStore;
}

/** Creates an in-memory Firestore that needs no network or credentials. */
export function createFakeFirestore(): FakeFirestore {
  const store = new FakeStore();
  return {
    // The single cast in the fake: `Firestore` declares dozens of members the
    // session service never touches, so the fake implements only the slice it
    // does touch.
    client: new FakeFirestoreClient(store) as unknown as Firestore,
    store,
  };
}
