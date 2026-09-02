/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The GCS bucket the eval managers read and write.
 *
 * Both managers hold one bucket handle for their whole lifetime, resolve it on
 * first use, and speak to it in whole JSON blobs. That shared resource is what
 * this class owns.
 */

import type {Bucket, StorageOptions} from '@google-cloud/storage';
import {loadOptionalPeer} from '../utils/optional_peer.js';

/** The content type every blob an eval manager writes carries. */
const JSON_CONTENT_TYPE = 'application/json';

/** Reads and writes an eval manager's JSON blobs in one bucket. */
export class GcsEvalStorage {
  private bucketPromise?: Promise<Bucket>;

  /**
   * @param bucketName The bucket holding the eval data.
   * @param feature The manager using the bucket, named in its errors.
   * @param storageOptions Passed to the `@google-cloud/storage` client.
   */
  constructor(
    readonly bucketName: string,
    private readonly feature: string,
    private readonly storageOptions?: StorageOptions,
  ) {}

  /** Returns the blob's contents, or undefined when there is no such blob. */
  async read(blobName: string): Promise<string | undefined> {
    const file = (await this.getBucket()).file(blobName);
    const [exists] = await file.exists();
    if (!exists) {
      return undefined;
    }
    const [contents] = await file.download();
    return contents.toString('utf-8');
  }

  /** Writes the blob, replacing whatever it held. */
  async write(blobName: string, contents: string): Promise<void> {
    await (await this.getBucket())
      .file(blobName)
      .save(contents, {contentType: JSON_CONTENT_TYPE});
  }

  /** Returns the names of every blob under the prefix. */
  async listNames(prefix: string): Promise<string[]> {
    const [files] = await (await this.getBucket()).getFiles({prefix});
    return files.map((file) => file.name);
  }

  /**
   * Resolves the bucket handle, loading the `@google-cloud/storage` optional
   * peer on first use.
   *
   * @throws {Error} When the bucket does not exist. adk-python checks this
   *   when the manager is constructed; a constructor cannot await, so the
   *   check happens on the first operation instead.
   */
  private getBucket(): Promise<Bucket> {
    this.bucketPromise ??= loadOptionalPeer(
      {packageName: '@google-cloud/storage', feature: this.feature},
      () => import('@google-cloud/storage'),
    ).then(async ({Storage}) => {
      const bucket = new Storage(this.storageOptions).bucket(this.bucketName);
      const [exists] = await bucket.exists();
      if (!exists) {
        throw new Error(
          `Bucket \`${this.bucketName}\` does not exist. Please create it ` +
            `before using the ${this.feature}.`,
        );
      }
      return bucket;
    });
    return this.bucketPromise;
  }
}

/**
 * Returns the last segment of a blob name, without the given suffix. Callers
 * pass names they have already filtered by that suffix.
 */
export function blobIdFromName(blobName: string, suffix: string): string {
  return blobName.slice(blobName.lastIndexOf('/') + 1, -suffix.length);
}
