/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {BucketMetadata} from '@google-cloud/storage';
import {AuthClient} from 'google-auth-library';

import {GoogleToolStatus} from '../../tools/google_tool.js';
import {formatError} from '../../utils/error_utils.js';

import {getGcsClient} from './client.js';

/**
 * What a Cloud Storage admin tool reports back to the model.
 *
 * The keys and the two `status` values cross the language boundary —
 * adk-python emits the same ones — so they stay snake_case and upper case.
 */
export type GcsAdminToolResult =
  | {
      status: GoogleToolStatus.SUCCESS;
      results: unknown;
      /** The token for the next page, when one more page exists. */
      next_page_token?: string;
    }
  | {status: GoogleToolStatus.ERROR; error_details: string};

/**
 * Arguments shared by every tool that addresses a single bucket, and all
 * {@link getBucket} and {@link deleteBucket} take.
 */
export interface BucketOptions {
  /** The name of the Cloud Storage bucket. */
  bucketName: string;
  /** The credential the request is made with. */
  credentials?: AuthClient;
}

/** Arguments accepted by {@link listBuckets}. */
export interface ListBucketsOptions {
  /** The Google Cloud project id whose buckets are listed. */
  projectId: string;
  /** The credential the request is made with. */
  credentials?: AuthClient;
  /** The maximum number of buckets in one page. Unset lists every bucket. */
  pageSize?: number;
  /** A page token from an earlier {@link listBuckets} call. */
  pageToken?: string;
}

/** Arguments accepted by {@link createBucket}. */
export interface CreateBucketOptions extends BucketOptions {
  /** The Google Cloud project id the bucket is created in. */
  projectId: string;
  /** Where the bucket is stored, such as `US` or `europe-west1`. */
  location?: string;
}

/** Arguments accepted by {@link updateBucket}. */
export interface UpdateBucketOptions extends BucketOptions {
  /** Whether object versioning is on. Unset leaves it unchanged. */
  versioningEnabled?: boolean;
  /** Whether uniform bucket-level access is on. Unset leaves it unchanged. */
  uniformBucketLevelAccessEnabled?: boolean;
}

/** Wraps a failure in the error shape, so a tool never throws at the model. */
function errorResult(error: unknown): GcsAdminToolResult {
  return {status: GoogleToolStatus.ERROR, error_details: formatError(error)};
}

/**
 * The token for the page after the one just read.
 *
 * `getBuckets` reports it as a follow-up query object, and reports `null` when
 * the page just read was the last one.
 */
function nextPageTokenOf(nextQuery: unknown): string | undefined {
  if (
    typeof nextQuery === 'object' &&
    nextQuery !== null &&
    'pageToken' in nextQuery &&
    typeof nextQuery.pageToken === 'string'
  ) {
    return nextQuery.pageToken;
  }
  return undefined;
}

/**
 * Lists the Cloud Storage bucket names in a Google Cloud project.
 *
 * Without a `pageSize` it walks every page and reports no page token. With
 * one it reads a single page, and reports a token only when another page
 * exists.
 *
 * @param options The project, the credential and the paging window.
 * @return The bucket names, or the failure.
 */
export async function listBuckets(
  options: ListBucketsOptions,
): Promise<GcsAdminToolResult> {
  try {
    const storage = await getGcsClient({
      project: options.projectId,
      credentials: options.credentials,
    });

    if (options.pageSize === undefined) {
      const [buckets] = await storage.getBuckets();
      return {
        status: GoogleToolStatus.SUCCESS,
        results: buckets.map((bucket) => bucket.name),
      };
    }

    const [buckets, nextQuery] = await storage.getBuckets({
      maxResults: options.pageSize,
      autoPaginate: false,
      ...(options.pageToken !== undefined
        ? {pageToken: options.pageToken}
        : {}),
    });
    const nextPageToken = nextPageTokenOf(nextQuery);
    return {
      status: GoogleToolStatus.SUCCESS,
      results: buckets.map((bucket) => bucket.name),
      ...(nextPageToken ? {next_page_token: nextPageToken} : {}),
    };
  } catch (error: unknown) {
    return errorResult(error);
  }
}

/**
 * Reads the metadata of a Cloud Storage bucket.
 *
 * @param options The bucket name and the credential.
 * @return The whole metadata object, or the failure.
 */
export async function getBucket(
  options: BucketOptions,
): Promise<GcsAdminToolResult> {
  try {
    const storage = await getGcsClient({credentials: options.credentials});
    const [metadata] = await storage.bucket(options.bucketName).getMetadata();
    return {status: GoogleToolStatus.SUCCESS, results: metadata};
  } catch (error: unknown) {
    return errorResult(error);
  }
}

/**
 * Creates a Cloud Storage bucket.
 *
 * @param options The project, the bucket name, the credential and the
 *     location.
 * @return A confirmation message, or the failure.
 */
export async function createBucket(
  options: CreateBucketOptions,
): Promise<GcsAdminToolResult> {
  try {
    const storage = await getGcsClient({
      project: options.projectId,
      credentials: options.credentials,
    });
    const [bucket] = await storage.createBucket(options.bucketName, {
      ...(options.location !== undefined ? {location: options.location} : {}),
    });
    return {
      status: GoogleToolStatus.SUCCESS,
      results: `Bucket ${bucket.name} created successfully.`,
    };
  } catch (error: unknown) {
    return errorResult(error);
  }
}

/**
 * Turns object versioning or uniform bucket-level access on or off.
 *
 * A flag left unset is left unchanged. With both unset the bucket is read but
 * not written.
 *
 * @param options The bucket name, the credential and the two flags.
 * @return A confirmation message, or the failure.
 */
export async function updateBucket(
  options: UpdateBucketOptions,
): Promise<GcsAdminToolResult> {
  try {
    const storage = await getGcsClient({credentials: options.credentials});
    const bucket = storage.bucket(options.bucketName);
    // adk-python fetches the bucket before patching it, so a name that does
    // not exist reports an error even when no flag was supplied.
    await bucket.getMetadata();

    const patch: BucketMetadata = {};
    if (options.versioningEnabled !== undefined) {
      patch.versioning = {enabled: options.versioningEnabled};
    }
    if (options.uniformBucketLevelAccessEnabled !== undefined) {
      patch.iamConfiguration = {
        uniformBucketLevelAccess: {
          enabled: options.uniformBucketLevelAccessEnabled,
        },
      };
    }
    if (Object.keys(patch).length > 0) {
      await bucket.setMetadata(patch);
    }

    return {
      status: GoogleToolStatus.SUCCESS,
      results: `Bucket ${bucket.name} updated successfully.`,
    };
  } catch (error: unknown) {
    return errorResult(error);
  }
}

/**
 * Deletes a Cloud Storage bucket. The deletion cannot be undone.
 *
 * @param options The bucket name and the credential.
 * @return A confirmation message, or the failure.
 */
export async function deleteBucket(
  options: BucketOptions,
): Promise<GcsAdminToolResult> {
  try {
    const storage = await getGcsClient({credentials: options.credentials});
    await storage.bucket(options.bucketName).delete();
    return {
      status: GoogleToolStatus.SUCCESS,
      results: `Bucket ${options.bucketName} deleted successfully.`,
    };
  } catch (error: unknown) {
    return errorResult(error);
  }
}
