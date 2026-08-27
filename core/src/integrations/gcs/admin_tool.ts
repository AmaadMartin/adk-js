/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  BucketMetadata,
  CreateBucketRequest,
  GetBucketsRequest,
  StorageOptions,
} from '@google-cloud/storage';
import {z} from 'zod';
import {BaseTool} from '../../tools/base_tool.js';
import {FunctionTool} from '../../tools/function_tool.js';
import {formatError} from '../../utils/error_utils.js';
import {getGcsClient} from './client.js';

/**
 * A successful Cloud Storage tool call and its payload.
 *
 * `status` and `results` are the keys adk-python returns, and the model reads
 * them, so they are the same in both SDKs.
 */
export interface GcsToolSuccess<T> {
  status: 'SUCCESS';
  results: T;
}

/**
 * A successful `list_buckets` call. `next_page_token` is present only when the
 * caller asked for one page and a further page follows.
 */
export interface GcsListBucketsSuccess extends GcsToolSuccess<string[]> {
  next_page_token?: string;
}

/**
 * A failed Cloud Storage tool call. A tool reports a failure this way instead
 * of throwing, so the model can read the reason and react to it.
 */
export interface GcsToolError {
  status: 'ERROR';
  error_details: string;
}

/** What a Cloud Storage tool resolves to. */
export type GcsToolResponse<T> = GcsToolSuccess<T> | GcsToolError;

const listBucketsParameters = z.object({
  project_id: z.string().describe('The Google Cloud project id.'),
  page_size: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      'The maximum number of buckets to return in a single page. Omit it to ' +
        'return every bucket in the project.',
    ),
  page_token: z
    .string()
    .optional()
    .describe('A page token, received from a previous list_buckets call.'),
});

const getBucketParameters = z.object({
  bucket_name: z.string().describe('The name of the GCS bucket.'),
});

const createBucketParameters = z.object({
  project_id: z.string().describe('The Google Cloud project id.'),
  bucket_name: z.string().describe('The name of the GCS bucket to create.'),
  location: z
    .string()
    .optional()
    .describe('The location of the bucket, for example US or europe-west1.'),
});

const updateBucketParameters = z.object({
  bucket_name: z.string().describe('The name of the GCS bucket to update.'),
  versioning_enabled: z
    .boolean()
    .optional()
    .describe('Whether to enable versioning for the bucket.'),
  uniform_bucket_level_access_enabled: z
    .boolean()
    .optional()
    .describe('Whether to enable uniform bucket-level access.'),
});

const deleteBucketParameters = z.object({
  bucket_name: z.string().describe('The name of the GCS bucket to delete.'),
});

type ListBucketsArgs = z.infer<typeof listBucketsParameters>;
type GetBucketArgs = z.infer<typeof getBucketParameters>;
type CreateBucketArgs = z.infer<typeof createBucketParameters>;
type UpdateBucketArgs = z.infer<typeof updateBucketParameters>;
type DeleteBucketArgs = z.infer<typeof deleteBucketParameters>;

/**
 * Runs `produce`, turning any failure into an `ERROR` response.
 *
 * @param produce Builds the success response, calling Cloud Storage.
 * @return The success response, or the failure the call raised.
 */
async function toGcsToolResponse<S extends GcsToolSuccess<unknown>>(
  produce: () => Promise<S>,
): Promise<S | GcsToolError> {
  try {
    return await produce();
  } catch (err: unknown) {
    return {status: 'ERROR', error_details: formatError(err)};
  }
}

/**
 * Reads the token of the following page out of the query object `getBuckets`
 * returns beside the page. The client types that object as `{}`, so the shape
 * is narrowed here rather than asserted.
 *
 * @param nextQuery The second element of the `getBuckets` response.
 * @return The token, or undefined when no further page follows.
 */
