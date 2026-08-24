/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {ReadonlyContext} from '../../agents/readonly_context.js';
import {experimental} from '../../utils/experimental.js';
import {BaseTool} from '../base_tool.js';
import {BaseToolset, ToolPredicate} from '../base_toolset.js';
import {
  createSpannerAdminTools,
  SPANNER_TOOL_NAME_PREFIX,
} from './admin_tool.js';
import {
  SpannerAdminClientOptions,
  SpannerAdminClientProvider,
} from './client.js';

/** Options for {@link SpannerAdminToolset}. */
export interface SpannerAdminToolsetOptions {
  /**
   * Names of the tools to expose, or a predicate over them. Names include the
   * `spanner_` prefix.
   */
  toolFilter?: ToolPredicate | string[];
  /**
   * Options for the Spanner Admin API clients: `credentials`, `keyFilename`,
   * `authClient`, `projectId`. Both clients use Application Default
   * Credentials scoped to the Spanner admin scope unless this overrides it.
   */
  clientOptions?: SpannerAdminClientOptions;
}

/**
 * Tools for Spanner administration: instances, instance configs and databases.
 *
 * The tool names are:
 *   - `spanner_list_instances`
 *   - `spanner_get_instance`
 *   - `spanner_list_instance_configs`
 *   - `spanner_get_instance_config`
 *   - `spanner_create_instance`
 *   - `spanner_list_databases`
 *   - `spanner_create_database`
 *
 * `spanner_create_instance` and `spanner_create_database` create billable
 * Google Cloud resources.
 *
 * Requires the optional peer dependency `@google-cloud/spanner-api`, which is
 * loaded on the first tool call.
 *
 * A `toolFilter` given as a string array matches the prefixed name, as it does
 * for `MCPToolset` and `OpenAPIToolset`. adk-python filters on the bare name,
 * so a filter ported from Python needs the prefix added:
 *
 * ```ts
 * const toolset = new SpannerAdminToolset({
 *   toolFilter: ['spanner_list_instances', 'spanner_list_databases'],
 * });
 * ```
 */
@experimental
export class SpannerAdminToolset extends BaseToolset {
  private readonly provider: SpannerAdminClientProvider;
  private readonly tools: BaseTool[];

  constructor(options: SpannerAdminToolsetOptions = {}) {
    super(options.toolFilter ?? [], SPANNER_TOOL_NAME_PREFIX);
    this.provider = new SpannerAdminClientProvider(options.clientOptions);
    this.tools = createSpannerAdminTools(this.provider);
  }

  override async getTools(context?: ReadonlyContext): Promise<BaseTool[]> {
    return this.tools.filter((tool) => {
      if (Array.isArray(this.toolFilter) && this.toolFilter.length > 0) {
        return this.toolFilter.includes(tool.name);
      }
      if (context) {
        return this.isToolSelected(tool, context);
      }
      return true;
    });
  }

  /** Releases the Admin API clients, if any tool ever created them. */
  override async close(): Promise<void> {
    return this.provider.close();
  }
}
