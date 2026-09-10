/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {z} from 'zod';

import {ReadonlyContext} from '../../agents/readonly_context.js';
import {BaseTool} from '../../tools/base_tool.js';
import {BaseToolset, ToolPredicate} from '../../tools/base_toolset.js';
import {ToolInputParameters} from '../../tools/function_tool.js';
import {
  GoogleTool,
  GoogleToolExecuteFunction,
} from '../../tools/google_tool.js';
import {experimental} from '../../utils/experimental.js';
import {logger} from '../../utils/logger.js';

import {
  createBucket,
  deleteBucket,
  getBucket,
  listBuckets,
  updateBucket,
} from './admin_tool.js';
import {GcsCredentialsConfig} from './gcs_credentials.js';
import {
  DEFAULT_GCS_TOOL_SETTINGS,
  GcsCapability,
  GcsToolSettings,
} from './settings.js';

/** The prefix the toolset gives every tool name it exposes to the model. */
export const DEFAULT_GCS_TOOL_NAME_PREFIX = 'gcs';

const projectId = z
  .string()
  .describe('The Google Cloud project id that holds the buckets.');
const bucketName = z.string().describe('The name of the Cloud Storage bucket.');

const GetBucketSchema = z.object({bucketName});
const DeleteBucketSchema = z.object({bucketName});
const ListBucketsSchema = z.object({
  projectId,
  pageSize: z
    .number()
    .optional()
    .describe(
      'The maximum number of bucket names in one page. Omit it to list ' +
        'every bucket in the project.',
    ),
  pageToken: z
    .string()
    .optional()
    .describe('The next_page_token of an earlier list_buckets call.'),
});
const CreateBucketSchema = z.object({
  projectId,
  bucketName,
  location: z
    .string()
    .optional()
    .describe('Where the bucket is stored, such as `US` or `europe-west1`.'),
});
const UpdateBucketSchema = z.object({
  bucketName,
  versioningEnabled: z
    .boolean()
    .optional()
    .describe('Whether object versioning is on. Omit it to leave it as it is.'),
  uniformBucketLevelAccessEnabled: z
    .boolean()
    .optional()
    .describe(
      'Whether uniform bucket-level access is on. Omit it to leave it as ' +
        'it is.',
    ),
});

/** Options accepted by {@link GcsAdminToolset}. */
export interface GcsAdminToolsetOptions {
  /**
   * Which tools to expose: a list of unprefixed operation names, or a
   * predicate. An empty list, like an unset filter, exposes all of them.
   */
  toolFilter?: ToolPredicate | string[];
  /** How the tools obtain credentials. Unset means application default. */
  credentialsConfig?: GcsCredentialsConfig;
  /** Which operations the tools may perform. Unset means read-only. */
  gcsToolSettings?: GcsToolSettings;
}

/** One bucket operation: the tool, plus the name a filter matches. */
interface GcsAdminToolEntry {
  operation: string;
  tool: BaseTool;
}

/**
 * Tools for administering Cloud Storage buckets (Experimental).
 *
 * The tools it exposes, once the prefix is applied, are `gcs_get_bucket`,
 * `gcs_list_buckets`, `gcs_create_bucket`, `gcs_update_bucket` and
 * `gcs_delete_bucket`. The last three exist only under
 * {@link GcsCapability.READ_WRITE}, so a read-only toolset never builds them
 * and no filter can reach them.
 *
 * Constructing the toolset performs no I/O: the `@google-cloud/storage`
 * package is loaded, and a client opened, on the first tool call.
 *
 * Please do not use this in production, as it may be deprecated later.
 *
 * @example
 * ```ts
 * const toolset = new GcsAdminToolset({
 *   credentialsConfig: new GcsCredentialsConfig({clientId, clientSecret}),
 *   gcsToolSettings: {capabilities: [GcsCapability.READ_WRITE]},
 * });
 * ```
 */
@experimental
export class GcsAdminToolset extends BaseToolset {
  private readonly credentialsConfig?: GcsCredentialsConfig;
  private readonly toolSettings: GcsToolSettings;

  constructor(options: GcsAdminToolsetOptions = {}) {
    super(options.toolFilter ?? [], DEFAULT_GCS_TOOL_NAME_PREFIX);
    this.credentialsConfig = options.credentialsConfig;
    this.toolSettings = options.gcsToolSettings ?? DEFAULT_GCS_TOOL_SETTINGS;
  }

