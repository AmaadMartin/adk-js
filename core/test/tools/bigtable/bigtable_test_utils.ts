/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Mock, vi} from 'vitest';

import {BigtableToolResult} from '../../../src/tools/bigtable/tool_result.js';

/** The instance metadata fields the Bigtable tools read. */
export interface FakeInstanceMetadata {
  displayName?: string;
  state?: string;
  type?: string;
  labels?: Record<string, string>;
}

/** The cluster metadata fields the Bigtable tools read. */
export interface FakeClusterMetadata {
  state?: string;
  serveNodes?: number;
  defaultStorageType?: string;
  location?: string;
  clusterConfig?: {
    clusterAutoscalingConfig?: {
      autoscalingLimits?: {minServeNodes?: number; maxServeNodes?: number};
      autoscalingTargets?: {cpuUtilizationPercent?: number};
    };
  };
}

/** The table metadata fields the Bigtable tools read. */
export interface FakeTableMetadata {
  columnFamilies?: Record<string, unknown>;
}

export interface FakeTable {
  id: string;
  getMetadata: Mock<() => Promise<[FakeTableMetadata]>>;
}

export interface FakeCluster {
  id: string;
  name: string;
  metadata?: FakeClusterMetadata;
  getMetadata: Mock<() => Promise<[FakeClusterMetadata]>>;
}

export interface FakeInstance {
  id: string;
  getMetadata: Mock<() => Promise<[FakeInstanceMetadata]>>;
  getTables: Mock<() => Promise<[Array<{id: string; name: string}>]>>;
  getClusters: Mock<() => Promise<[FakeCluster[]]>>;
  table: Mock<(tableId: string) => FakeTable>;
  cluster: Mock<(clusterId: string) => FakeCluster>;
  prepareStatement: Mock<
    (options: {
      query: string;
      parameterTypes?: Record<string, unknown>;
    }) => Promise<[object]>
  >;
  createExecuteQueryStream: Mock<
    (options: {
      preparedStatement: object;
      parameters?: Record<string, unknown>;
    }) => AsyncIterable<unknown>
  >;
}

/**
 * Stands in for the SDK's `Bigtable` client. Tests install it by mocking
 * `@google-cloud/bigtable`, so production code still sees the real type while
 * the test keeps a precisely typed handle on the fake.
 */
export interface FakeBigtable {
  projectId: string;
  getInstances: Mock<
    () => Promise<[Array<{id: string; metadata?: FakeInstanceMetadata}>]>
  >;
  instance: Mock<(instanceId: string) => FakeInstance>;
  close: Mock<() => Promise<void[]>>;
}

export function fakeTable(overrides: Partial<FakeTable> = {}): FakeTable {
  return {id: 'table1', getMetadata: vi.fn(), ...overrides};
}

export function fakeCluster(overrides: Partial<FakeCluster> = {}): FakeCluster {
  return {
    id: 'cluster1',
    name: 'projects/proj-1/instances/inst1/clusters/cluster1',
    getMetadata: vi.fn(),
    ...overrides,
  };
}

export function fakeInstance(
  overrides: Partial<FakeInstance> = {},
): FakeInstance {
  return {
    id: 'inst1',
    getMetadata: vi.fn(),
    getTables: vi.fn(),
    getClusters: vi.fn(),
    table: vi.fn(),
    cluster: vi.fn(),
    prepareStatement: vi.fn(),
    createExecuteQueryStream: vi.fn(),
    ...overrides,
  };
}

/** A row (or struct) shaped like the SDK's positional `NamedList`. */
export interface FakeNamedList {
  values: unknown[];
  fieldMapping: object;
  getFieldNameAtIndex(index: number): string | null;
}

/**
 * Builds a `NamedList` the way `createExecuteQueryStream` emits one: cells are
 * stored positionally and column names are resolved by index.
 */
export function fakeNamedList(
  columns: Array<[string | null, unknown]>,
): FakeNamedList {
  return {
    values: columns.map(([, value]) => value),
    fieldMapping: {},
    getFieldNameAtIndex: (index) => columns[index]?.[0] ?? null,
  };
}

/** Turns rows into the async iterable `createExecuteQueryStream` returns. */
export async function* fakeQueryStream(
  rows: FakeNamedList[],
): AsyncIterable<unknown> {
  for (const row of rows) {
    yield row;
  }
}

/** Asserts the tool succeeded and narrows the result to its payload. */
export function expectSuccess<T>(result: BigtableToolResult<T>): T {
  if (result.status !== 'SUCCESS') {
    throw new Error(`Expected SUCCESS but got ERROR: ${result.error_details}`);
  }
  return result.results;
}

/** Asserts the tool failed and narrows the result to its error message. */
export function expectErrorDetails<T>(result: BigtableToolResult<T>): string {
  if (result.status !== 'ERROR') {
    throw new Error(
      `Expected ERROR but got SUCCESS: ${JSON.stringify(result.results)}`,
    );
  }
  return result.error_details;
}
