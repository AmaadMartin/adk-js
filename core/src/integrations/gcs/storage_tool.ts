/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  FileMetadata,
  GetFilesOptions,
  Storage,
} from '@google-cloud/storage';
import {z} from 'zod';

import {formatError} from '../../utils/error_utils.js';

/** A tool call that could not be completed. */
export interface GcsErrorResult {
  status: 'ERROR';
  error_details: string;
}

/** The object names in a bucket, and the token for the next page if any. */
export interface GcsListObjectsResult {
  status: 'SUCCESS';
  results: string[];
  next_page_token?: string;
}

/** The raw Cloud Storage object resource. */
export interface GcsObjectMetadataResult {
  status: 'SUCCESS';
  results: FileMetadata;
}

/** The content of an object, and how it was encoded to reach the model. */
export interface GcsObjectDataResult {
  status: 'SUCCESS';
  results: string;
  encoding: 'text' | 'base64';
}

/** A completed write, described for the model. */
export interface GcsMessageResult {
  status: 'SUCCESS';
  results: string;
}

/**
 * Model-facing parameters stay snake_case: they appear in the function
 * declaration the model reads, so they match adk-python exactly.
 */
export const listObjectsParameters = z.object({
  bucket_name: z.string().describe('The name of the GCS bucket.'),
  prefix: z
    .string()
    .optional()
    .describe('Filter results to objects whose names begin with this prefix.'),
  page_size: z
    .number()
    .int()
    .optional()
    .describe('The maximum number of objects to return in a single page.'),
  page_token: z
    .string()
    .optional()
    .describe('A page token, received from a previous list_objects call.'),
});

export const getObjectMetadataParameters = z.object({
  bucket_name: z
    .string()
    .describe('The name of the GCS bucket containing the object.'),
  object_name: z.string().describe('The name of the GCS object.'),
  generation: z
    .number()
    .int()
    .optional()
    .describe('If present, selects a specific generation of this object.'),
});

export const getObjectDataParameters = z.object({
  bucket_name: z.string().describe('The name of the GCS bucket.'),
  object_name: z.string().describe('The name of the GCS object.'),
  generation: z
    .number()
    .int()
    .optional()
    .describe('If present, selects a specific generation of this object.'),
  destination_file_path: z
    .string()
    .optional()
    .describe(
      'The local filesystem path to save the downloaded file. The path is ' +
        'not sandboxed: the object is written wherever this points.',
    ),
});

export const createObjectParameters = z.object({
  bucket_name: z.string().describe('The name of the GCS bucket.'),
  object_name: z.string().describe('The name of the GCS object to create.'),
  data: z.string().optional().describe('The content to write to the object.'),
  source_file_path: z
    .string()
    .optional()
    .describe(
      'The local filesystem path of the file to upload. The path is not ' +
        'sandboxed. Every file this process can read can be uploaded.',
    ),
});

export const deleteObjectsParameters = z.object({
  bucket_name: z.string().describe('The name of the GCS bucket.'),
  object_names: z.array(z.string()).describe('List of object names to delete.'),
});

/** Arguments of {@link listObjects}. */
export type ListObjectsArgs = z.infer<typeof listObjectsParameters>;
/** Arguments of {@link getObjectMetadata}. */
export type GetObjectMetadataArgs = z.infer<typeof getObjectMetadataParameters>;
/** Arguments of {@link getObjectData}. */
export type GetObjectDataArgs = z.infer<typeof getObjectDataParameters>;
/** Arguments of {@link createObject}. */
export type CreateObjectArgs = z.infer<typeof createObjectParameters>;
/** Arguments of {@link deleteObjects}. */
export type DeleteObjectsArgs = z.infer<typeof deleteObjectsParameters>;

/** True when the Cloud Storage SDK reported HTTP 404 for a request. */
function isNotFound(err: unknown): boolean {
  return (
    typeof err === 'object' && err !== null && 'code' in err && err.code === 404
  );
}

/** Describes a failed call, without leaking a stack trace to the model. */
export function errorResult(err: unknown): GcsErrorResult {
  return {status: 'ERROR', error_details: formatError(err)};
}

/**
 * Describes a failed object call. A missing object reports adk-python's
 * wording, because the Node client raises HTTP 404 where the Python client
 * returns no blob.
 */
function objectErrorResult(
  err: unknown,
  bucketName: string,
  objectName: string,
): GcsErrorResult {
  if (isNotFound(err)) {
    return {
      status: 'ERROR',
      error_details: `Object ${objectName} not found in bucket ${bucketName}`,
    };
  }
  return errorResult(err);
}

/** Decodes strict UTF-8, or returns undefined when the bytes are not UTF-8. */
function decodeUtf8(bytes: Buffer): string | undefined {
  try {
    return new TextDecoder('utf-8', {fatal: true}).decode(bytes);
  } catch {
    return undefined;
  }
}

/**
 * Lists object names in a Cloud Storage bucket.
 *
 * With `page_size` set, only the first page is returned, together with the
 * token for the next one. Without it, every page is walked and no token is
 * reported.
 *
 * @param client The Cloud Storage client.
 * @param args The bucket to list and how to page through it.
 * @return The object names, or the failure.
 */
