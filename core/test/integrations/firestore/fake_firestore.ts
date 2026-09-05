/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * An in-memory stand-in for `@google-cloud/firestore`.
 *
 * The adk-python tests drive this service with `MagicMock`'s auto-chaining,
 * which TypeScript has no equivalent for. This fake plays the same role: it
 * stores documents by path, records every write, and lets a test assert that a
 * query was never built. `core/test/artifacts/gcs_artifact_service_test.ts`
 * builds `FakeGcsBucket` the same way.
 *
 * It is deliberately not a Firestore emulator. It does not retry a contended
 * transaction, enforce the reads-before-writes rule, or validate field values.
 */

/** A document body, as Firestore stores it. */
export type FakeDocumentData = Record<string, unknown>;

/** Every fake client built since the list was last cleared. */
export const fakeFirestores: FakeFirestore[] = [];

/** A timestamp, matching the `toMillis()` shape of Firestore's `Timestamp`. */
export class FakeTimestamp {
  constructor(private readonly millis: number) {}

  toMillis(): number {
    return this.millis;
  }
}

/** The sentinel a caller writes to ask for the commit time. */
export class ServerTimestampSentinel {}

/** The single sentinel instance, so a test can assert on identity. */
export const SERVER_TIMESTAMP = new ServerTimestampSentinel();

/** Stands in for Firestore's `FieldValue`. */
export class FakeFieldValue {
  static serverTimestamp(): ServerTimestampSentinel {
    return SERVER_TIMESTAMP;
  }
}

/** A write as it was requested, before the transaction or batch committed. */
export interface RecordedWrite {
  kind: 'set' | 'update';
  path: string;
  data: FakeDocumentData;
  merge: boolean;
}

/** A query builder or read call, so a test can prove one never happened. */
export interface RecordedQueryCall {
  method: 'orderBy' | 'where' | 'limitToLast' | 'get' | 'stream';
  /** Collection path, or `group:<id>` for a collection-group query. */
  source: string;
  args: unknown[];
}

/** One filter of a fake query. */
interface QueryFilter {
  field: string;
  op: '==' | '>=';
  value: unknown;
}

/** Sort key for a value that may be a `Date`, a `FakeTimestamp` or a number. */
function toComparable(value: unknown): number | string {
  if (value instanceof FakeTimestamp) {
    return value.toMillis();
  }
  if (value instanceof Date) {
    return value.getTime();
  }
  if (typeof value === 'number' || typeof value === 'string') {
    return value;
  }
  return 0;
}

function compare(a: unknown, b: unknown): number {
  const left = toComparable(a);
  const right = toComparable(b);
  if (left < right) return -1;
  return left > right ? 1 : 0;
}

function matches(data: FakeDocumentData, filter: QueryFilter): boolean {
  if (filter.op === '==') {
    return data[filter.field] === filter.value;
  }
  return compare(data[filter.field], filter.value) >= 0;
}

/** The id of the collection a document path sits in. */
function collectionIdOf(documentPath: string): string {
  const segments = documentPath.split('/');
  return segments[segments.length - 2] ?? '';
}

/** A snapshot of one document. */
export class FakeDocumentSnapshot {
  constructor(
    readonly ref: FakeDocumentReference,
    private readonly stored: FakeDocumentData | undefined,
  ) {}

  get id(): string {
    return this.ref.id;
  }

  get exists(): boolean {
    return this.stored !== undefined;
  }

  data(): FakeDocumentData | undefined {
    return this.stored === undefined ? undefined : {...this.stored};
  }
}

/** A query over a collection or a collection group. */
export class FakeQuery {
  constructor(
    protected readonly db: FakeFirestore,
    /** Collection path, or `undefined` for a collection-group query. */
    protected readonly collectionPath: string | undefined,
    /** Collection id matched across every parent, for a group query. */
    protected readonly groupId: string | undefined,
    protected readonly filters: QueryFilter[] = [],
    protected readonly orderByField?: string,
    protected readonly limitLast?: number,
  ) {}

