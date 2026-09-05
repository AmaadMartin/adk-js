/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * An in-memory stand-in for the slice of `@google-cloud/firestore` that
 * `FirestoreMemoryService` uses: `collection()`, `doc()`, `batch()`, `where()`
 * and `get()`.
 *
 * A batch applies its writes to the store when it commits, and a query reads
 * that store, so a test can write with `addSessionToMemory` and read the same
 * documents back with `searchMemory`. The store also records the calls the
 * reference tests assert on, and rejects a commit or a single keyword lane on
 * demand.
 */

/** A recorded `where()` filter. */
export interface WhereCall {
  fieldPath: string;
  opStr: string;
  value: unknown;
}

/** A recorded `batch.set()` write. */
export interface SetCall {
  documentId: string;
  data: Record<string, unknown>;
}

/** A stored document, tagged with the collection that holds it. */
export interface StoredDocument {
  id: string;
  collectionPath: string;
  data: Record<string, unknown>;
}

/** The read side of one stored document. */
export class FakeDocumentSnapshot {
  constructor(private readonly document: StoredDocument) {}

  get id(): string {
    return this.document.id;
  }

  data(): Record<string, unknown> {
    return this.document.data;
  }
}

/** The auto-id reference a batch writes through. */
export class FakeDocumentReference {
  constructor(
    readonly id: string,
    readonly collectionPath: string,
  ) {}
}

/** An immutable filter chain over one collection. */
export class FakeQuery {
  constructor(
    protected readonly store: FakeFirestore,
    protected readonly collectionPath: string,
    readonly filters: readonly WhereCall[],
  ) {}

  where(fieldPath: string, opStr: string, value: unknown): FakeQuery {
    const call: WhereCall = {fieldPath, opStr, value};
    this.store.whereCalls.push(call);
    return new FakeQuery(this.store, this.collectionPath, [
      ...this.filters,
      call,
    ]);
  }

  async get(): Promise<{docs: FakeDocumentSnapshot[]}> {
    return this.store.runQuery(this.collectionPath, this.filters);
  }
}

/** A collection reference: a query that can also mint document references. */
export class FakeCollectionReference extends FakeQuery {
  constructor(store: FakeFirestore, collectionPath: string) {
    super(store, collectionPath, []);
  }

  doc(): FakeDocumentReference {
    return new FakeDocumentReference(
      this.store.nextDocumentId(),
      this.collectionPath,
    );
  }
}

/** A batch that applies its writes to the store only when it commits. */
export class FakeWriteBatch {
  readonly sets: SetCall[] = [];
  commitCount = 0;

  private readonly pending: StoredDocument[] = [];

  constructor(private readonly store: FakeFirestore) {}

  set(
    documentRef: FakeDocumentReference,
    data: Record<string, unknown>,
  ): FakeWriteBatch {
    this.sets.push({documentId: documentRef.id, data});
    this.pending.push({
      id: documentRef.id,
      collectionPath: documentRef.collectionPath,
      data,
    });
    return this;
  }

  async commit(): Promise<void> {
    this.commitCount += 1;
    if (this.store.commitError) {
      throw this.store.commitError;
    }
    this.store.documents.push(...this.pending);
    this.pending.length = 0;
  }
}

/** The fake client. */
export class FakeFirestore {
  /** Every instance the mocked `Firestore` constructor produced. */
  static readonly instances: FakeFirestore[] = [];

  readonly documents: StoredDocument[] = [];
  readonly collectionCalls: string[] = [];
  readonly whereCalls: WhereCall[] = [];
  readonly batches: FakeWriteBatch[] = [];

  /** When set, every `commit()` rejects with it. */
  commitError?: Error;
  /** Maps a keyword to the error its `get()` lane rejects with. */
  readonly keywordErrors = new Map<string, Error>();

  private documentCounter = 0;

  constructor() {
    FakeFirestore.instances.push(this);
  }

  /** Forgets every instance recorded by the mocked constructor. */
  static reset(): void {
    FakeFirestore.instances.length = 0;
  }

  /** Returns the instance the mocked constructor produced last. */
  static latest(): FakeFirestore {
    const instance =
      FakeFirestore.instances[FakeFirestore.instances.length - 1];
    if (!instance) {
      throw new Error('No FakeFirestore was constructed.');
    }
    return instance;
  }

  collection(collectionPath: string): FakeCollectionReference {
    this.collectionCalls.push(collectionPath);
    return new FakeCollectionReference(this, collectionPath);
  }

  batch(): FakeWriteBatch {
    const batch = new FakeWriteBatch(this);
    this.batches.push(batch);
    return batch;
  }

  /** Writes a document directly, bypassing the batch path. */
  seed(collectionPath: string, data: Record<string, unknown>): void {
    this.documents.push({
      id: this.nextDocumentId(),
      collectionPath,
      data,
    });
  }

  nextDocumentId(): string {
    this.documentCounter += 1;
    return `doc-${this.documentCounter}`;
  }

  /** Applies a filter chain to the store. */
  async runQuery(
    collectionPath: string,
    filters: readonly WhereCall[],
  ): Promise<{docs: FakeDocumentSnapshot[]}> {
    for (const filter of filters) {
      const error =
        filter.opStr === 'array-contains'
          ? this.keywordErrors.get(String(filter.value))
          : undefined;
      if (error) {
        throw error;
      }
    }

    const docs = this.documents
      .filter(
        (document) =>
          document.collectionPath === collectionPath &&
          filters.every((filter) => matches(document.data, filter)),
      )
      .map((document) => new FakeDocumentSnapshot(document));
    return {docs};
  }
}

/** Reports whether a stored document satisfies one filter. */
function matches(data: Record<string, unknown>, filter: WhereCall): boolean {
  const field = data[filter.fieldPath];
  if (filter.opStr === 'array-contains') {
    return Array.isArray(field) && field.includes(filter.value);
  }
  return field === filter.value;
}
