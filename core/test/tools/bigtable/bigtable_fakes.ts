/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A stand-in for `@google-cloud/bigtable`.
 *
 * The tests install it with `vi.mock` and reach it through
 * `BigtableClientPool`, so the client the tools receive is typed by the real
 * SDK declarations while the calls land here.
 */

/** Fixtures one fake instance answers with. */
export interface FakeInstanceData {
  metadata?: Record<string, unknown>;
  tables?: Array<{id: string; name: string}>;
  clusters?: Array<{id: string; metadata: Record<string, unknown>}>;
  clustersResponse?: unknown;
  families?: Record<string, string[]>;
  /** Rows the query stream emits, as [name, value] tuples per row. */
  rows?: Array<Array<[string | null, unknown]>>;
  /** Values the query stream emits verbatim, in place of {@link rows}. */
  streamValues?: unknown[];
  /** Thrown by `prepareStatement`, to exercise the failure path. */
  prepareError?: Error;
}

/** Fixtures the fake client answers with. */
export interface FakeBigtableData {
  instances?: Array<{id: string; metadata: Record<string, unknown>}>;
  failedLocations?: string[];
  instanceData?: Record<string, FakeInstanceData>;
}

/** Records every call so a test can assert on what the tools asked for. */
export interface FakeBigtableCalls {
  constructed: Array<Record<string, unknown>>;
  closed: number;
  prepared: Array<Record<string, unknown>>;
  queried: Array<Record<string, unknown>>;
  streamsEnded: number;
}

/** The fixtures and the call log the next fake client is built with. */
export const fakeBigtableState: {
  data: FakeBigtableData;
  calls: FakeBigtableCalls;
} = {data: {}, calls: newCalls()};

function newCalls(): FakeBigtableCalls {
  return {
    constructed: [],
    closed: 0,
    prepared: [],
    queried: [],
    streamsEnded: 0,
  };
}

/** Clears the fixtures and the call log between tests. */
export function resetFakeBigtable(data: FakeBigtableData = {}): void {
  fakeBigtableState.data = data;
  fakeBigtableState.calls = newCalls();
}

/** One row of a fake query result, shaped like the SDK's `QueryResultRow`. */
function fakeRow(fields: Array<[string | null, unknown]>) {
  return {
    values: fields.map(([, value]) => value),
    fieldMapping: {fieldNames: fields.map(([name]) => name)},
  };
}

class FakeTable {
  constructor(
    readonly id: string,
    private readonly families: string[],
  ) {}

  async getFamilies() {
    return [this.families.map((id) => ({id}))];
  }
}

class FakeCluster {
  constructor(
    readonly id: string,
    readonly metadata: Record<string, unknown>,
  ) {}

  async getMetadata() {
    return [this.metadata];
  }
}

class FakeInstance {
  /** Set by `getInstances`, as the SDK sets it on a listed instance. */
  readonly metadata?: Record<string, unknown>;

  constructor(
    readonly id: string,
    private readonly data: FakeInstanceData,
  ) {
    this.metadata = data.metadata;
  }

  async getMetadata() {
    return [this.data.metadata ?? {}];
  }

  async getTables() {
    return [this.data.tables ?? []];
  }

  async getClusters() {
    const clusters = (this.data.clusters ?? []).map(
      (cluster) => new FakeCluster(cluster.id, cluster.metadata),
    );
    return [clusters, this.data.clustersResponse];
  }

  cluster(id: string) {
    const found = (this.data.clusters ?? []).find(
      (cluster) => cluster.id === id,
    );
    return new FakeCluster(id, found?.metadata ?? {});
  }

  table(id: string) {
    return new FakeTable(id, this.data.families?.[id] ?? []);
  }

  async prepareStatement(options: Record<string, unknown>) {
    fakeBigtableState.calls.prepared.push(options);
    if (this.data.prepareError) {
      throw this.data.prepareError;
    }
    return [{query: options['query']}];
  }

  createExecuteQueryStream(options: Record<string, unknown>) {
    fakeBigtableState.calls.queried.push(options);
    const values =
      this.data.streamValues ?? (this.data.rows ?? []).map(fakeRow);
    return {
      async *[Symbol.asyncIterator]() {
        yield* values;
      },
      end() {
        fakeBigtableState.calls.streamsEnded += 1;
      },
    };
  }
}

/** The fake the tests substitute for the SDK's `Bigtable` class. */
export class FakeBigtable {
  constructor(options: Record<string, unknown>) {
    fakeBigtableState.calls.constructed.push(options);
  }

  async getInstances() {
    const data = fakeBigtableState.data;
    const instances = (data.instances ?? []).map(
      (instance) =>
        new FakeInstance(instance.id, {metadata: instance.metadata}),
    );
    return [instances, data.failedLocations];
  }

  instance(id: string) {
    return new FakeInstance(
      id,
      fakeBigtableState.data.instanceData?.[id] ?? {},
    );
  }

  async close() {
    fakeBigtableState.calls.closed += 1;
  }
}
