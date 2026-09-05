/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {Storage} from '@google-cloud/storage';

import {ReadonlyContext} from '../../agents/readonly_context.js';
import {BaseTool} from '../../tools/base_tool.js';
import {BaseToolset, ToolPredicate} from '../../tools/base_toolset.js';
import {experimental} from '../../utils/experimental.js';
import {createGcsClient} from './client.js';
import {GcsCredentialsConfig} from './gcs_credentials.js';
import {
  DEFAULT_GCS_CAPABILITIES,
  GcsCapability,
  GcsToolSettings,
} from './settings.js';
import {createGcsReadTools, createGcsWriteTools} from './storage_tool.js';

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
  /** Which operations to expose. Defaults to read-only. */
  toolSettings?: GcsToolSettings;
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
 * const toolset = new GcsToolset({
 *   toolSettings: {capabilities: [GcsCapability.READ_WRITE]},
 * });
 * ```
 *
 * Requires the optional peer dependency `@google-cloud/storage`, which is
 * loaded when the first tool runs.
 */
@experimental
export class GcsToolset extends BaseToolset {
  private readonly capabilities: GcsCapability[];
  private readonly credentialsConfig?: GcsCredentialsConfig;
  private readonly project?: string;
  private clientPromise?: Promise<Storage>;

  constructor(options: GcsToolsetOptions = {}) {
    super(
      options.toolFilter ?? [],
      options.prefix ?? DEFAULT_GCS_TOOL_NAME_PREFIX,
    );
    this.capabilities =
      options.toolSettings?.capabilities ?? DEFAULT_GCS_CAPABILITIES;
    this.credentialsConfig = options.credentialsConfig;
    this.project = options.project;
  }

  /**
   * Returns the tools this toolset's capabilities allow, after the tool
   * filter.
   *
   * @param context Used to evaluate a predicate filter. A predicate filter is
   *   skipped when no context is given.
   * @return The selected tools.
   */
  override async getTools(context?: ReadonlyContext): Promise<BaseTool[]> {
    const tools = this.buildTools();
    if (context) {
      return tools.filter((tool) => this.isToolSelected(tool, context));
    }
    const filter = this.toolFilter;
    if (Array.isArray(filter) && filter.length > 0) {
      return tools.filter((tool) => filter.includes(tool.name));
    }
    return tools;
  }

  /** Releases the memoised client so a later call builds a fresh one. */
  override async close(): Promise<void> {
    this.clientPromise = undefined;
  }

  /** The tools the configured capabilities allow, before filtering. */
  private buildTools(): BaseTool[] {
    const getClient = () => this.getClient();
    const prefix = this.prefix ?? '';
    const tools: BaseTool[] = [];
    if (
      this.capabilities.includes(GcsCapability.READ_ONLY) ||
      this.capabilities.includes(GcsCapability.READ_WRITE)
    ) {
      tools.push(...createGcsReadTools(getClient, prefix));
    }
    if (this.capabilities.includes(GcsCapability.READ_WRITE)) {
      tools.push(...createGcsWriteTools(getClient, prefix));
    }
    return tools;
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
