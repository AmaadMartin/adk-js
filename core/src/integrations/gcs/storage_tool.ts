/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Storage} from '@google-cloud/storage';
import {z} from 'zod';

import {BaseTool} from '../../tools/base_tool.js';
import {FunctionTool} from '../../tools/function_tool.js';
import {GcsClientProvider} from './client.js';
import {
  decodeObjectData,
  isNotFoundError,
  nextPageToken,
  toErrorResult,
} from './helpers.js';
import {
  DEFAULT_GCS_TOOL_NAME_PREFIX,
  GcsToolResult,
  GcsToolStatus,
} from './types.js';

const bucketNameSchema = z.string().describe('The name of the GCS bucket.');
const objectNameSchema = z.string().describe('The name of the GCS object.');
const generationSchema = z
  .number()
  .int()
  .optional()
  .describe('If present, selects a specific generation of this object.');
const pageSizeSchema = z
  .number()
  .int()
  .min(1)
  .optional()
  .describe('The maximum number of objects to return in a single page.');
const pageTokenSchema = z
  .string()
  .optional()
  .describe('A page token, received from a previous list_objects call.');

function objectErrorResult(
  error: unknown,
  bucketName: string,
  objectName: string,
): GcsToolResult {
  return isNotFoundError(error)
    ? {
        status: GcsToolStatus.ERROR,
        error_details: `Object ${objectName} not found in bucket ${bucketName}`,
      }
    : toErrorResult(error);
}

async function getBucket(
  storage: Storage,
  args: {bucket_name: string},
): Promise<GcsToolResult> {
  try {
    const [metadata] = await storage.bucket(args.bucket_name).getMetadata();
    return {status: GcsToolStatus.SUCCESS, results: metadata};
  } catch (error: unknown) {
    return toErrorResult(error);
  }
}

async function listObjects(
  storage: Storage,
  args: {
    bucket_name: string;
    prefix?: string;
    page_size?: number;
    page_token?: string;
  },
): Promise<GcsToolResult> {
  try {
    const [files, nextQuery] = await storage.bucket(args.bucket_name).getFiles({
      ...(args.prefix !== undefined ? {prefix: args.prefix} : {}),
      ...(args.page_size !== undefined
        ? {maxResults: args.page_size, autoPaginate: false}
        : {}),
      ...(args.page_token !== undefined ? {pageToken: args.page_token} : {}),
    });

    const result: GcsToolResult = {
      status: GcsToolStatus.SUCCESS,
      results: files.map((file) => file.name),
    };
    const token =
      args.page_size !== undefined ? nextPageToken(nextQuery) : undefined;
    if (token) {
      result.next_page_token = token;
    }
    return result;
  } catch (error: unknown) {
    return toErrorResult(error);
  }
}

async function getObjectMetadata(
  storage: Storage,
  args: {bucket_name: string; object_name: string; generation?: number},
): Promise<GcsToolResult> {
  try {
    const file = storage
      .bucket(args.bucket_name)
      .file(
        args.object_name,
        args.generation !== undefined
          ? {generation: args.generation}
          : undefined,
      );
    const [metadata] = await file.getMetadata();
    return {status: GcsToolStatus.SUCCESS, results: metadata};
  } catch (error: unknown) {
    return objectErrorResult(error, args.bucket_name, args.object_name);
  }
}

async function getObjectData(
  storage: Storage,
  args: {
    bucket_name: string;
    object_name: string;
    generation?: number;
    destination_file_path?: string;
  },
): Promise<GcsToolResult> {
  try {
    const file = storage
      .bucket(args.bucket_name)
      .file(
        args.object_name,
        args.generation !== undefined
          ? {generation: args.generation}
          : undefined,
      );

    if (args.destination_file_path !== undefined) {
      await file.download({destination: args.destination_file_path});
      return {
        status: GcsToolStatus.SUCCESS,
        results: `Object ${args.object_name} downloaded successfully to ${args.destination_file_path}.`,
      };
    }

    const [bytes] = await file.download();
    const {content, encoding} = decodeObjectData(bytes);
    return {status: GcsToolStatus.SUCCESS, results: content, encoding};
  } catch (error: unknown) {
    return objectErrorResult(error, args.bucket_name, args.object_name);
  }
}