function readNextPageToken(nextQuery: unknown): string | undefined {
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
 * Lists the bucket names in a project.
 *
 * With no `page_size` the client walks every page and the response carries no
 * token. With a `page_size` the response carries one page, and
 * `next_page_token` when a further page follows.
 *
 * @param args The bucket-listing arguments.
 * @param storageOptions Options for the Cloud Storage client.
 * @return The bucket names, or the failure the call raised.
 */
export async function listBuckets(
  args: ListBucketsArgs,
  storageOptions?: StorageOptions,
): Promise<GcsListBucketsSuccess | GcsToolError> {
  return toGcsToolResponse(async () => {
    const storage = await getGcsClient({
      ...storageOptions,
      projectId: args.project_id,
    });
    const request: GetBucketsRequest = {};
    if (args.page_token !== undefined) {
      request.pageToken = args.page_token;
    }
    if (args.page_size === undefined) {
      const [buckets] = await storage.getBuckets(request);
      return {
        status: 'SUCCESS',
        results: buckets.map((bucket) => bucket.name),
      };
    }

    request.maxResults = args.page_size;
    request.autoPaginate = false;
    const [page, nextQuery] = await storage.getBuckets(request);
    const response: GcsListBucketsSuccess = {
      status: 'SUCCESS',
      results: page.map((bucket) => bucket.name),
    };
    const nextPageToken = readNextPageToken(nextQuery);
    if (nextPageToken) {
      response.next_page_token = nextPageToken;
    }
    return response;
  });
}

/**
 * Reads the metadata of one bucket.
 *
 * @param args The bucket to read.
 * @param storageOptions Options for the Cloud Storage client.
 * @return The bucket resource as the API returned it, or the failure the call
 *   raised.
 */
export async function getBucket(
  args: GetBucketArgs,
  storageOptions?: StorageOptions,
): Promise<GcsToolResponse<BucketMetadata>> {
  return toGcsToolResponse(async () => {
    const storage = await getGcsClient(storageOptions);
    const [metadata] = await storage.bucket(args.bucket_name).getMetadata();
    return {status: 'SUCCESS', results: metadata};
  });
}

/**
 * Creates a bucket.
 *
 * @param args The bucket to create.
 * @param storageOptions Options for the Cloud Storage client.
 * @return A message naming the created bucket, or the failure the call raised.
 */
export async function createBucket(
  args: CreateBucketArgs,
  storageOptions?: StorageOptions,
): Promise<GcsToolResponse<string>> {
  return toGcsToolResponse(async () => {
    const storage = await getGcsClient({
      ...storageOptions,
      projectId: args.project_id,
    });
    const request: CreateBucketRequest = {};
    if (args.location !== undefined) {
      request.location = args.location;
    }
    const [bucket] = await storage.createBucket(args.bucket_name, request);
    return {
      status: 'SUCCESS',
      results: `Bucket ${bucket.name} created successfully.`,
    };
  });
}

/**
 * Updates the versioning or the uniform bucket-level access of a bucket.
 *
 * A call that supplies neither field patches nothing and issues no request,
 * which is the condition adk-python guards its patch with.
 *
 * @param args The bucket and the fields to change.
 * @param storageOptions Options for the Cloud Storage client.
 * @return A message naming the bucket, or the failure the call raised.
 */
export async function updateBucket(
  args: UpdateBucketArgs,
  storageOptions?: StorageOptions,
): Promise<GcsToolResponse<string>> {
  return toGcsToolResponse(async () => {
    const patch: BucketMetadata = {};
    if (args.versioning_enabled !== undefined) {
      patch.versioning = {enabled: args.versioning_enabled};
    }
    if (args.uniform_bucket_level_access_enabled !== undefined) {
      patch.iamConfiguration = {
        uniformBucketLevelAccess: {
          enabled: args.uniform_bucket_level_access_enabled,
        },
      };
    }

    if (Object.keys(patch).length > 0) {
      const storage = await getGcsClient(storageOptions);
      await storage.bucket(args.bucket_name).setMetadata(patch);
    }
    return {
      status: 'SUCCESS',
      results: `Bucket ${args.bucket_name} updated successfully.`,
    };
  });
}

/**
 * Deletes a bucket. The deletion is immediate and cannot be undone.
 *
 * @param args The bucket to delete.
 * @param storageOptions Options for the Cloud Storage client.
 * @return A message naming the bucket, or the failure the call raised.
 */
export async function deleteBucket(
  args: DeleteBucketArgs,
  storageOptions?: StorageOptions,
): Promise<GcsToolResponse<string>> {
  return toGcsToolResponse(async () => {
    const storage = await getGcsClient(storageOptions);
    await storage.bucket(args.bucket_name).delete();
    return {
      status: 'SUCCESS',
      results: `Bucket ${args.bucket_name} deleted successfully.`,
    };
  });
}

/**
 * Builds the bucket-administration tools that only read.
 *
 * @param namePrefix Prepended to each tool name, followed by an underscore.
 * @param storageOptions Options for the Cloud Storage client.
 * @return The `get_bucket` and `list_buckets` tools, in the order adk-python
 *   builds them.
 */
export function createGcsAdminReadTools(
  namePrefix: string,
  storageOptions?: StorageOptions,
): BaseTool[] {
  return [
    new FunctionTool({
      name: `${namePrefix}_get_bucket`,
      description: 'Get metadata information about a GCS bucket.',
      parameters: getBucketParameters,
      execute: (input) => getBucket(input, storageOptions),
    }),
    new FunctionTool({
      name: `${namePrefix}_list_buckets`,
      description: 'List GCS bucket names in a Google Cloud project.',
      parameters: listBucketsParameters,
      execute: (input) => listBuckets(input, storageOptions),
    }),
  ];
}

/**
 * Builds the bucket-administration tools that mutate cloud resources.
 *
 * @param namePrefix Prepended to each tool name, followed by an underscore.
 * @param storageOptions Options for the Cloud Storage client.
 * @return The `create_bucket`, `update_bucket` and `delete_bucket` tools, in
 *   the order adk-python builds them.
 */
export function createGcsAdminWriteTools(
  namePrefix: string,
  storageOptions?: StorageOptions,
): BaseTool[] {
  return [
    new FunctionTool({
      name: `${namePrefix}_create_bucket`,
      description: 'Create a new GCS bucket.',
      parameters: createBucketParameters,
      execute: (input) => createBucket(input, storageOptions),
    }),
    new FunctionTool({
      name: `${namePrefix}_update_bucket`,
      description: 'Update properties of a GCS bucket.',
      parameters: updateBucketParameters,
      execute: (input) => updateBucket(input, storageOptions),
    }),
    new FunctionTool({
      name: `${namePrefix}_delete_bucket`,
      description: 'Delete a GCS bucket.',
      parameters: deleteBucketParameters,
      execute: (input) => deleteBucket(input, storageOptions),
    }),
  ];
}