  /**
   * Returns the tools the capabilities allow and the filter admits, under
   * their prefixed names.
   *
   * The prefix is applied here, as `McpToolset` and `OpenApiToolset` apply
   * theirs, because nothing downstream applies it. The filter still names the
   * unprefixed operation, which is how adk-python's filter reads.
   */
  override async getTools(context?: ReadonlyContext): Promise<BaseTool[]> {
    return this.buildTools()
      .filter((entry) => this.isSelected(entry, context))
      .map((entry) => entry.tool);
  }

  /** Nothing to release: every tool call builds and drops its own client. */
  override async close(): Promise<void> {}

  /**
   * Whether the filter admits an operation.
   *
   * An unset filter and an empty list both admit everything, which is how
   * adk-python and {@link BaseToolset.isToolSelected} read them. A predicate
   * with no context to read admits the tool, as `McpToolset` does.
   */
  private isSelected(
    entry: GcsAdminToolEntry,
    context?: ReadonlyContext,
  ): boolean {
    const filter = this.toolFilter;
    if (Array.isArray(filter)) {
      return filter.length === 0 || filter.includes(entry.operation);
    }
    if (context) {
      return filter(entry.tool, context);
    }
    logger.warn(
      'GcsAdminToolset: a ToolPredicate toolFilter was provided but ' +
        'getTools() was called without a ReadonlyContext. The filter will ' +
        'not be applied.',
    );
    return true;
  }

  /** Builds the tool for one bucket operation. */
  private buildTool<TParameters extends ToolInputParameters>(
    operation: string,
    description: string,
    parameters: TParameters,
    execute: GoogleToolExecuteFunction<TParameters, GcsToolSettings>,
  ): GcsAdminToolEntry {
    return {
      operation,
      tool: new GoogleTool({
        name: `${DEFAULT_GCS_TOOL_NAME_PREFIX}_${operation}`,
        description,
        parameters,
        execute,
        credentialsConfig: this.credentialsConfig,
        toolSettings: this.toolSettings,
      }),
    };
  }

  /** Builds one tool per allowed bucket operation, in a stable order. */
  private buildTools(): GcsAdminToolEntry[] {
    const {capabilities} = this.toolSettings;
    const canRead =
      capabilities.includes(GcsCapability.READ_ONLY) ||
      capabilities.includes(GcsCapability.READ_WRITE);
    const canWrite = capabilities.includes(GcsCapability.READ_WRITE);

    const entries: GcsAdminToolEntry[] = [];
    if (canRead) {
      entries.push(
        this.buildTool(
          'get_bucket',
          'Get the metadata of a Cloud Storage bucket.',
          GetBucketSchema,
          (input, _toolContext, google) =>
            getBucket({
              bucketName: input.bucketName,
              credentials: google?.credentials,
            }),
        ),
        this.buildTool(
          'list_buckets',
          'List the Cloud Storage bucket names in a Google Cloud project.',
          ListBucketsSchema,
          (input, _toolContext, google) =>
            listBuckets({
              projectId: input.projectId,
              pageSize: input.pageSize,
              pageToken: input.pageToken,
              credentials: google?.credentials,
            }),
        ),
      );
    }
    if (canWrite) {
      entries.push(
        this.buildTool(
          'create_bucket',
          'Create a Cloud Storage bucket.',
          CreateBucketSchema,
          (input, _toolContext, google) =>
            createBucket({
              projectId: input.projectId,
              bucketName: input.bucketName,
              location: input.location,
              credentials: google?.credentials,
            }),
        ),
        this.buildTool(
          'update_bucket',
          'Turn object versioning or uniform bucket-level access on or off ' +
            'for a Cloud Storage bucket.',
          UpdateBucketSchema,
          (input, _toolContext, google) =>
            updateBucket({
              bucketName: input.bucketName,
              versioningEnabled: input.versioningEnabled,
              uniformBucketLevelAccessEnabled:
                input.uniformBucketLevelAccessEnabled,
              credentials: google?.credentials,
            }),
        ),
        this.buildTool(
          'delete_bucket',
          'Delete a Cloud Storage bucket. This cannot be undone.',
          DeleteBucketSchema,
          (input, _toolContext, google) =>
            deleteBucket({
              bucketName: input.bucketName,
              credentials: google?.credentials,
            }),
        ),
      );
    }
    return entries;
  }
}
