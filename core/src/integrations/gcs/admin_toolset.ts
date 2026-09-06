/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {ReadonlyContext} from '../../agents/readonly_context.js';
import {BaseTool} from '../../tools/base_tool.js';
import {BaseToolset, ToolPredicate} from '../../tools/base_toolset.js';
import {experimental} from '../../utils/experimental.js';
import {
  createBucketTool,
  createGcsAdminTool,
  deleteBucketTool,
  GCS_TOOL_NAME_PREFIX,
  getBucketTool,
  listBucketsTool,
  updateBucketTool,
} from './admin_tool.js';
import {
  GcsCredentialsConfig,
  GcsCredentialsManager,
  validateGcsCredentialsConfig,
} from './gcs_credentials.js';
import {
  Capabilities,
  createGcsToolSettings,
  GcsToolSettings,
} from './settings.js';

/** Options for {@link GcsAdminToolset}. */
export interface GcsAdminToolsetOptions {
  /**
   * How the tools authenticate. Required: Cloud Storage rejects an
   * unauthenticated call, so there is no working default.
   */
  credentialsConfig: GcsCredentialsConfig;
  /**
   * Names of the tools to expose, or a predicate over them. Both see the tool
   * under its prefixed name. Omit the option, or pass an empty array, to
   * expose every tool the capabilities allow.
   */
  toolFilter?: ToolPredicate | string[];
  /**
   * Which operations the tools may perform. Defaults to
   * `[Capabilities.READ_ONLY]`, which exposes the two read tools only.
   */
  gcsToolSettings?: GcsToolSettings;
}

/**
 * Tools for administering Cloud Storage buckets.
 *
 * The tool names are:
 *   - `gcs_get_bucket`
 *   - `gcs_list_buckets`
 *   - `gcs_create_bucket`
 *   - `gcs_update_bucket`
 *   - `gcs_delete_bucket`
 *
 * The last three appear only under {@link Capabilities.READ_WRITE}, and each
 * of them asks the user to confirm the call before it runs. Reading and
 * writing the objects inside a bucket is a different concern and is not part
 * of this toolset.
 *
 * Every tool answers with a {@link GcsToolResult} and never throws.
 *
 * Requires the optional peer dependency `@google-cloud/storage`, which is
 * loaded on the first tool call. Install it with
 * `npm install @google-cloud/storage`.
 *
 * A read-only toolset, with one identity for every end user:
 *
 * ```ts
 * const toolset = new GcsAdminToolset({
 *   credentialsConfig: {applicationDefaultCredentials: true},
 * });
 * ```
 *
 * A `toolFilter` given as a string array matches the prefixed name, as it does
 * for `MCPToolset` and `OpenAPIToolset`. adk-python filters on the bare name,
 * so a filter ported from Python needs the prefix added:
 * `tool_filter=['list_buckets']` becomes `toolFilter: ['gcs_list_buckets']`.
 */
@experimental
export class GcsAdminToolset extends BaseToolset {
  private readonly tools: BaseTool[];

  /**
   * @throws Error if `credentialsConfig` names no credential source or more
   *   than one.
   */
  constructor(options: GcsAdminToolsetOptions) {
    super(options.toolFilter ?? [], GCS_TOOL_NAME_PREFIX);
    const credentials = new GcsCredentialsManager(
      validateGcsCredentialsConfig(options.credentialsConfig),
    );
    const {capabilities} = createGcsToolSettings(options.gcsToolSettings);

    const tools: BaseTool[] = [];
    if (
      capabilities.includes(Capabilities.READ_ONLY) ||
      capabilities.includes(Capabilities.READ_WRITE)
    ) {
      tools.push(
        createGcsAdminTool(credentials, getBucketTool),
        createGcsAdminTool(credentials, listBucketsTool),
      );
    }
    if (capabilities.includes(Capabilities.READ_WRITE)) {
      tools.push(
        createGcsAdminTool(credentials, createBucketTool),
        createGcsAdminTool(credentials, updateBucketTool),
        createGcsAdminTool(credentials, deleteBucketTool),
      );
    }
    this.tools = tools;
  }

  override async getTools(context?: ReadonlyContext): Promise<BaseTool[]> {
    return this.tools.filter((tool) => {
      // A name list filters without a context; a predicate cannot.
      if (Array.isArray(this.toolFilter) && this.toolFilter.length > 0) {
        return this.toolFilter.includes(tool.name);
      }
      return context ? this.isToolSelected(tool, context) : true;
    });
  }

  /**
   * A no-op, matching adk-python. Each tool call owns its Cloud Storage client
   * for the length of that call, so the toolset holds no resource to release.
   */
  override async close(): Promise<void> {}
}
