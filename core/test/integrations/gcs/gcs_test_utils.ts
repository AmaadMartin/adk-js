/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseTool,
  Context,
  createSession,
  GcsAdminToolset,
  InvocationContext,
  PluginManager,
  ReadonlyContext,
  ToolConfirmation,
  type GcsAdminToolsetOptions,
} from '@google/adk';
import {expect} from 'vitest';

/** The OAuth credentials config the tests build a toolset from. */
export const TEST_CREDENTIALS = {clientId: 'abc', clientSecret: 'def'};

/** The service-identity credentials config, which needs no end-user flow. */
export const ADC_CREDENTIALS = {applicationDefaultCredentials: true};

/** A session state holding an authorized user, as a completed flow leaves it. */
export function authorizedState(): Record<string, unknown> {
  return {
    gcs_token_cache: {
      clientId: 'abc',
      clientSecret: 'def',
      refreshToken: 'refresh-token',
      accessToken: 'access-token',
    },
  };
}

/** What one recorded call to the Cloud Storage double carried. */
export interface RecordedCall {
  method: string;
  args: unknown[];
}

/** The bucket metadata the double answers `getMetadata` with. */
export type FakeBucketMetadata = Record<string, unknown>;

/** How one {@link FakeStorage} behaves for the call under test. */
export interface FakeStorageBehaviour {
  /** Bucket names `getBuckets` reports. */
  bucketNames?: string[];
  /** The next-page query `getBuckets` returns beside them. */
  nextQuery?: unknown;
  /** The metadata `getMetadata` reports. */
  metadata?: FakeBucketMetadata;
  /** The name the created bucket reports, which need not be the one asked for. */
  createdBucketName?: string;
  /** Rejects every call with this error, for the failure-path tests. */
  failWith?: Error;
}

/**
 * A stand-in for one `@google-cloud/storage` bucket handle, recording what the
 * tool asked it to do.
 */
class FakeBucket {
  constructor(
    readonly name: string,
    private readonly storage: FakeStorage,
  ) {}

  async getMetadata(): Promise<[FakeBucketMetadata, unknown]> {
    this.storage.record('bucket.getMetadata', [this.name]);
    this.storage.throwIfFailing();
    return [this.storage.behaviour.metadata ?? {}, {}];
  }

  async setMetadata(patch: unknown): Promise<[FakeBucketMetadata]> {
    this.storage.record('bucket.setMetadata', [this.name, patch]);
    this.storage.throwIfFailing();
    return [{}];
  }

  async delete(): Promise<void> {
    this.storage.record('bucket.delete', [this.name]);
    this.storage.throwIfFailing();
  }
}

/**
 * A stand-in for the `@google-cloud/storage` client.
 *
 * It records the constructor options and every call, so a test can assert what
 * reached the client, which is what the ported adk-python tests assert on
 * their `mock.MagicMock()`.
 */
export class FakeStorage {
  readonly calls: RecordedCall[] = [];

  constructor(
    readonly options: Record<string, unknown>,
    readonly behaviour: FakeStorageBehaviour,
  ) {}

  record(method: string, args: unknown[]): void {
    this.calls.push({method, args});
  }

  throwIfFailing(): void {
    if (this.behaviour.failWith) {
      throw this.behaviour.failWith;
    }
  }

  /** The arguments of the single call to `method`. */
  callArgs(method: string): unknown[] {
    const matching = this.calls.filter((call) => call.method === method);
    expect(matching, `expected exactly one ${method} call`).toHaveLength(1);
    return matching[0].args;
  }

  /** How many times `method` was called. */
  callCount(method: string): number {
    return this.calls.filter((call) => call.method === method).length;
  }

  bucket(name: string): FakeBucket {
    this.record('bucket', [name]);
    return new FakeBucket(name, this);
  }

  async getBuckets(query?: unknown): Promise<[FakeBucket[], unknown, unknown]> {
    this.record('getBuckets', query === undefined ? [] : [query]);
    this.throwIfFailing();
    const names = this.behaviour.bucketNames ?? [];
    return [
      names.map((name) => new FakeBucket(name, this)),
      this.behaviour.nextQuery,
      {},
    ];
  }

  async createBucket(
    name: string,
    metadata?: unknown,
  ): Promise<[FakeBucket, unknown]> {
    this.record('createBucket', [name, metadata]);
    this.throwIfFailing();
    const created = this.behaviour.createdBucketName ?? name;
    return [new FakeBucket(created, this), {}];
  }
}

/**
 * Installs a `@google-cloud/storage` double and returns the clients it builds.
 *
 * The module is mocked with `vi.mock` in each test file, because `vi.mock` is
 * hoisted to the top of the file that calls it. This holds the shared state
 * that mock reads.
 */
/**
 * Builds the class a `vi.mock` factory installs as `Storage`, recording each
 * client it constructs in `registry`.
 */
function fakeStorageClass(registry: FakeStorageRegistry) {
  return class extends FakeStorage {
    constructor(options: Record<string, unknown>) {
      super(options, registry.behaviour);
      registry.built.push(this);
    }
  };
}

export class FakeStorageRegistry {
  /** Every client built since the last {@link reset}, oldest first. */
  readonly built: FakeStorage[] = [];

  behaviour: FakeStorageBehaviour = {};

  /** The constructor to install as `Storage` from a `vi.mock` factory. */
  readonly Storage = fakeStorageClass(this);

  reset(behaviour: FakeStorageBehaviour = {}): void {
    this.built.length = 0;
    this.behaviour = behaviour;
  }

  /** The single client built for the call under test. */
  only(): FakeStorage {
    expect(this.built, 'expected exactly one storage client').toHaveLength(1);
    return this.built[0];
  }
}

/** Builds a tool context whose session state starts as `state`. */
export function createToolContext(
  options: {
    state?: Record<string, unknown>;
    toolConfirmation?: ToolConfirmation;
  } = {},
): Context {
  return new Context({
    invocationContext: new InvocationContext({
      invocationId: 'test-invocation',
      session: createSession({
        id: 'test-session',
        appName: 'test-app',
        state: options.state ?? {},
      }),
      pluginManager: new PluginManager(),
    }),
    functionCallId: 'test-function-call',
    toolConfirmation: options.toolConfirmation,
  });
}

/** Builds the read-only context a toolset filters with. */
export function createReadonlyContext(): ReadonlyContext {
  return new ReadonlyContext(createToolContext().invocationContext);
}

/** A tool context that has already approved the call. */
export function createConfirmedToolContext(
  state?: Record<string, unknown>,
): Context {
  return createToolContext({
    state,
    toolConfirmation: new ToolConfirmation({confirmed: true}),
  });
}

/** Builds a toolset over {@link TEST_CREDENTIALS} unless told otherwise. */
export function createToolset(
  options: Partial<GcsAdminToolsetOptions> = {},
): GcsAdminToolset {
  return new GcsAdminToolset({
    credentialsConfig: TEST_CREDENTIALS,
    ...options,
  });
}

/** Looks one tool up by its prefixed name, failing the test when it is absent. */
export async function getTool(
  toolset: GcsAdminToolset,
  name: string,
): Promise<BaseTool> {
  const tool = (await toolset.getTools()).find((each) => each.name === name);
  if (!tool) {
    expect.fail(`toolset exposes no tool named ${name}`);
  }
  return tool;
}