  /** How this query names itself in {@link FakeFirestore.queryCalls}. */
  get source(): string {
    return this.collectionPath ?? `group:${this.groupId}`;
  }

  orderBy(field: string): FakeQuery {
    this.db.queryCalls.push({
      method: 'orderBy',
      source: this.source,
      args: [field],
    });
    return this.derive({orderByField: field});
  }

  where(field: string, op: '==' | '>=', value: unknown): FakeQuery {
    this.db.queryCalls.push({
      method: 'where',
      source: this.source,
      args: [field, op, value],
    });
    return this.derive({filters: [...this.filters, {field, op, value}]});
  }

  limitToLast(count: number): FakeQuery {
    this.db.queryCalls.push({
      method: 'limitToLast',
      source: this.source,
      args: [count],
    });
    return this.derive({limitLast: count});
  }

  async get(): Promise<{docs: FakeDocumentSnapshot[]}> {
    this.db.queryCalls.push({method: 'get', source: this.source, args: []});
    return {docs: this.resolve()};
  }

  async *stream(): AsyncIterableIterator<FakeDocumentSnapshot> {
    this.db.queryCalls.push({method: 'stream', source: this.source, args: []});
    for (const doc of this.resolve()) {
      yield doc;
    }
  }

  private derive(overrides: {
    filters?: QueryFilter[];
    orderByField?: string;
    limitLast?: number;
  }): FakeQuery {
    return new FakeQuery(
      this.db,
      this.collectionPath,
      this.groupId,
      overrides.filters ?? this.filters,
      overrides.orderByField ?? this.orderByField,
      overrides.limitLast ?? this.limitLast,
    );
  }

  private resolve(): FakeDocumentSnapshot[] {
    let paths = this.db.pathsIn(this.collectionPath, this.groupId);
    paths = paths.filter((path) => {
      const data = this.db.documents.get(path);
      return data !== undefined && this.filters.every((f) => matches(data, f));
    });

    const field = this.orderByField;
    if (field !== undefined) {
      paths.sort((a, b) =>
        compare(
          this.db.documents.get(a)?.[field],
          this.db.documents.get(b)?.[field],
        ),
      );
    }
    if (this.limitLast !== undefined) {
      paths = paths.slice(Math.max(0, paths.length - this.limitLast));
    }
    return paths.map((path) => this.db.snapshotAt(path));
  }
}

/** A collection reference, which is also a query over that collection. */
export class FakeCollectionReference extends FakeQuery {
  constructor(db: FakeFirestore, path: string) {
    super(db, path, undefined, []);
  }

  get path(): string {
    return this.collectionPath ?? '';
  }

  doc(id: string): FakeDocumentReference {
    return new FakeDocumentReference(this.db, `${this.path}/${id}`);
  }
}

/** A reference to one document. */
export class FakeDocumentReference {
  constructor(
    private readonly db: FakeFirestore,
    readonly path: string,
  ) {}

  get id(): string {
    return this.path.split('/').pop() ?? '';
  }

  collection(id: string): FakeCollectionReference {
    return new FakeCollectionReference(this.db, `${this.path}/${id}`);
  }

  async get(): Promise<FakeDocumentSnapshot> {
    return this.db.snapshotAt(this.path);
  }

  async delete(): Promise<void> {
    this.db.documents.delete(this.path);
    this.db.deletedPaths.push(this.path);
  }
}

/** A transaction that buffers its writes until the callback returns. */
export class FakeTransaction {
  private readonly buffered: Array<() => void> = [];

  constructor(private readonly db: FakeFirestore) {}

  async get(ref: FakeDocumentReference): Promise<FakeDocumentSnapshot> {
    return ref.get();
  }

  set(
    ref: FakeDocumentReference,
    data: FakeDocumentData,
    options?: {merge?: boolean},
  ): FakeTransaction {
    this.db.writes.push({
      kind: 'set',
      path: ref.path,
      data,
      merge: options?.merge === true,
    });
    this.buffered.push(() => this.db.applyWrite(ref.path, data, true));
    return this;
  }

