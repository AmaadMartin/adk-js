/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {ReadonlyContext} from '../../agents/readonly_context.js';
import {ToolPredicate} from '../../tools/base_toolset.js';

/** An MCP server as the API Registry `v1beta` listing returns it. */
export interface ApiRegistryMcpServer {
  name?: string;
  urls?: string[];
}

/** One page of the API Registry `v1beta` MCP server listing. */
export interface ListApiRegistryMcpServersResponse {
  mcpServers?: ApiRegistryMcpServer[];
  nextPageToken?: string;
}

/** Constructor options for {@link ApiRegistry}. */
export interface ApiRegistryOptions {
  /** Google Cloud project that owns the API Registry resources. */
  projectId: string;
  /** API Registry location. Defaults to `global`. */
  location?: string;
  /**
   * Supplies extra headers for the MCP server connection. It is not called for
   * the registry listing request.
   */
  headerProvider?: (
    context?: ReadonlyContext,
  ) => Promise<Record<string, string>> | Record<string, string>;
}

/** Options for {@link ApiRegistry.getToolset}. */
export interface ApiRegistryToolsetOptions {
  /** Selects which of the server's tools the toolset exposes. */
  toolFilter?: ToolPredicate | string[];
  /** Prepended to every tool name the toolset returns. */
  toolNamePrefix?: string;
}
