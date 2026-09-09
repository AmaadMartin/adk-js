/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {StorageOptions} from '@google-cloud/storage';
import {ReadonlyContext} from '../../agents/readonly_context.js';
import {BaseTool} from '../../tools/base_tool.js';
import {BaseToolset, ToolPredicate} from '../../tools/base_toolset.js';
import {experimental} from '../../utils/experimental.js';
import {logger} from '../../utils/logger.js';
import {
  createGcsAdminReadTools,
  createGcsAdminWriteTools,
} from './admin_tool.js';
import {
  DEFAULT_GCS_TOOL_SETTINGS,
  GcsCapability,
  GcsToolSettings,
} from './settings.js';

/** Options for {@link GcsAdminToolset}. */
export interface GcsAdminToolsetOptions {
  /**
   * Selects which of the tools to expose. Both a string array and a predicate
   * match the tool as the model sees it, so a name carries the `gcs_` prefix.
   */
  toolFilter?: ToolPredicate | string[];
  /** Which operations the tools may perform. Read-only by default. */
  settings?: GcsToolSettings;
  /**
   * Passed to the Cloud Storage client. Omit it to use Application Default
   * Credentials.
   */
  storageOptions?: StorageOptions;
}

/**
 * Cloud Storage bucket administration, as tools an agent can call.
 *
 * The toolset exposes `gcs_get_bucket` and `gcs_list_buckets` by default. The
 * three tools that change a bucket — `gcs_create_bucket`, `gcs_update_bucket`
 * and `gcs_delete_bucket` — are built only for a toolset whose settings carry
 * {@link GcsCapability.READ_WRITE}. A read-only toolset does not construct
 * them at all, so no filter can bring them back.
 *
 * `gcs_delete_bucket` deletes a bucket permanently. Give a toolset the write
 * capability only when the agent is meant to have it.
 *
 * The tools take their credentials from `storageOptions`, and default to
 * Application Default Credentials. adk-python's end-user OAuth flow has no
 * counterpart here.
 *
 * ```ts
 * import {GcsAdminToolset, GcsCapability, LlmAgent} from '@google/adk';
 *
 * const agent = new LlmAgent({
 *   name: 'storage_admin',
 *   model: 'gemini-2.5-flash',
 *   tools: [
 *     new GcsAdminToolset({
 *       settings: {capabilities: [GcsCapability.READ_WRITE]},
 *       storageOptions: {projectId: 'my-project'},
 *     }),
 *   ],
 * });
 * ```
 */
@experimental
export class GcsAdminToolset extends BaseToolset {
  private readonly settings: GcsToolSettings;
  private readonly storageOptions?: StorageOptions;

  /**
   * @param options The toolset options. Every field is optional.
   */
  constructor(options: GcsAdminToolsetOptions = {}) {
    super(options.toolFilter ?? []);
    this.settings = options.settings ?? DEFAULT_GCS_TOOL_SETTINGS;
    this.storageOptions = options.storageOptions;
  }

  /**
   * Builds the tools the settings allow and applies the filter to them.
   *
   * @param context Context a predicate filter needs. A predicate filter
   *   without a context is skipped, and the toolset logs a warning.
   * @return The tools to expose to the model.
   */
  override async getTools(context?: ReadonlyContext): Promise<BaseTool[]> {
    const {capabilities} = this.settings;
    const tools: BaseTool[] = [];
    if (
      capabilities.includes(GcsCapability.READ_ONLY) ||
      capabilities.includes(GcsCapability.READ_WRITE)
    ) {
      tools.push(...createGcsAdminReadTools(this.storageOptions));
    }
    if (capabilities.includes(GcsCapability.READ_WRITE)) {
      tools.push(...createGcsAdminWriteTools(this.storageOptions));
    }

    const filter = this.toolFilter;
    if (typeof filter === 'function') {
      if (!context) {
        logger.warn(
          'GcsAdminToolset: a ToolPredicate toolFilter was provided but ' +
            'getTools() was called without a ReadonlyContext. The filter ' +
            'will not be applied.',
        );
        return tools;
      }
      return tools.filter((tool) => filter(tool, context));
    }
    if (filter.length === 0) {
      return tools;
    }
    return tools.filter((tool) => filter.includes(tool.name));
  }

  /**
   * Closes the toolset. Each tool call builds and drops its own client, so
   * there is nothing to release.
   */
  override async close(): Promise<void> {}
}
