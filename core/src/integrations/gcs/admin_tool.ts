/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {BucketMetadata, Storage} from '@google-cloud/storage';
import {z} from 'zod';

import {BaseTool} from '../../tools/base_tool.js';
import {FunctionTool} from '../../tools/function_tool.js';
import {GcsClientProvider} from './client.js';
import {listResult, pageOptions, toErrorResult} from './helpers.js';
import {GCS_TOOL_NAME_PREFIX, GcsToolResult, GcsToolStatus} from './types.js';

const projectIdSchema = z.string().describe('The Google Cloud project id.');

async function listBuckets(
  storage: Storage,
  args: {project_id: string; page_size?: number; page_token?: string},
): Promise<GcsToolResult> {
  try {
    const [buckets, nextQuery] = await storage.getBuckets({
      project: args.project_id,
      ...pageOptions(args.page_size, args.page_token),
    });
    return listResult(
      buckets.map((bucket) => bucket.name),
      nextQuery,
      args.page_size,
    );
  } catch (error: unknown) {
    return toErrorResult(error);
  }
}

async function createBucket(
  storage: Storage,
  args: {bucket_name: string; location?: string},
): Promise<GcsToolResult> {
  try {
    const [bucket] = await storage.createBucket(
      args.bucket_name,
      args.location !== undefined ? {location: args.location} : {},
    );
    return {
      status: GcsToolStatus.SUCCESS,
      results: `Bucket ${bucket.name} created successfully.`,
    };
  } catch (error: unknown) {
    return toErrorResult(error);
  }
}

async function updateBucket(
  storage: Storage,
  args: {
    bucket_name: string;
    versioning_enabled?: boolean;
    uniform_bucket_level_access_enabled?: boolean;
  },
): Promise<GcsToolResult> {
  try {
    const metadata: BucketMetadata = {
      ...(args.versioning_enabled !== undefined
        ? {versioning: {enabled: args.versioning_enabled}}
        : {}),
      ...(args.uniform_bucket_level_access_enabled !== undefined
        ? {
            iamConfiguration: {
              uniformBucketLevelAccess: {
                enabled: args.uniform_bucket_level_access_enabled,
              },
            },
          }
        : {}),
    };
    if (Object.keys(metadata).length > 0) {
      await storage.bucket(args.bucket_name).setMetadata(metadata);
    }
    return {
      status: GcsToolStatus.SUCCESS,
      results: `Bucket ${args.bucket_name} updated successfully.`,
    };
  } catch (error: unknown) {
    return toErrorResult(error);
  }
}

async function deleteBucket(
  storage: Storage,
  args: {bucket_name: string},
): Promise<GcsToolResult> {
  try {
    await storage.bucket(args.bucket_name).delete();
    return {
      status: GcsToolStatus.SUCCESS,
      results: `Bucket ${args.bucket_name} deleted successfully.`,
    };
  } catch (error: unknown) {
    return toErrorResult(error);
  }
}

/** Bucket administration tools that only read from Cloud Storage. */
export function createAdminReadTools(getClient: GcsClientProvider): BaseTool[] {
  return [
    new FunctionTool({
      name: `${GCS_TOOL_NAME_PREFIX}_list_buckets`,
      description: 'List GCS bucket names in a Google Cloud project.',
      parameters: z.object({
        project_id: projectIdSchema,
        page_size: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe(
            'The maximum number of buckets to return in a single page.',
          ),
        page_token: z
          .string()
          .optional()
          .describe(
            'A page token, received from a previous list_buckets call.',
          ),
      }),
      execute: (args) => listBuckets(getClient(args.project_id), args),
    }),
  ];
}

/** Bucket administration tools that mutate Cloud Storage. */
export function createAdminWriteTools(
  getClient: GcsClientProvider,
): BaseTool[] {
  return [
    new FunctionTool({
      name: `${GCS_TOOL_NAME_PREFIX}_create_bucket`,
      description: 'Create a new GCS bucket.',
      parameters: z.object({
        project_id: projectIdSchema,
        bucket_name: z
          .string()
          .describe('The name of the GCS bucket to create.'),
        location: z.string().optional().describe('The location of the bucket.'),
      }),
      execute: (args) => createBucket(getClient(args.project_id), args),
    }),
    new FunctionTool({
      name: `${GCS_TOOL_NAME_PREFIX}_update_bucket`,
      description: 'Update properties of a GCS bucket.',
      parameters: z.object({
        bucket_name: z
          .string()
          .describe('The name of the GCS bucket to update.'),
        versioning_enabled: z
          .boolean()
          .optional()
          .describe('Whether to enable versioning for the bucket.'),
        uniform_bucket_level_access_enabled: z
          .boolean()
          .optional()
          .describe('Whether to enable uniform bucket-level access.'),
      }),
      execute: (args) => updateBucket(getClient(), args),
    }),
    new FunctionTool({
      name: `${GCS_TOOL_NAME_PREFIX}_delete_bucket`,
      description: 'Delete a GCS bucket.',
      parameters: z.object({
        bucket_name: z
          .string()
          .describe('The name of the GCS bucket to delete.'),
      }),
      execute: (args) => deleteBucket(getClient(), args),
    }),
  ];
}
