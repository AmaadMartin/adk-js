/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {z} from 'zod';

import {ReadonlyContext} from '../../agents/readonly_context.js';
import {experimental} from '../../utils/experimental.js';
import {BaseTool} from '../base_tool.js';
import {BaseToolset, ToolPredicate} from '../base_toolset.js';
import {FunctionTool} from '../function_tool.js';

import {DataAgentToolConfig} from './config.js';
import {DataAgentCredentialsConfig} from './credentials.js';
import {
  askDataAgent,
  DataAgentToolDeps,
  getDataAgentInfo,
  listAccessibleDataAgents,
} from './data_agent_tool.js';

const DATA_AGENT_NAME_DESCRIPTION =
  'The resource name of the data agent, in the format ' +
  'projects/{project}/locations/{location}/dataAgents/{agent}.';

/** Configures a {@link DataAgentToolset}. */
export interface DataAgentToolsetOptions {
  /**
   * Resolves the credentials sent to the Gemini Data Analytics API. Defaults
   * to Application Default Credentials.
   */
  credentialsConfig?: DataAgentCredentialsConfig;

  /** Endpoint and result-size settings shared by the three tools. */
  dataAgentToolConfig?: DataAgentToolConfig;

  /**
   * Selects which tools the model sees, either by name or by predicate. An
   * empty array, the default, exposes all of them.
   */
  toolFilter?: ToolPredicate | string[];
}

/** Builds the three model-facing tools over one set of dependencies. */
function createDataAgentTools(deps: DataAgentToolDeps): BaseTool[] {
  return [
    new FunctionTool({
      name: 'list_accessible_data_agents',
      description:
        'Lists the data agents that are accessible in a Google Cloud project.',
      parameters: z.object({
        project_id: z
          .string()
          .describe('The Google Cloud project to list data agents in.'),
      }),
      execute: (input, toolContext) =>
        listAccessibleDataAgents(
          {projectId: input.project_id},
          {
            ...deps,
            toolContext,
          },
        ),
    }),
    new FunctionTool({
      name: 'get_data_agent_info',
      description:
        'Gets one data agent by resource name, including its published ' +
        'context and the data sources it can read.',
      parameters: z.object({
        data_agent_name: z.string().describe(DATA_AGENT_NAME_DESCRIPTION),
      }),
      execute: (input, toolContext) =>
        getDataAgentInfo(
          {dataAgentName: input.data_agent_name},
          {
            ...deps,
            toolContext,
          },
        ),
    }),
    new FunctionTool({
      name: 'ask_data_agent',
      description:
        'Asks a data agent a question in natural language. Returns the ' +
        "agent's thought steps, the SQL it generated, the rows it retrieved " +
        'and its final answer.',
      parameters: z.object({
        data_agent_name: z.string().describe(DATA_AGENT_NAME_DESCRIPTION),
        query: z.string().describe('The question to ask the data agent.'),
      }),
      execute: (input, toolContext) =>
        askDataAgent(
          {dataAgentName: input.data_agent_name, query: input.query},
          {...deps, toolContext},
        ),
    }),
  ];
}

/**
 * A toolset that lets an agent discover Google Cloud data agents and delegate
 * natural-language data questions to them.
 *
 * @example
 * ```ts
 * const agent = new LlmAgent({
 *   name: 'analyst',
 *   model: 'gemini-2.5-flash',
 *   tools: [new DataAgentToolset()],
 * });
 * ```
 */
@experimental
export class DataAgentToolset extends BaseToolset {
  private readonly deps: DataAgentToolDeps;

  constructor(options: DataAgentToolsetOptions = {}) {
    super(options.toolFilter ?? []);
    this.deps = {
      credentials:
        options.credentialsConfig ?? new DataAgentCredentialsConfig(),
      settings: options.dataAgentToolConfig,
    };
  }

  override async getTools(context?: ReadonlyContext): Promise<BaseTool[]> {
    return createDataAgentTools(this.deps).filter((tool) => {
      if (Array.isArray(this.toolFilter) && this.toolFilter.length > 0) {
        return this.toolFilter.includes(tool.name);
      }
      return context ? this.isToolSelected(tool, context) : true;
    });
  }

  override async close(): Promise<void> {}
}
