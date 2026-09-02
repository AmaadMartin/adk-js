/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * An in-memory stand-in for the `@google-cloud/storage` client, holding only
 * the surface the eval managers use: whether a bucket exists, and reading,
 * writing and listing whole text blobs.
 */

/** One blob of a {@link FakeGcsBucket}. */
export interface FakeGcsBlob {
  contents: string;
  contentType?: string;
}

/** The handle a caller gets for one blob, present or not. */
export class FakeGcsFile {
  constructor(
    readonly name: string,
    private readonly bucket: FakeGcsBucket,
  ) {}

  async exists(): Promise<[boolean]> {
    return [this.bucket.blobs.has(this.name)];
  }

  async download(): Promise<[Buffer]> {
    const blob = this.bucket.blobs.get(this.name);
    if (!blob) {
      throw new Error(`No such object: ${this.name}`);
    }
    return [Buffer.from(blob.contents, 'utf-8')];
  }

  async save(
    contents: string,
    options?: {contentType?: string},
  ): Promise<void> {
    this.bucket.blobs.set(this.name, {
      contents,
      contentType: options?.contentType,
    });
  }
}

/** One bucket of a {@link FakeStorage}. */
export class FakeGcsBucket {
  readonly blobs = new Map<string, FakeGcsBlob>();

  constructor(
    readonly name: string,
    private readonly storage: FakeStorage,
  ) {}

  async exists(): Promise<[boolean]> {
    return [this.storage.existingBuckets.has(this.name)];
  }

  file(name: string): FakeGcsFile {
    return new FakeGcsFile(name, this);
  }

  async getFiles(options?: {prefix?: string}): Promise<[FakeGcsFile[]]> {
    const prefix = options?.prefix ?? '';
    return [
      [...this.blobs.keys()]
        .filter((name) => name.startsWith(prefix))
        .map((name) => this.file(name)),
    ];
  }
}

/** The stand-in for the `Storage` client. */
export class FakeStorage {
  /** The buckets that report themselves as existing. */
  readonly existingBuckets = new Set<string>();

  private readonly buckets = new Map<string, FakeGcsBucket>();

  bucket(name: string): FakeGcsBucket {
    let bucket = this.buckets.get(name);
    if (!bucket) {
      bucket = new FakeGcsBucket(name, this);
      this.buckets.set(name, bucket);
    }
    return bucket;
  }

  /** Empties every bucket and forgets which buckets exist. */
  reset(): void {
    this.buckets.clear();
    this.existingBuckets.clear();
  }
}

/**
 * The single instance the `@google-cloud/storage` mock hands out, so that a
 * test can seed and inspect what the manager under test wrote.
 */
export const fakeStorage = new FakeStorage();