export async function listObjects(
  client: Storage,
  args: ListObjectsArgs,
): Promise<GcsListObjectsResult | GcsErrorResult> {
  const {
    bucket_name: bucketName,
    prefix,
    page_size: pageSize,
    page_token: pageToken,
  } = args;
  try {
    const query: GetFilesOptions = {};
    if (prefix !== undefined) {
      query.prefix = prefix;
    }
    if (pageToken !== undefined) {
      query.pageToken = pageToken;
    }
    if (pageSize !== undefined) {
      query.maxResults = pageSize;
      // Auto-pagination would walk past the requested page and lose the token.
      query.autoPaginate = false;
    }

    const [files, nextQuery] = await client.bucket(bucketName).getFiles(query);
    const result: GcsListObjectsResult = {
      status: 'SUCCESS',
      results: files.map((file) => file.name),
    };
    const nextPageToken =
      pageSize === undefined ? undefined : nextQuery?.pageToken;
    if (nextPageToken) {
      result.next_page_token = nextPageToken;
    }
    return result;
  } catch (err) {
    return errorResult(err);
  }
}

/**
 * Reads the metadata of a Cloud Storage object.
 *
 * @param client The Cloud Storage client.
 * @param args The object to describe.
 * @return The raw object resource, or the failure.
 */
export async function getObjectMetadata(
  client: Storage,
  args: GetObjectMetadataArgs,
): Promise<GcsObjectMetadataResult | GcsErrorResult> {
  const {bucket_name: bucketName, object_name: objectName, generation} = args;
  try {
    const [metadata] = await client
      .bucket(bucketName)
      .file(objectName, generation !== undefined ? {generation} : undefined)
      .getMetadata();
    return {status: 'SUCCESS', results: metadata};
  } catch (err) {
    return objectErrorResult(err, bucketName, objectName);
  }
}

/**
 * Reads the content of a Cloud Storage object.
 *
 * Without `destination_file_path` the content is returned inline, decoded as
 * UTF-8 text where the bytes allow it and base64 otherwise.
 *
 * @param client The Cloud Storage client.
 * @param args The object to read and where to put it.
 * @return The content or the download confirmation, or the failure.
 */
export async function getObjectData(
  client: Storage,
  args: GetObjectDataArgs,
): Promise<GcsObjectDataResult | GcsMessageResult | GcsErrorResult> {
  const {
    bucket_name: bucketName,
    object_name: objectName,
    generation,
    destination_file_path: destinationFilePath,
  } = args;
  try {
    const file = client
      .bucket(bucketName)
      .file(objectName, generation !== undefined ? {generation} : undefined);

    if (destinationFilePath !== undefined) {
      await file.download({destination: destinationFilePath});
      return {
        status: 'SUCCESS',
        results: `Object ${objectName} downloaded successfully to ${destinationFilePath}.`,
      };
    }

    const [contents] = await file.download();
    const text = decodeUtf8(contents);
    if (text !== undefined) {
      return {status: 'SUCCESS', results: text, encoding: 'text'};
    }
    return {
      status: 'SUCCESS',
      results: contents.toString('base64'),
      encoding: 'base64',
    };
  } catch (err) {
    return objectErrorResult(err, bucketName, objectName);
  }
}

/**
 * Creates a Cloud Storage object from inline content or a local file.
 *
 * @param client The Cloud Storage client.
 * @param args The object to create and what to put in it.
 * @return The confirmation, or the failure.
 */
export async function createObject(
  client: Storage,
  args: CreateObjectArgs,
): Promise<GcsMessageResult | GcsErrorResult> {
  const {
    bucket_name: bucketName,
    object_name: objectName,
    data,
    source_file_path: sourceFilePath,
  } = args;
  try {
    const bucket = client.bucket(bucketName);
    if (sourceFilePath !== undefined) {
      await bucket.upload(sourceFilePath, {destination: objectName});
    } else if (data !== undefined) {
      await bucket.file(objectName).save(data);
    } else {
      return {
        status: 'ERROR',
        error_details: "Either 'data' or 'source_file_path' must be provided.",
      };
    }
    return {
      status: 'SUCCESS',
      results: `Object ${objectName} created successfully in bucket ${bucketName}.`,
    };
  } catch (err) {
    return errorResult(err);
  }
}

/**
 * Deletes objects from a Cloud Storage bucket.
 *
 * @param client The Cloud Storage client.
 * @param args The bucket and the object names to delete.
 * @return The confirmation, or the failure.
 */
export async function deleteObjects(
  client: Storage,
  args: DeleteObjectsArgs,
): Promise<GcsMessageResult | GcsErrorResult> {
  const {bucket_name: bucketName, object_names: objectNames} = args;
  try {
    const bucket = client.bucket(bucketName);
    await Promise.all(objectNames.map((name) => bucket.file(name).delete()));
    return {
      status: 'SUCCESS',
      results: `Objects ${objectNames.join(', ')} deleted successfully from bucket ${bucketName}.`,
    };
  } catch (err) {
    return errorResult(err);
  }
}
