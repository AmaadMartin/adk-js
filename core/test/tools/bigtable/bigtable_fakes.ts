/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * An in-memory stand-in for `@google-cloud/bigtable`.
 *
 * Only the surface the Bigtable tools call is implemented. A test describes
 * what the API should answer with through {@link FakeBigtable.setup} and reads
 * what the tools asked for back off the fake.
 */

import {Readable} from 'node:stream';

import {Context} from '../../../src/agents/context.js';
import {InvocationContext} from '../../../src/agents/invocation_context.js';
import {LlmAgent} from '../../../src/agents/llm_agent.js';
import {PluginManager} from '../../../src/plugins/plugin_manager.js';
import {InMemorySessionService} from '../../../src/sessions/in_memory_session_service.js';

/**
 * Builds the tool context `BaseTool.runAsync` requires.
 *
 * Everything here comes from `src/`, not from the `@google/adk` entry point,
 * because the tests drive modules that are not exported from it and the two
 * resolutions produce distinct types.
 *
 * @param options The user, agent and session state the invocation runs with.
 * @return A context backed by an in-memory session.
 */
export async function createToolContext(
  options: {
    userId?: string;
    agentName?: string;
    state?: Record<string, unknown>;
  } = {},
): Promise<Context> {
  const sessionService = new InMemorySessionService();
  const session = await sessionService.createSession({
    appName: 'bigtable-test',
    userId: options.userId ?? 'test-user',
    state: options.state,
  });
  return new Context({
    invocationContext: new InvocationContext({
      invocationId: 'invocation-1',
      agent: new LlmAgent({name: options.agentName ?? 'bigtable_agent'}),
      session,
      pluginManager: new PluginManager([]),
      sessionService,
    }),
  });
}

/** The instance metadata fields the tools read. */
export interface FakeInstanceMetadata {
  displayName?: string;
  state?: string | number;
  type?: string | number;
  labels?: Record<string, string>;
}

/** The cluster metadata fields the tools read. */
export interface FakeClusterMetadata {
  location?: string;
  state?: string | number;
  serveNodes?: number;
  defaultStorageType?: string | number;
  clusterConfig?: {
    clusterAutoscalingConfig?: {
      autoscalingLimits?: {minServeNodes?: number; maxServeNodes?: number};
      autoscalingTargets?: {cpuUtilizationPercent?: number};
    };
  };
}

/** A row the fake query stream emits, in the SDK's named-column shape. */
export interface FakeRow {
  values: unknown[];
  fieldMapping: {fieldNames: Array<string | null>};
}

/**
 * A MAP column value, shaped like the SDK's `EncodedKeyMap`.
 *
 * The SDK's class *implements* `Map` rather than extending it, so
 * `value instanceof Map` is false for every map a query returns. This fake
 * reproduces that, which a native `Map` would not.
 */
export class FakeEncodedKeyMap {
  private readonly pairs: Array<[unknown, unknown]>;

  constructor(pairs: Array<[unknown, unknown]>) {
    this.pairs = [...pairs];
  }

  get size(): number {
    return this.pairs.length;
  }

  entries(): Iterable<[unknown, unknown]> {
    return this.pairs.values();
  }

  get(key: unknown): unknown {
    return this.pairs.find(([candidate]) => candidate === key)?.[1];
  }
}

/** Builds a {@link FakeRow} from `[column name, value]` pairs. */
export function fakeRow(columns: Array<[string | null, unknown]>): FakeRow {
  return {
    values: columns.map(([, value]) => value),
    fieldMapping: {fieldNames: columns.map(([name]) => name)},
  };
}

/** What one fake instance answers with. */
export interface FakeInstanceSetup {
  metadata?: FakeInstanceMetadata;
  tables?: Array<{id: string; name: string; families: string[]}>;
  clusters?: Array<{id: string; name: string; metadata: FakeClusterMetadata}>;
  failedClusterLocations?: string[];
  rows?: FakeRow[];
  /** Thrown by every admin and query call this instance serves. */
  error?: Error;
}

/** What the fake Bigtable module answers with. */
export interface FakeBigtableSetup {
  listedInstances?: Array<{id: string; metadata: FakeInstanceMetadata}>;
  failedInstanceLocations?: string[];
  instances?: Record<string, FakeInstanceSetup>;
  /** Thrown by `getInstances()`. */
  listError?: Error;
  /** Thrown by `close()`. */
  closeError?: Error;
}

/** A query the fake was asked to prepare, and the parameters it ran with. */
export interface RecordedQuery {
  query: string;
  parameterTypes?: Record<string, {type: string}>;
  parameters?: Record<string, unknown>;
}

class FakeTable {
  constructor(
    readonly id: string,
    readonly name: string,
    private readonly families: string[],
    private readonly error?: Error,
  ) {}

  async getFamilies(): Promise<[Array<{id: string}>]> {
    if (this.error) {
      throw this.error;
    }
    return [this.families.map((id) => ({id}))];
  }
}

class FakeCluster {
  constructor(
    readonly id: string,
    readonly name: string,
    readonly metadata: FakeClusterMetadata | undefined,
    private readonly error?: Error,
  ) {}

  async getMetadata(): Promise<[FakeClusterMetadata | undefined]> {
    if (this.error) {
      throw this.error;
    }
    return [this.metadata];
  }
}

class FakeInstance {
  /** Every query this instance was asked to run. */
  readonly queries: RecordedQuery[] = [];
  /** How many query streams were destroyed. */
  destroyedStreams = 0;

  constructor(
    readonly id: string,
    private readonly setup: FakeInstanceSetup,
  ) {}

  private throwIfFailing(): void {
    if (this.setup.error) {
      throw this.setup.error;
    }
  }

