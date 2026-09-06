/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {Storage} from '@google-cloud/storage';

import {ReadonlyContext} from '../../agents/readonly_context.js';
import {BaseTool} from '../../tools/base_tool.js';
import {BaseToolset, ToolPredicate} from '../../tools/base_toolset.js';
import {FunctionTool} from '../../tools/function_tool.js';
import {experimental} from '../../utils/experimental.js';
import {createGcsClient} from './client.js';
import {GcsCredentialsConfig} from './gcs_credentials.js';
import {GcsCapability} from './settings.js';
import {
  createObject,
  createObjectParameters,
  deleteObjects,
  deleteObjectsParameters,
  errorResult,
  getObjectData,
  getObjectDataParameters,
  getObjectMetadata,
  getObjectMetadataParameters,
  listObjects,
  listObjectsParameters,
  type GcsErrorResult,
} from './storage_tool.js';

/** Joins the toolset prefix to a tool name, or leaves the name bare. */
function prefixed(prefix: string | undefined, name: string): string {
  return prefix ? `${prefix}_${name}` : name;
}

/** The name prefix every Cloud Storage tool carries by default. */
export const DEFAULT_GCS_TOOL_NAME_PREFIX = 'gcs';

/** How to build a {@link GcsToolset}. */
export interface GcsToolsetOptions {
  /**
   * Narrows the exposed tools. A string array matches the prefixed tool name,
   * for example `gcs_list_objects`.
   */
  toolFilter?: ToolPredicate | string[];
  /** How to authenticate. Defaults to Application Default Credentials. */
  credentialsConfig?: GcsCredentialsConfig;
  /**
   * Which operations to expose. Defaults to {@link GcsCapability.READ_ONLY},
   * so a toolset built with no options never exposes a write tool. This
   * default may change in future versions.
   */
  capability?: GcsCapability;
  /** The project id to bill. Left to the SDK's resolution when omitted. */
  project?: string;
  /**
   * Prepended to each tool name. Defaults to
   * {@link DEFAULT_GCS_TOOL_NAME_PREFIX}; pass '' for unprefixed names.
   */
  prefix?: string;
}

/**
 * Exposes Google Cloud Storage objects to a model as tools.
 *
 * The tool names are, with the default prefix:
 *   - gcs_get_object_data
 *   - gcs_get_object_metadata
 *   - gcs_list_objects
 *   - gcs_create_object (read-write only)
 *   - gcs_delete_objects (read-write only)
 *
 * A toolset built with no options is read-only, so it never exposes a tool
 * that changes a bucket.
 *
 * ```ts
 * const toolset = new GcsToolset({capability: GcsCapability.READ_WRITE});
 * ```
 *
 * Requires the optional peer dependency `@google-cloud/storage`, which is
 * loaded when the first tool runs.
 */
@experimental
export class GcsToolset extends BaseToolset {
  private readonly capability: GcsCapability;
  private readonly credentialsConfig?: GcsCredentialsConfig;
  private readonly project?: string;
  private clientPromise?: Promise<Storage>;

  constructor(options: GcsToolsetOptions = {}) {
    super(
      options.toolFilter ?? [],
      options.prefix ?? DEFAULT_GCS_TOOL_NAME_PREFIX,
    );
    this.capability = options.capability ?? GcsCapability.READ_ONLY;
    this.credentialsConfig = options.credentialsConfig;
    this.project = options.project;
  }

  /**
   * Returns the tools this toolset's capability allows, after the tool
   * filter.
   *
   * The names are unprefixed, as `McpToolset` and `OpenApiToolset` leave
   * theirs: `getToolsWithPrefix()` on the base class applies the prefix. A
   * name-list filter still names the prefixed tool, because that is the name
   * the model calls and the name this toolset documents.
   *
   * @param context Used to evaluate a predicate filter. A predicate filter is
   *   skipped when no context is given.
   * @return The selected tools.
   */
  override async getTools(context?: ReadonlyContext): Promise<BaseTool[]> {
    const tools = this.buildTools();
    const filter = this.toolFilter;
    if (typeof filter === 'function') {
      return context ? tools.filter((tool) => filter(tool, context)) : tools;
    }
    if (filter.length > 0) {
      return tools.filter((tool) =>
        filter.includes(prefixed(this.prefix, tool.name)),
      );
    }
    return tools;
  }

  /** Releases the memoised client so a later call builds a fresh one. */
  override async close(): Promise<void> {
    this.clientPromise = undefined;
  }

  /**
   * The tools the configured capability allows, before filtering.
   *
   * The names carry no prefix; `getToolsWithPrefix()` applies it.
   */
  private buildTools(): BaseTool[] {
    const tools: BaseTool[] = [
      new FunctionTool({
        name: 'get_object_data',
        description: 'Get the content/data of a GCS object (blob).',
        parameters: getObjectDataParameters,
        execute: (input) => this.run(input, getObjectData),
      }),
      new FunctionTool({
        name: 'get_object_metadata',
        description: 'Get metadata information about a GCS object (blob).',
        parameters: getObjectMetadataParameters,
        execute: (input) => this.run(input, getObjectMetadata),
      }),
      new FunctionTool({
        name: 'list_objects',
        description: 'List object names in a GCS bucket.',
        parameters: listObjectsParameters,
        execute: (input) => this.run(input, listObjects),
      }),
    ];
    if (this.capability === GcsCapability.READ_WRITE) {
      tools.push(
        new FunctionTool({
          name: 'create_object',
          description:
            'Create a new object (blob) in a GCS bucket from provided data or a local file.',
          parameters: createObjectParameters,
          execute: (input) => this.run(input, createObject),
        }),
        new FunctionTool({
          name: 'delete_objects',
          description:
            'Delete multiple objects (blobs) from a GCS bucket. Note: a GCS ' +
            'bucket must be empty before it can be deleted. Use this tool to ' +
            'delete all objects if you intend to delete the bucket.',
          parameters: deleteObjectsParameters,
          execute: (input) => this.run(input, deleteObjects),
        }),
      );
    }
    return tools;
  }

  /**
   * Runs one operation against this toolset's client, so that a client that
   * cannot be built is reported as an error record like any other failure
   * rather than thrown at the model.
   */
  private async run<A, R>(
    args: A,
    operation: (client: Storage, args: A) => Promise<R>,
  ): Promise<R | GcsErrorResult> {
    let client: Storage;
    try {
      client = await this.getClient();
    } catch (err) {
      return errorResult(err);
    }
    return operation(client, args);
  }

  /**
   * The client every tool of this toolset shares. The credentials are fixed
   * at construction, so one client serves every call and no caller's
   * credentials can reach another's request.
   */
  private getClient(): Promise<Storage> {
    this.clientPromise ??= createGcsClient(
      this.credentialsConfig,
      this.project,
    );
    return this.clientPromise;
  }
}
