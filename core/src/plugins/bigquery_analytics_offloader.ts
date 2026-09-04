/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {Bucket, Storage, StorageOptions} from '@google-cloud/storage';
import {loadOptionalPeer} from '../utils/optional_peer.js';

/** What {@link GcsOffloader} needs to reach a bucket. */
export interface GcsOffloaderOptions {
  /** Cloud project owning the bucket. */
  projectId: string;
  /** Bucket that receives the offloaded content. */
  bucketName: string;
  /** Client to use instead of one built from `projectId`. */
  storage?: Storage;
}

/**
 * Uploads content that is too large to inline into a BigQuery row.
 *
 * The offloader owns one bucket handle for its whole life, so the optional
 * `@google-cloud/storage` peer is loaded once and reused by every upload.
 * Callers get back a `gs://` URI and put that in the row instead of the bytes.
 */
export class GcsOffloader {
  private readonly bucketName: string;
  private readonly storageOptions: StorageOptions;
  private readonly storage?: Storage;
  private bucketPromise?: Promise<Bucket>;

  constructor(options: GcsOffloaderOptions) {
    this.bucketName = options.bucketName;
    this.storageOptions = {projectId: options.projectId};
    this.storage = options.storage;
  }

  /**
   * Uploads `data` to `path` and returns the URI naming it.
   *
   * The upload is create-only. Object names are unique by construction, so a
   * name that already exists means two events raced onto one object, and
   * failing the upload is safer than rebinding a written row to another
   * event's bytes.
   *
   * @param data The bytes or the text to store.
   * @param contentType The MIME type to record on the object.
   * @param path The object name, relative to the bucket.
   * @return The `gs://` URI of the object.
   */
  async uploadContent(
    data: Buffer | string,
    contentType: string,
    path: string,
  ): Promise<string> {
    const bucket = await this.getBucket();
    await bucket.file(path).save(data, {
      contentType,
      preconditionOpts: {ifGenerationMatch: 0},
    });
    return `gs://${this.bucketName}/${path}`;
  }

  /**
   * Resolves the bucket handle, loading the `@google-cloud/storage` optional
   * peer on first use.
   */
  private getBucket(): Promise<Bucket> {
    this.bucketPromise ??= this.getStorage().then((storage) =>
      storage.bucket(this.bucketName),
    );
    return this.bucketPromise;
  }

  /** Returns the injected client, or builds one from the peer package. */
  private async getStorage(): Promise<Storage> {
    if (this.storage !== undefined) {
      return this.storage;
    }
    const {Storage} = await loadOptionalPeer(
      {
        packageName: '@google-cloud/storage',
        feature: 'BigQueryAgentAnalyticsPlugin content offload',
      },
      () => import('@google-cloud/storage'),
    );
    return new Storage(this.storageOptions);
  }
}
