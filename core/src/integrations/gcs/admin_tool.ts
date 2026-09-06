/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {BucketMetadata, Storage} from '@google-cloud/storage';
import {z} from 'zod';
import {FunctionTool, ToolExecuteArgument} from '../../tools/function_tool.js';
import {createStorageClient} from './client.js';
import {GcsCredentialsManager} from './gcs_credentials.js';
import {GcsToolResult, runGcsTool} from './tool_result.js';

/** Prefix prepended to every tool name in the Cloud Storage toolsets. */
export const GCS_TOOL_NAME_PREFIX = 'gcs';

/** The schema of any Cloud Storage admin tool. */
type AdminParams = z.ZodObject<z.ZodRawShape>;

/** One Cloud Storage admin tool. */
export interface GcsAdminToolDefinition<TParams extends AdminParams> {
  /** Tool name without the `gcs_` prefix. */
  name: string;
  description: string;
  parameters: TParams;
  /** Set on the tools that create, change or destroy a bucket. */
  requireConfirmation?: boolean;
  /**
   * Reads the project the client is billed to, for the tools that name one.
   * A tool that addresses a bucket directly needs no project.
   */
  projectId?(args: ToolExecuteArgument<TParams>): string;
  run(storage: Storage, args: ToolExecuteArgument<TParams>): Promise<object>;
}

/**
 * Wraps one Cloud Storage administration call as a prefixed tool that never
 * throws.
 *
 * Resolving the credentials, loading the optional peer dependency and the call
 * itself are all inside the same guard, so every failure reaches the model as
 * an `ERROR` result.
 *
 * @param credentials Resolves the calling end user's credentials.
 * @param definition What the tool declares and what it calls.
 * @return The tool, named `gcs_<definition.name>`.
 */
export function createGcsAdminTool<TParams extends AdminParams>(
  credentials: GcsCredentialsManager,
  definition: GcsAdminToolDefinition<TParams>,
): FunctionTool<TParams> {
  const name = `${GCS_TOOL_NAME_PREFIX}_${definition.name}`;
  return new FunctionTool({
    name,
    description: definition.description,
    parameters: definition.parameters,
    requireConfirmation: definition.requireConfirmation ?? false,
    execute(args, toolContext): Promise<GcsToolResult | string> {
      return runGcsTool(name, async () => {
        const resolved = await credentials.getCredentials(toolContext);
        if (!resolved) {
          return (
            'User authorization is required to access Google services for' +
            ` ${name}. Please complete the authorization flow.`
          );
        }
        const storage = await createStorageClient(
          resolved,
          definition.projectId?.(args),
        );
        return definition.run(storage, args);
      });
    },
  });
}

/**
 * The page token `getBuckets` reports for the next page, if there is one.
 *
 * The client types the query it returns as `{}`, so the token is read back
 * defensively.
 */
function readPageToken(nextQuery: unknown): string | undefined {
  if (
    typeof nextQuery !== 'object' ||
    nextQuery === null ||
    !('pageToken' in nextQuery)
  ) {
    return undefined;
  }
  const token: unknown = nextQuery.pageToken;
  return typeof token === 'string' && token !== '' ? token : undefined;
}

const projectIdField = z
  .string()
  .describe('The Google Cloud project id that owns the buckets.');

const bucketNameField = z.string().describe('The name of the bucket.');

const listBucketsParams = z.object({
  project_id: projectIdField,
  page_size: z
    .int()
    .positive()
    .optional()
    .describe(
      'The maximum number of buckets to return in a single page. Omit to' +
        ' list every bucket in the project.',
    ),
  page_token: z
    .string()
    .optional()
    .describe('A page token received from a previous list_buckets call.'),
});

const bucketParams = z.object({bucket_name: bucketNameField});

const createBucketParams = z.object({
  project_id: projectIdField,
  bucket_name: bucketNameField,
  location: z
    .string()
    .optional()
    .describe('The location of the bucket, e.g. US or europe-west1.'),
});

const updateBucketParams = z.object({
  bucket_name: bucketNameField,
  versioning_enabled: z
    .boolean()
    .optional()
    .describe('Whether to keep noncurrent versions of the bucket objects.'),
  uniform_bucket_level_access_enabled: z
    .boolean()
    .optional()
    .describe(
      'Whether to enable uniform bucket-level access, which turns off' +
        ' per-object access control lists.',
    ),
});

export const listBucketsTool: GcsAdminToolDefinition<typeof listBucketsParams> =
  {
    name: 'list_buckets',
    description: 'List the bucket names in a Google Cloud project.',
    parameters: listBucketsParams,
    projectId: (args) => args.project_id,
    async run(storage, args) {
      if (args.page_size === undefined) {
        const [buckets] = await storage.getBuckets();
        return {results: buckets.map((bucket) => bucket.name)};
      }
      const [buckets, nextQuery] = await storage.getBuckets({
        maxResults: args.page_size,
        ...(args.page_token === undefined ? {} : {pageToken: args.page_token}),
        autoPaginate: false,
      });
      const results = buckets.map((bucket) => bucket.name);
      const nextPageToken = readPageToken(nextQuery);
      return nextPageToken === undefined
        ? {results}
        : {results, next_page_token: nextPageToken};
    },
  };

export const getBucketTool: GcsAdminToolDefinition<typeof bucketParams> = {
  name: 'get_bucket',
  description: 'Get the metadata of one bucket.',
  parameters: bucketParams,
  async run(storage, args) {
    const [metadata] = await storage.bucket(args.bucket_name).getMetadata();
    return {results: metadata};
  },
};

export const createBucketTool: GcsAdminToolDefinition<
  typeof createBucketParams
> = {
  name: 'create_bucket',
  description:
    'Create a bucket. The bucket and everything stored in it is billed to' +
    ' the project until the bucket is deleted.',
  parameters: createBucketParams,
  requireConfirmation: true,
  projectId: (args) => args.project_id,
  async run(storage, args) {
    const [bucket] = await storage.createBucket(
      args.bucket_name,
      args.location === undefined ? {} : {location: args.location},
    );
    return {results: `Bucket ${bucket.name} created successfully.`};
  },
};

export const updateBucketTool: GcsAdminToolDefinition<
  typeof updateBucketParams
> = {
  name: 'update_bucket',
  description:
    'Update the versioning and uniform bucket-level access settings of a' +
    ' bucket. A setting that is not named keeps its current value.',
  parameters: updateBucketParams,
  requireConfirmation: true,
  async run(storage, args) {
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
    // With neither setting named there is nothing to send, and adk-python
    // reports success without calling the API.
    if (Object.keys(patch).length > 0) {
      await storage.bucket(args.bucket_name).setMetadata(patch);
    }
    return {results: `Bucket ${args.bucket_name} updated successfully.`};
  },
};

export const deleteBucketTool: GcsAdminToolDefinition<typeof bucketParams> = {
  name: 'delete_bucket',
  description:
    'Delete a bucket. The bucket must already be empty, and deleting it' +
    ' cannot be undone.',
  parameters: bucketParams,
  requireConfirmation: true,
  async run(storage, args) {
    await storage.bucket(args.bucket_name).delete();
    return {results: `Bucket ${args.bucket_name} deleted successfully.`};
  },
};
