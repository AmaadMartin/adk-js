/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Storage} from '@google-cloud/storage';

import {ReadonlyContext} from '../../agents/readonly_context.js';
import {BaseTool} from '../../tools/base_tool.js';
import {BaseToolset, ToolPredicate} from '../../tools/base_toolset.js';
import {createGcsClient, GcsClientProvider} from './client.js';
import {GcsCredentialsConfig} from './credentials.js';
import {resolveAccess} from './helpers.js';
import {GCS_TOOL_NAME_PREFIX, GcsToolSettings} from './types.js';

/** Options shared by the GCS toolsets. */
export interface GcsToolsetOptions {
  /** Selects which of the toolset's tools are exposed to the model. */
  toolFilter?: ToolPredicate | string[];
  /** Auth for the Cloud Storage client. Defaults to ADC when omitted. */
  credentialsConfig?: GcsCredentialsConfig;
  /** Capability gating. Defaults to read-only. */
  toolSettings?: GcsToolSettings;
}

/** The tools a GCS toolset may expose, split by the access they need. */
export interface GcsToolFactories {
  read: (getClient: GcsClientProvider) => BaseTool[];
  write: (getClient: GcsClientProvider) => BaseTool[];
}

/**
 * Cap on memoised clients. Project ids reach the provider from
 * model-supplied tool arguments, so the cache is bounded and dropped
 * wholesale once it overflows.
 */
const MAX_CACHED_CLIENTS = 16;

/**
 * Capability gating, client memoisation and tool filtering shared by
 * `GcsToolset` and `GcsAdminToolset`. Which tools each of them may expose is
 * the whole point of keeping them apart, so that stays with the subclass.
 */
export abstract class GcsToolsetBase extends BaseToolset {
  private readonly clients = new Map<string, Storage>();

  /** Memoised per project so repeated tool calls reuse one client. */
  private readonly getClient: GcsClientProvider = (project) => {
    const key = project ?? '';
    const cached = this.clients.get(key);
    if (cached) {
      return cached;
    }

    const client = createGcsClient(this.options.credentialsConfig, project);
    if (this.clients.size >= MAX_CACHED_CLIENTS) {
      this.clients.clear();
    }
    this.clients.set(key, client);
    return client;
  };

  constructor(
    private readonly options: GcsToolsetOptions,
    private readonly toolFactories: GcsToolFactories,
  ) {
    super(options.toolFilter || [], GCS_TOOL_NAME_PREFIX);
  }

  override async getTools(context?: ReadonlyContext): Promise<BaseTool[]> {
    const access = resolveAccess(this.options.toolSettings);
    const tools = [
      ...(access.read ? this.toolFactories.read(this.getClient) : []),
      ...(access.write ? this.toolFactories.write(this.getClient) : []),
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
