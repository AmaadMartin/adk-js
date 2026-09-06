/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Sends analytics content that is too large to inline to Cloud Storage, and
 * names what it wrote.
 *
 * The row then carries a `gs://` URI and an `object_ref` in place of the
 * bytes. Everything about where an object goes lives here: the caller decides
 * only whether a part is too large.
 */

import type {Bucket, StorageOptions} from '@google-cloud/storage';
import {loadOptionalPeer} from '../utils/optional_peer.js';
import type {AnalyticsObjectRef} from './bigquery_analytics_schema.js';

/** Object-name extension for a MIME type this module does not recognize. */
const DEFAULT_EXTENSION = '.bin';

/** Object-name extension of an offloaded text object. */
export const TEXT_EXTENSION = '.txt';

/**
 * Extensions for the MIME types an agent turn actually carries. Node has no
 * MIME database of its own, and one small map is cheaper than a dependency.
 */
const EXTENSION_BY_MIME_TYPE: ReadonlyMap<string, string> = new Map([
  ['application/json', '.json'],
  ['application/pdf', '.pdf'],
  ['audio/mpeg', '.mp3'],
  ['audio/ogg', '.ogg'],
  ['audio/wav', '.wav'],
  ['image/gif', '.gif'],
  ['image/jpeg', '.jpg'],
  ['image/png', '.png'],
  ['image/webp', '.webp'],
  ['text/csv', '.csv'],
  ['text/html', '.html'],
  ['text/plain', '.txt'],
  ['video/mp4', '.mp4'],
  ['video/webm', '.webm'],
]);

/**
 * Stores content too large to inline and names where it went.
 * {@link GcsOffloader} is the Cloud Storage implementation.
 */
export interface ContentOffloader {
  uploadContent(
    data: Buffer | string,
    contentType: string,
    path: string,
  ): Promise<string>;
}

/** What {@link GcsOffloader} needs to reach a bucket. */
export interface GcsOffloaderOptions {
  /** Cloud project owning the bucket. */
  projectId: string;
  /** Bucket that receives the offloaded content. */
  bucketName: string;
}

/** What one part's object name is built from. */
export interface OffloadObjectScope {
  /** The trace the calling event belongs to. */
  traceId: string;
  /** The span the calling event belongs to. */
  spanId: string;
  /**
   * Unique to one parse call. The part index restarts per `Content`, so
   * without it two messages of one request collide at the same part ordinal.
   */
  parseUid: string;
  /** The message index within a multi-content request. */
  contentOrdinal: number;
  /** The part index within its message. */
  partIndex: number;
}

/** Today's date in the local zone, as `YYYY-MM-DD`. */
function localDate(): string {
  const now = new Date();
  const month = `${now.getMonth() + 1}`.padStart(2, '0');
  const day = `${now.getDate()}`.padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}

/**
 * The object-name extension for `mimeType`.
 *
 * @param mimeType The MIME type the part declares.
 * @return The extension, including its dot.
 */
export function fileExtension(mimeType: string): string {
  return (
    EXTENSION_BY_MIME_TYPE.get(mimeType.toLowerCase()) ?? DEFAULT_EXTENSION
  );
}

/**
 * The object name one part's content is written under.
 *
 * The date and the trace group one run's objects together. The rest makes the
 * name unique, which is what lets the upload be create-only.
 *
 * @param scope The event and the part the object belongs to.
 * @param extension The extension to end the name with.
 * @return The object name, relative to the bucket.
 */
export function objectPath(
  scope: OffloadObjectScope,
  extension: string,
): string {
  return (
    `${localDate()}/${scope.traceId}/${scope.spanId}` +
    `_${scope.parseUid}_c${scope.contentOrdinal}_p${scope.partIndex}${extension}`
  );
}

/**
 * The `object_ref` column value for an object at `uri`.
 *
 * @param uri The `gs://` URI naming the object.
 * @param contentType The MIME type recorded on it.
 * @param connectionId The BigQuery connection allowed to read it, if any.
 * @return The column value.
 */
export function buildObjectRef(
  uri: string,
  contentType: string,
  connectionId: string | undefined,
): AnalyticsObjectRef {
  return {
    uri,
    version: null,
    authorizer: connectionId ?? null,
    details: JSON.stringify({gcs_metadata: {content_type: contentType}}),
  };
}

/**
 * Uploads content that is too large to inline into a BigQuery row.
 *
 * The offloader owns one bucket handle for its whole life, so the optional
 * `@google-cloud/storage` peer is loaded once and reused by every upload.
 * Callers get back a `gs://` URI and put that in the row instead of the bytes.
 */
export class GcsOffloader implements ContentOffloader {
  private readonly bucketName: string;
  private readonly storageOptions: StorageOptions;
  private bucketPromise?: Promise<Bucket>;

  constructor(options: GcsOffloaderOptions) {
    this.bucketName = options.bucketName;
    this.storageOptions = {projectId: options.projectId};
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
    this.bucketPromise ??= loadOptionalPeer(
      {
        packageName: '@google-cloud/storage',
        feature: 'BigQueryAgentAnalyticsPlugin content offload',
      },
      () => import('@google-cloud/storage'),
    ).then(({Storage}) =>
      new Storage(this.storageOptions).bucket(this.bucketName),
    );
    return this.bucketPromise;
  }
}
