/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

interface StoredObject {
  data: Buffer;
  metadata: Record<string, unknown>;
  contentType?: string;
}

interface SaveOptions {
  contentType?: string;
  metadata?: {contentType?: string; metadata?: Record<string, unknown>};
}

/** An in-memory stand-in for a `@google-cloud/storage` `File`. */
export class FakeGcsFile {
  constructor(
    public name: string,
    private bucket: FakeGcsBucket,
  ) {}

  async save(data: string | Buffer, options?: SaveOptions): Promise<void> {
    this.bucket.files.set(this.name, {
      data: Buffer.isBuffer(data) ? data : Buffer.from(data),
      metadata: options?.metadata?.metadata ?? {},
      contentType: options?.metadata?.contentType ?? options?.contentType,
    });
  }

  async download(): Promise<[Buffer]> {
    return [this.require().data];
  }

  async getMetadata(): Promise<
    [{contentType?: string; metadata?: Record<string, unknown>}]
  > {
    const file = this.require();
    return [{contentType: file.contentType, metadata: file.metadata}];
  }

  async delete(): Promise<void> {
    this.bucket.files.delete(this.name);
  }

  publicUrl(): string {
    return `https://storage.googleapis.com/${this.bucket.name}/${this.name}`;
  }

  private require(): StoredObject {
    const file = this.bucket.files.get(this.name);
    if (!file) {
      throw new Error(`File not found: ${this.name}`);
    }
    return file;
  }
}

/** An in-memory stand-in for a `@google-cloud/storage` `Bucket`. */
export class FakeGcsBucket {
  readonly files = new Map<string, StoredObject>();

  constructor(public name: string) {}

  file(name: string): FakeGcsFile {
    return new FakeGcsFile(name, this);
  }

  async getFiles(options?: {prefix?: string}): Promise<[FakeGcsFile[]]> {
    const prefix = options?.prefix ?? '';
    const names = Array.from(this.files.keys()).filter((name) =>
      name.startsWith(prefix),
    );
    return [names.map((name) => this.file(name))];
  }
}

/** An in-memory stand-in for a `@google-cloud/storage` `Storage` client. */
export class FakeStorage {
  readonly buckets = new Map<string, FakeGcsBucket>();

  bucket(name: string): FakeGcsBucket {
    let bucket = this.buckets.get(name);
    if (!bucket) {
      bucket = new FakeGcsBucket(name);
      this.buckets.set(name, bucket);
    }
    return bucket;
  }
}

/**
 * The single fake client a test installs with
 * `vi.mock('@google-cloud/storage')`. Clear `buckets` between tests.
 */
export const fakeStorage = new FakeStorage();
