/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {ReadonlyContext} from '../../agents/readonly_context.js';
import {BaseTool} from '../../tools/base_tool.js';
import {BaseToolset, ToolPredicate} from '../../tools/base_toolset.js';
import {experimental} from '../../utils/experimental.js';
import {GcsClientProvider, getGcsClient} from './client.js';
import {GCSCredentialsConfig} from './gcs_credentials.js';
import {resolveAccess} from './helpers.js';
import {
  createStorageReadTools,
  createStorageWriteTools,
} from './storage_tool.js';
import {DEFAULT_GCS_TOOL_NAME_PREFIX, GCSToolSettings} from './types.js';

/** Options for {@link GCSToolset}. */
export interface GCSToolsetOptions {
  /** Selects which of the toolset's tools are exposed to the model. */
  toolFilter?: ToolPredicate | string[];
  /** Auth for the Cloud Storage client. Defaults to ADC when omitted. */
  credentialsConfig?: GCSCredentialsConfig;
  /** Capability gating. Defaults to read-only. */
  toolSettings?: GCSToolSettings;
}

/**
 * Toolset for interacting with objects in Cloud Storage (Experimental).
 *
 * The tool names are `gcs_get_bucket`, `gcs_get_object_data`,
 * `gcs_get_object_metadata`, `gcs_list_objects` and, with the
 * `GCSCapability.READ_WRITE` capability, `gcs_create_object` and
 * `gcs_delete_objects`.
 *
 * Bucket administration lives in {@link GCSAdminToolset} so that an agent can
 * be granted object access without being granted the ability to delete a
 * bucket.
 */
@experimental
export class GCSToolset extends BaseToolset {
  private readonly getClient: GcsClientProvider;
  private readonly toolSettings?: GCSToolSettings;

  constructor(options: GCSToolsetOptions = {}) {
    super(options.toolFilter || [], DEFAULT_GCS_TOOL_NAME_PREFIX);
    this.toolSettings = options.toolSettings;
    this.getClient = (project) =>
      getGcsClient(options.credentialsConfig, project);
  }

  override async getTools(context?: ReadonlyContext): Promise<BaseTool[]> {
    const access = resolveAccess(this.toolSettings);
    const tools = [
      ...(access.read ? createStorageReadTools(this.getClient) : []),
      ...(access.write ? createStorageWriteTools(this.getClient) : []),
    ];

    return tools.filter((tool) => {
      if (Array.isArray(this.toolFilter) && this.toolFilter.length > 0) {
        return this.toolFilter.includes(tool.name);
      }
      return context ? this.isToolSelected(tool, context) : true;
    });
  }

  override async close(): Promise<void> {
    // The Cloud Storage client holds no persistent connection to release.
  }
}
