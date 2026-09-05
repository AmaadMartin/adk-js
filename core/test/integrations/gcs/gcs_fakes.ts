/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A scriptable stand-in for `@google-cloud/storage`.
 *
 * A test installs it with
 * `vi.mock('@google-cloud/storage', async () => ({Storage: (await
 * import('./gcs_fakes.js')).FakeStorage}))`, then reads
 * {@link storageInstances} to see what the code under test built and asked
 * for.
 */

import type {
  BucketMetadata,
  CreateBucketRequest,
  GetBucketsRequest,
  StorageOptions,
} from '@google-cloud/storage';

/** Every fake client built since the last {@link resetGcsFakes}. */
export const storageInstances: FakeStorage[] = [];

/** Scripts each new client, so a test can set up before the code runs. */
export const gcsFakeHooks: {onCreate: (storage: FakeStorage) => void} = {
  onCreate: () => {},
};

/** Clears the recorded clients and any hook a test installed. */
export function resetGcsFakes(): void {
  storageInstances.length = 0;
  gcsFakeHooks.onCreate = () => {};
}

/** A stand-in for `Bucket`, recording what was done to it. */
export class FakeBucket {
  /** Every metadata patch `setMetadata` received, in order. */
  readonly patches: BucketMetadata[] = [];
  /** How many times `getMetadata` was called. */
  getMetadataCalls = 0;
  /** How many times `delete` was called. */
  deleteCalls = 0;

  constructor(
    readonly name: string,
    private readonly storage: FakeStorage,
  ) {}

  async getMetadata(): Promise<[BucketMetadata]> {
    this.getMetadataCalls++;
    this.storage.failIfScripted('getMetadata');
    return [this.storage.metadata.get(this.name) ?? {name: this.name}];
  }

  async setMetadata(patch: BucketMetadata): Promise<[BucketMetadata]> {
    this.storage.failIfScripted('setMetadata');
    this.patches.push(patch);
    return [patch];
  }

  async delete(): Promise<void> {
    this.deleteCalls++;
    this.storage.failIfScripted('delete');
  }
}

/** A stand-in for `Storage`, recording the options it was built with. */
export class FakeStorage {
  /** The buckets handed out by {@link bucket}, keyed by name. */
  readonly buckets = new Map<string, FakeBucket>();
  /** Every request {@link getBuckets} received, in order. */
  readonly getBucketsRequests: GetBucketsRequest[] = [];
  /** Every bucket {@link createBucket} was asked to create, in order. */
  readonly createBucketRequests: Array<{
    name: string;
    metadata?: CreateBucketRequest;
  }> = [];
  /** What `getMetadata` reports, keyed by bucket name. */
  readonly metadata = new Map<string, BucketMetadata>();
  /** The errors a method rejects with, keyed by method name. */
  readonly failures = new Map<string, Error>();
  /** The bucket names {@link getBuckets} reports. */
  bucketNames: string[] = [];
  /** The token {@link getBuckets} reports for the page after this one. */
  nextPageToken?: string;

  constructor(readonly options: StorageOptions) {
    storageInstances.push(this);
    gcsFakeHooks.onCreate(this);
  }

  /** Rejects when a test scripted `method` to fail. */
  failIfScripted(method: string): void {
    const failure = this.failures.get(method);
    if (failure) {
      throw failure;
    }
  }

  bucket(name: string): FakeBucket {
    let bucket = this.buckets.get(name);
    if (!bucket) {
      bucket = new FakeBucket(name, this);
      this.buckets.set(name, bucket);
    }
    return bucket;
  }

  async getBuckets(
    request: GetBucketsRequest = {},
  ): Promise<[FakeBucket[], unknown]> {
    this.getBucketsRequests.push(request);
    this.failIfScripted('getBuckets');
    const buckets = this.bucketNames.map((name) => this.bucket(name));
    const nextQuery = this.nextPageToken
      ? {...request, pageToken: this.nextPageToken}
      : null;
    return [buckets, nextQuery];
  }

  async createBucket(
    name: string,
    metadata?: CreateBucketRequest,
  ): Promise<[FakeBucket, unknown]> {
    this.createBucketRequests.push({name, metadata});
    this.failIfScripted('createBucket');
    return [this.bucket(name), {}];
  }
}