  async getMetadata(): Promise<[FakeInstanceMetadata | undefined]> {
    this.throwIfFailing();
    return [this.setup.metadata];
  }

  async getTables(): Promise<[FakeTable[]]> {
    this.throwIfFailing();
    return [
      (this.setup.tables ?? []).map(
        (table) => new FakeTable(table.id, table.name, table.families),
      ),
    ];
  }

  table(id: string): FakeTable {
    const found = this.setup.tables?.find((table) => table.id === id);
    return new FakeTable(
      id,
      found?.name ?? '',
      found?.families ?? [],
      this.setup.error,
    );
  }

  cluster(id: string): FakeCluster {
    const found = this.setup.clusters?.find((cluster) => cluster.id === id);
    return new FakeCluster(
      id,
      found?.name ?? '',
      found?.metadata,
      this.setup.error,
    );
  }

  getClusters(
    callback: (
      err: Error | null,
      clusters?: FakeCluster[],
      response?: {failedLocations?: string[]},
    ) => void,
  ): void {
    if (this.setup.error) {
      callback(this.setup.error);
      return;
    }
    if (this.setup.clusters === undefined) {
      // The callback declares both results as optional; an instance with
      // nothing to report may omit them.
      callback(null);
      return;
    }
    const clusters = this.setup.clusters.map(
      (cluster) => new FakeCluster(cluster.id, cluster.name, cluster.metadata),
    );
    callback(null, clusters, {
      failedLocations: this.setup.failedClusterLocations,
    });
  }

  async prepareStatement(options: {
    query: string;
    parameterTypes?: Record<string, {type: string}>;
  }): Promise<[{query: string}]> {
    this.throwIfFailing();
    this.queries.push({
      query: options.query,
      parameterTypes: options.parameterTypes,
    });
    return [{query: options.query}];
  }

  createExecuteQueryStream(options: {
    preparedStatement: {query: string};
    parameters?: Record<string, unknown>;
  }): Readable {
    const recorded = this.queries[this.queries.length - 1];
    recorded.parameters = options.parameters;
    parseParameters(options.parameters ?? {}, recorded.parameterTypes ?? {});
    const stream = Readable.from(this.setup.rows ?? [], {objectMode: true});
    stream.on('close', () => {
      this.destroyedStreams++;
    });
    return stream;
  }
}

/**
 * The JavaScript type each declared GoogleSQL type is built from.
 *
 * Taken from `convertJsValueToValue` in the SDK's `parameterparsing.js`. DATE
 * and TIMESTAMP are absent because the query tool does not declare them.
 */
const NATIVE_PARAMETER_TYPES: Record<string, (value: unknown) => boolean> = {
  bool: (value) => typeof value === 'boolean',
  bytes: (value) => value instanceof Uint8Array,
  float32: (value) => typeof value === 'number',
  float64: (value) => typeof value === 'number',
  int64: (value) => typeof value === 'bigint',
  string: (value) => typeof value === 'string',
};

/**
 * Rejects a parameter bag the real SDK would reject.
 *
 * `Instance.createExecuteQueryStream` calls `parseParameters`, which throws
 * when the two bags do not name the same parameters and when a value is not
 * the native type its declared type is built from. The fake performs the same
 * checks, so a test cannot pass on arguments the SDK would refuse.
 */
function parseParameters(
  parameters: Record<string, unknown>,
  parameterTypes: Record<string, {type: string}>,
): void {
  const names = Object.keys(parameters);
  const declared = Object.keys(parameterTypes);
  if (names.length !== declared.length) {
    throw new Error(
      `Number of parameters (${names.length}) does not match number of parameter types (${declared.length}).`,
    );
  }
  for (const [name, value] of Object.entries(parameters)) {
    const type = parameterTypes[name];
    if (type === undefined) {
      throw new Error(`Unrecognized parameter: ${name}`);
    }
    if (value === null) {
      continue;
    }
    const accepts = NATIVE_PARAMETER_TYPES[type.type];
    if (accepts === undefined) {
      throw new Error(`Unsupported parameter type: ${type.type}`);
    }
    if (!accepts(value)) {
      throw new Error(
        `Value ${String(value)} cannot be converted to ${type.type}.`,
      );
    }
  }
}

/** The stand-in for the SDK's `Bigtable` class. */
export class FakeBigtable {
  /** Every client the mocked module constructed, oldest first. */
  static readonly created: FakeBigtable[] = [];
  /** What the next clients answer with. */
  static setup: FakeBigtableSetup = {};

  /** How many times this client was closed. */
  closes = 0;

  private readonly openedInstances = new Map<string, FakeInstance>();

  constructor(readonly options: Record<string, unknown>) {
    FakeBigtable.created.push(this);
  }

  /** Clears the recorded clients and the configured answers. */
  static reset(setup: FakeBigtableSetup = {}): void {
    FakeBigtable.created.length = 0;
    FakeBigtable.setup = setup;
  }

  async getInstances(): Promise<
    [Array<{id: string; metadata: FakeInstanceMetadata}>, string[]]
  > {
    if (FakeBigtable.setup.listError) {
      throw FakeBigtable.setup.listError;
    }
    return [
      FakeBigtable.setup.listedInstances ?? [],
      FakeBigtable.setup.failedInstanceLocations ?? [],
    ];
  }

  instance(id: string): FakeInstance {
    const opened = this.openedInstances.get(id);
    if (opened !== undefined) {
      return opened;
    }
    const instance = new FakeInstance(
      id,
      FakeBigtable.setup.instances?.[id] ?? {},
    );
    this.openedInstances.set(id, instance);
    return instance;
  }

  async close(): Promise<void> {
    this.closes++;
    if (FakeBigtable.setup.closeError) {
      throw FakeBigtable.setup.closeError;
    }
  }
}
