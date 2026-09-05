/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {ReadonlyContext} from '../../agents/readonly_context.js';
import {experimental} from '../../utils/experimental.js';
import {logger} from '../../utils/logger.js';
import {BaseTool} from '../base_tool.js';
import {BaseToolset, ToolPredicate} from '../base_toolset.js';

import {BigtableCredentialsConfig} from './bigtable_credentials.js';
import {BigtableClientCache} from './client.js';
import {createMetadataTools} from './metadata_tool.js';
import {createQueryTool} from './query_tool.js';
import {BigtableToolSettings} from './settings.js';

/** How a {@link BigtableToolset} is configured. */
export interface BigtableToolsetOptions {
  /**
   * Which of the toolset's tools to expose. Leave unset for all of them; an
   * empty list exposes none, matching adk-python.
   */
  toolFilter?: ToolPredicate | string[];
  /** How the tools authenticate. Defaults to Application Default Credentials. */
  credentialsConfig?: BigtableCredentialsConfig;
  /** The row cap applied to query results. */
  bigtableToolSettings?: BigtableToolSettings;
}

/**
 * Selects the tools a filter admits.
 *
 * adk-python's toolset overrides the base semantics, and this follows it: no
 * filter exposes every tool, and a list is a membership test, so an empty list
 * exposes none. The base class instead reads an empty list as "no filter".
 *
 * @param tools Every tool the toolset builds.
 * @param filter The developer's filter, when they gave one.
 * @param context The context the tools are being listed for.
 * @return The tools the filter admits.
 */
function selectTools(
  tools: BaseTool[],
  filter: ToolPredicate | string[] | undefined,
  context?: ReadonlyContext,
): BaseTool[] {
  if (filter === undefined) {
    return tools;
  }
  if (Array.isArray(filter)) {
    return tools.filter((tool) => filter.includes(tool.name));
  }
  if (context === undefined) {
    logger.warn(
      'BigtableToolset cannot evaluate its tool filter without a context, so ' +
        'every tool is listed.',
    );
    return tools;
  }
  return tools.filter((tool) => filter(tool, context));
}

/**
 * Tools for reading Bigtable metadata and running GoogleSQL against Bigtable.
 *
 * The toolset exposes seven tools: `list_instances`, `get_instance_info`,
 * `list_tables`, `get_table_info`, `list_clusters`, `get_cluster_info` and
 * `execute_sql`.
 *
 * adk-python prefixes these names with `bigtable_`, through a
 * `get_tools_with_prefix()` that adk-js has no counterpart for: nothing here
 * reads `BaseToolset.prefix`, and each sibling toolset prefixes inside its own
 * `getTools()`. Rather than hard-code a prefix that the base class is due to
 * own, this toolset returns the bare names.
 *
 * The `@google-cloud/bigtable` package is an optional peer dependency, loaded
 * on the first call rather than when this module is imported.
 */
@experimental
export class BigtableToolset extends BaseToolset {
  private readonly clients: BigtableClientCache;
  private readonly filter?: ToolPredicate | string[];
  private readonly settings?: BigtableToolSettings;

  constructor(options: BigtableToolsetOptions = {}) {
    super(options.toolFilter ?? []);
    this.clients = new BigtableClientCache(options.credentialsConfig);
    this.filter = options.toolFilter;
    this.settings = options.bigtableToolSettings;
  }

  /**
   * Returns the tools the filter admits.
   *
   * @param context The context the tools are being listed for.
   * @return The selected tools.
   */
  override async getTools(context?: ReadonlyContext): Promise<BaseTool[]> {
    const tools = [
      ...createMetadataTools(this.clients),
      createQueryTool(this.clients, this.settings),
    ];
    return selectTools(tools, this.filter, context);
  }

  /** Closes every Bigtable client the tools opened. */
  override async close(): Promise<void> {
    return this.clients.close();
  }
}
