/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * An in-memory stand-in for `@google-cloud/storage`, covering the surface the
 * Cloud Storage tools use: object listing with real pagination, metadata
 * reads, downloads, uploads and deletes.
 *
 * Install it with `vi.mock('@google-cloud/storage', () => ({Storage:
 * FakeStorage}))`. Tests obtain their client from `createGcsClient()`, so the
 * client stays typed as the SDK's `Storage` and inspect the recorded calls
 * through {@link fakeGcs} instead of casting.
 */

import {readFileSync, writeFileSync} from 'node:fs';

/** The metadata a fake object reports, shaped like the raw API resource. */
export interface FakeObjectMetadata {
  kind: string;
  id: string;
  name: string;
  bucket: string;
  size: string;
  generation?: number;
  contentType?: string;
  metadata?: Record<string, string>;
}

/** What the fake bucket holds for one object name. */
export interface FakeObject {
  data: Buffer;
  metadata: FakeObjectMetadata;
}

/** The listing query the tools pass to `getFiles`. */
export interface FakeGetFilesQuery {
  prefix?: string;
  maxResults?: number;
  pageToken?: string;
  autoPaginate?: boolean;
}

/** An error shaped like the SDK's `ApiError`, which carries an HTTP code. */
export class FakeApiError extends Error {
  constructor(
    message: string,
    readonly code: number,
  ) {
    super(message);
    this.name = 'FakeApiError';
  }
}

/** A handle on one object name, as `bucket.file()` returns. */
export class FakeGcsFile {
  constructor(
    readonly name: string,
    private readonly bucket: FakeGcsBucket,
  ) {}

  private require(): FakeObject {
    this.bucket.failIfArmed();
    const object = this.bucket.objects.get(this.name);
    if (!object) {
      throw new FakeApiError(`No such object: ${this.name}`, 404);
    }
    return object;
  }

  async getMetadata(): Promise<[FakeObjectMetadata]> {
    return [this.require().metadata];
  }

  async download(options?: {destination?: string}): Promise<[Buffer]> {
    const {data} = this.require();
    if (options?.destination !== undefined) {
      writeFileSync(options.destination, data);
    }
    return [data];
  }

  async save(data: string | Buffer): Promise<void> {
    this.bucket.put(
      this.name,
      Buffer.isBuffer(data) ? data : Buffer.from(data),
    );
  }

  async delete(): Promise<void> {
    this.require();
    this.bucket.objects.delete(this.name);
  }
}

/** An in-memory bucket that records the queries made against it. */
export class FakeGcsBucket {
  readonly objects = new Map<string, FakeObject>();
  readonly getFilesQueries: FakeGetFilesQuery[] = [];
  readonly fileCalls: Array<{name: string; generation?: number}> = [];
  readonly uploads: Array<{path: string; destination?: string}> = [];
  /** When set, every operation on this bucket fails with this error. */
  failure?: Error;

  constructor(readonly name: string) {}

  /** Raises the armed failure, standing in for a backend or IAM error. */
  failIfArmed(): void {
    if (this.failure) {
      throw this.failure;
    }
  }

  /** Seeds an object, as a test fixture rather than through a tool. */
  put(objectName: string, data: Buffer): void {
    this.objects.set(objectName, {
      data,
      metadata: {
        kind: 'storage#object',
        id: `${this.name}/${objectName}/1`,
        name: objectName,
        bucket: this.name,
        size: String(data.byteLength),
      },
    });
  }

  file(objectName: string, options?: {generation?: number}): FakeGcsFile {
    this.fileCalls.push({name: objectName, generation: options?.generation});
    return new FakeGcsFile(objectName, this);
  }

  async upload(
    path: string,
    options?: {destination?: string},
  ): Promise<[FakeGcsFile]> {
    this.failIfArmed();
    this.uploads.push({path, destination: options?.destination});
    const objectName = options?.destination ?? path;
    this.put(objectName, readFileSync(path));
    return [new FakeGcsFile(objectName, this)];
  }

  async getFiles(
    query: FakeGetFilesQuery = {},
  ): Promise<[FakeGcsFile[], {pageToken?: string}]> {
    this.failIfArmed();
    this.getFilesQueries.push(query);
    const {prefix} = query;
    let names = [...this.objects.keys()].sort();
    if (prefix !== undefined) {
      names = names.filter((name) => name.startsWith(prefix));
    }
    if (query.pageToken !== undefined) {
      const start = names.indexOf(query.pageToken);
      names = start === -1 ? [] : names.slice(start);
    }
    // A page limit only truncates when the caller turned auto-pagination off,
    // matching the SDK, which otherwise walks every page for the caller.
    if (query.autoPaginate === false && query.maxResults !== undefined) {
      const page = names.slice(0, query.maxResults);
      const next = names[query.maxResults];
      return [
        page.map((name) => new FakeGcsFile(name, this)),
        next === undefined ? {} : {pageToken: next},
      ];
    }
    return [names.map((name) => new FakeGcsFile(name, this)), {}];
  }
}

/** Everything the fake recorded, shared by the mock factory and the tests. */
class FakeGcsState {
  readonly buckets = new Map<string, FakeGcsBucket>();
  /** The options each `new Storage(...)` was built with, in order. */
  readonly clientOptions: Array<Record<string, unknown>> = [];
  /** Every client the fake handed out, to check identity across calls. */
  readonly clients: FakeStorage[] = [];

  bucket(name: string): FakeGcsBucket {
    let bucket = this.buckets.get(name);
    if (!bucket) {
      bucket = new FakeGcsBucket(name);
      this.buckets.set(name, bucket);
    }
    return bucket;
  }

  reset(): void {
    this.buckets.clear();
    this.clientOptions.length = 0;
    this.clients.length = 0;
  }
}

/** The recorded state of the fake. Reset it in `beforeEach`. */
export const fakeGcs = new FakeGcsState();

/** Stands in for the SDK's `Storage` class. */
export class FakeStorage {
  constructor(options: Record<string, unknown> = {}) {
    fakeGcs.clientOptions.push(options);
    fakeGcs.clients.push(this);
  }

  bucket(name: string): FakeGcsBucket {
    return fakeGcs.bucket(name);
  }
}