async function createObject(
  storage: Storage,
  args: {
    bucket_name: string;
    object_name: string;
    data?: string;
    source_file_path?: string;
  },
): Promise<GcsToolResult> {
  try {
    const bucket = storage.bucket(args.bucket_name);
    if (args.source_file_path !== undefined) {
      await bucket.upload(args.source_file_path, {
        destination: args.object_name,
      });
    } else if (args.data !== undefined) {
      await bucket.file(args.object_name).save(args.data);
    } else {
      return {
        status: GcsToolStatus.ERROR,
        error_details: "Either 'data' or 'source_file_path' must be provided.",
      };
    }

    return {
      status: GcsToolStatus.SUCCESS,
      results: `Object ${args.object_name} created successfully in bucket ${args.bucket_name}.`,
    };
  } catch (error: unknown) {
    return toErrorResult(error);
  }
}

async function deleteObjects(
  storage: Storage,
  args: {bucket_name: string; object_names: string[]},
): Promise<GcsToolResult> {
  try {
    const bucket = storage.bucket(args.bucket_name);
    await Promise.all(
      args.object_names.map((name) => bucket.file(name).delete()),
    );
    return {
      status: GcsToolStatus.SUCCESS,
      results: `Objects [${args.object_names.join(', ')}] deleted successfully from bucket ${args.bucket_name}.`,
    };
  } catch (error: unknown) {
    return toErrorResult(error);
  }
}

/** Object tools that only read from Cloud Storage. */
export function createStorageReadTools(
  getClient: GcsClientProvider,
): BaseTool[] {
  return [
    new FunctionTool({
      name: `${DEFAULT_GCS_TOOL_NAME_PREFIX}_get_bucket`,
      description: 'Get metadata information about a GCS bucket.',
      parameters: z.object({bucket_name: bucketNameSchema}),
      execute: (args) => getBucket(getClient(), args),
    }),
    new FunctionTool({
      name: `${DEFAULT_GCS_TOOL_NAME_PREFIX}_get_object_data`,
      description: 'Get the content/data of a GCS object (blob).',
      parameters: z.object({
        bucket_name: bucketNameSchema,
        object_name: objectNameSchema,
        generation: generationSchema,
        destination_file_path: z
          .string()
          .optional()
          .describe(
            'If present, the downloaded object is written to this path on the local filesystem of the machine running the agent, instead of being returned.',
          ),
      }),
      execute: (args) => getObjectData(getClient(), args),
    }),
    new FunctionTool({
      name: `${DEFAULT_GCS_TOOL_NAME_PREFIX}_get_object_metadata`,
      description: 'Get metadata information about a GCS object (blob).',
      parameters: z.object({
        bucket_name: bucketNameSchema,
        object_name: objectNameSchema,
        generation: generationSchema,
      }),
      execute: (args) => getObjectMetadata(getClient(), args),
    }),
    new FunctionTool({
      name: `${DEFAULT_GCS_TOOL_NAME_PREFIX}_list_objects`,
      description: 'List object names in a GCS bucket.',
      parameters: z.object({
        bucket_name: bucketNameSchema,
        prefix: z
          .string()
          .optional()
          .describe(
            'Filter results to objects whose names begin with this prefix.',
          ),
        page_size: pageSizeSchema,
        page_token: pageTokenSchema,
      }),
      execute: (args) => listObjects(getClient(), args),
    }),
  ];
}

/** Object tools that mutate Cloud Storage. */
export function createStorageWriteTools(
  getClient: GcsClientProvider,
): BaseTool[] {
  return [
    new FunctionTool({
      name: `${DEFAULT_GCS_TOOL_NAME_PREFIX}_create_object`,
      description:
        'Create a new object (blob) in a GCS bucket from provided data or a local file.',
      parameters: z.object({
        bucket_name: bucketNameSchema,
        object_name: z
          .string()
          .describe('The name of the GCS object to create.'),
        data: z
          .string()
          .optional()
          .describe('The content to write to the object.'),
        source_file_path: z
          .string()
          .optional()
          .describe(
            'The path of the file to upload, read from the local filesystem of the machine running the agent.',
          ),
      }),
      execute: (args) => createObject(getClient(), args),
    }),
    new FunctionTool({
      name: `${DEFAULT_GCS_TOOL_NAME_PREFIX}_delete_objects`,
      description:
        'Delete multiple objects (blobs) from a GCS bucket. Note: a GCS bucket must be empty before it can be deleted. Use this tool to delete all objects if you intend to delete the bucket.',
      parameters: z.object({
        bucket_name: bucketNameSchema,
        object_names: z
          .array(z.string())
          .describe('List of object names to delete.'),
      }),
      execute: (args) => deleteObjects(getClient(), args),
    }),
  ];
}