  update(ref: FakeDocumentReference, data: FakeDocumentData): FakeTransaction {
    this.db.writes.push({kind: 'update', path: ref.path, data, merge: true});
    this.buffered.push(() => this.db.applyWrite(ref.path, data, true));
    return this;
  }

  /** Applies the buffered writes. The fake calls this only on success. */
  commit(): void {
    for (const write of this.buffered) {
      write();
    }
    this.buffered.length = 0;
  }
}

/** A batched write. Only `delete` is used by the service. */
export class FakeWriteBatch {
  private readonly buffered: string[] = [];

  constructor(private readonly db: FakeFirestore) {}

  delete(ref: FakeDocumentReference): FakeWriteBatch {
    this.db.batchDeletes.push(ref.path);
    this.buffered.push(ref.path);
    return this;
  }

  async commit(): Promise<void> {
    this.db.batchCommits++;
    for (const path of this.buffered) {
      this.db.documents.delete(path);
    }
    this.buffered.length = 0;
  }
}

/** The in-memory client. */
export class FakeFirestore {
  /** Every document, keyed by its full slash-joined path. */
  readonly documents = new Map<string, FakeDocumentData>();

  /** Writes as they were requested, including ones a failed transaction lost. */
  readonly writes: RecordedWrite[] = [];

  /** Query builder and read calls, in order. */
  readonly queryCalls: RecordedQueryCall[] = [];

  /** Paths passed to `WriteBatch.delete`. */
  readonly batchDeletes: string[] = [];

  /** Paths passed to `DocumentReference.delete`. */
  readonly deletedPaths: string[] = [];

  /** How many times a `WriteBatch` committed. */
  batchCommits = 0;

  /** Server timestamps handed out so far, so event order is deterministic. */
  private clock = 1_700_000_000_000;

  constructor() {
    fakeFirestores.push(this);
  }

  /** Seeds a document, as if another process had written it. */
  seed(path: string, data: FakeDocumentData): void {
    this.documents.set(path, {...data});
  }

  collection(path: string): FakeCollectionReference {
    return new FakeCollectionReference(this, path);
  }

  collectionGroup(id: string): FakeQuery {
    return new FakeQuery(this, undefined, id);
  }

  batch(): FakeWriteBatch {
    return new FakeWriteBatch(this);
  }

  async getAll(
    ...refs: FakeDocumentReference[]
  ): Promise<FakeDocumentSnapshot[]> {
    return refs.map((ref) => this.snapshotAt(ref.path));
  }

  async runTransaction<T>(fn: (t: FakeTransaction) => Promise<T>): Promise<T> {
    const transaction = new FakeTransaction(this);
    const result = await fn(transaction);
    transaction.commit();
    return result;
  }

  /** The snapshot of `path`, existing or not. */
  snapshotAt(path: string): FakeDocumentSnapshot {
    return new FakeDocumentSnapshot(
      new FakeDocumentReference(this, path),
      this.documents.get(path),
    );
  }

  /** Document paths in one collection, or across a collection group. */
  pathsIn(collectionPath: string | undefined, groupId?: string): string[] {
    const prefix =
      collectionPath === undefined ? undefined : `${collectionPath}/`;
    return [...this.documents.keys()].filter((path) => {
      if (prefix !== undefined) {
        return (
          path.startsWith(prefix) && !path.slice(prefix.length).includes('/')
        );
      }
      return collectionIdOf(path) === groupId;
    });
  }

  /** Merges `data` into the document at `path`, resolving write sentinels. */
  applyWrite(path: string, data: FakeDocumentData, merge: boolean): void {
    const resolved: FakeDocumentData = {};
    for (const [key, value] of Object.entries(data)) {
      resolved[key] =
        value instanceof ServerTimestampSentinel
          ? new FakeTimestamp(this.clock++)
          : value;
    }
    const previous = merge ? this.documents.get(path) : undefined;
    this.documents.set(path, {...previous, ...resolved});
  }
}
