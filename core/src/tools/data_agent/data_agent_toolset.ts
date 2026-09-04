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
  DataAgentToolConfig,
  ResolvedDataAgentToolConfig,
  resolveDataAgentToolConfig,
} from './config.js';
import {
  DataAgentCredentialsConfig,
  DataAgentCredentialsManager,
  validateDataAgentCredentialsConfig,
} from './credentials.js';
import {buildDataAgentTools} from './data_agent_tool.js';

/** Options for {@link DataAgentToolset}. */
export interface DataAgentToolsetOptions {
  /**
   * Names of the tools to expose, or a predicate over them. An empty array
   * exposes nothing; omit the option to expose everything.
   */
  toolFilter?: ToolPredicate | string[];
  /**
   * How the tools authenticate. Omit it to send the requests with no
   * credential, which the API accepts only for an endpoint that needs none.
   */
  credentialsConfig?: DataAgentCredentialsConfig;
  /** Where the data agents live, and what the tools may do. */
  dataAgentToolConfig?: DataAgentToolConfig;
}

/**
 * Tools for the Conversational Analytics API's data agents.
 *
 * Three tools are always exposed:
 *   - `list_accessible_data_agents`
 *   - `get_data_agent_info`
 *   - `ask_data_agent`
 *
 * Three more appear only when `enableDataAgentModification` is set, because
 * they change Google Cloud resources:
 *   - `create_data_agent`
 *   - `delete_data_agent`
 *   - `update_data_agent`
 *
 * Every tool answers with `{status: 'SUCCESS', response}` or
 * `{status: 'ERROR', error_details}` and never throws.
 *
 * ```ts
 * const toolset = new DataAgentToolset({
 *   credentialsConfig: {clientId, clientSecret},
 *   dataAgentToolConfig: {maxQueryResultRows: 100},
 * });
 * ```
 *
 * An empty `toolFilter` array exposes no tools, which follows adk-python and
 * not `BaseToolset.isToolSelected`. The base class reads an empty array as
 * "no filter"; this toolset reads an absent option as "no filter" instead, so
 * both intentions stay expressible.
 */
@experimental
export class DataAgentToolset extends BaseToolset {
  private readonly credentials?: DataAgentCredentialsManager;
  private readonly settings: ResolvedDataAgentToolConfig;

  /**
   * @throws Error if `credentialsConfig` names no credential source or more
   *   than one, or if either modification timing field is not positive.
   */
  constructor(options: DataAgentToolsetOptions = {}) {
    // `BaseToolset` requires a filter, so an absent one becomes a predicate
    // that selects everything. That keeps "no filter" distinct from the empty
    // array, which adk-python reads as "expose nothing".
    super(options.toolFilter ?? (() => true));
    this.settings = resolveDataAgentToolConfig(options.dataAgentToolConfig);
    if (options.credentialsConfig) {
      validateDataAgentCredentialsConfig(options.credentialsConfig);
      this.credentials = new DataAgentCredentialsManager(
        options.credentialsConfig,
      );
    }
  }

  /**
   * Selects tools the way adk-python's `DataAgentToolset._is_tool_selected`
   * does, and not the way `BaseToolset.isToolSelected` does: a name the list
   * carries selects the tool, and an empty list selects none. The inherited
   * version reads an empty list as "no filter" and would expose every tool.
   */
  override async getTools(context?: ReadonlyContext): Promise<BaseTool[]> {
    const tools = buildDataAgentTools(this.credentials, this.settings);
    const filter = this.toolFilter;
    if (Array.isArray(filter)) {
      return tools.filter((tool) => filter.includes(tool.name));
    }
    // A predicate needs a context, so without one every tool is exposed.
    return context ? tools.filter((tool) => filter(tool, context)) : tools;
  }

  /**
   * A no-op, matching adk-python. Each tool call opens and finishes its own
   * HTTP exchange, so the toolset holds no resource to release.
   */
  override async close(): Promise<void> {}
}
