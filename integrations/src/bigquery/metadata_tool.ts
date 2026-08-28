/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {BigQuery, BigQueryOptions} from '@google-cloud/bigquery';
import {BaseTool, FunctionTool, ToolExecuteArgument} from '@google/adk';
import {z} from 'zod';

import {version} from '../version.js';
import {BigQueryToolConfig} from './config.js';
import {toBigQueryToolError} from './tool_error.js';

/** The user-agent prefix every BigQuery API call from ADK carries. */
const BQ_USER_AGENT = `adk-bigquery-tool google-adk/${version}`;

/** What every BigQuery metadata tool needs to reach the API. */
export interface BigQueryToolDependencies {
  /**
   * The auth client every tool call uses. When it is undefined the BigQuery
   * client resolves Application Default Credentials.
   */
  credentials?: BigQueryOptions['authClient'];
  /** The settings the toolset was built with. */
  settings: BigQueryToolConfig;
  /**
   * Prepended to each tool name the model sees. BigQuery still receives the
   * plain tool name in the user agent, which adk-python pins.
   */
  prefix?: string;
}

/** How one metadata tool differs from the others. */
interface MetadataToolSpec<TParameters extends z.ZodObject<z.ZodRawShape>> {
  name: string;
  description: string;
  parameters: TParameters;
  /** The BigQuery read this tool performs. */
  read: (
    client: BigQuery,
    input: ToolExecuteArgument<TParameters>,
  ) => Promise<unknown>;
}

const PROJECT_ID = z
  .string()
  .describe('The Google Cloud project id owning the resource.');
const DATASET_ID = z.string().describe('The BigQuery dataset id.');

const DATASET_PARAMETERS = z.object({
  project_id: PROJECT_ID,
  dataset_id: DATASET_ID,
});

/**
 * The one parameter every metadata tool takes. Reading it back narrows the
 * project id out of a tool's own parameters, whatever else they hold.
 */
const PROJECT_PARAMETERS = z.object({project_id: PROJECT_ID});

/** The ids of the listed resources, dropping any the API left unnamed. */
function resourceIds(resources: Array<{id?: string}>): string[] {
  return resources
    .map((resource) => resource.id)
    .filter((id): id is string => id !== undefined);
}

/**
 * Builds one metadata tool from the read it performs.
 *
 * A tool never throws at the model, so a rejection becomes the error payload
 * adk-python returns. The catch sits inside `execute`, because
 * `FunctionTool.runAsync` re-throws anything that escapes it.
 *
 * @param deps The credentials and settings of the owning toolset.
 * @param spec The name, description, parameters and read of this tool.
 * @return The tool, ready for an agent.
 */
function createMetadataTool<TParameters extends z.ZodObject<z.ZodRawShape>>(
  deps: BigQueryToolDependencies,
  spec: MetadataToolSpec<TParameters>,
): FunctionTool<TParameters> {
  return new FunctionTool({
    name: deps.prefix ? `${deps.prefix}_${spec.name}` : spec.name,
    description: spec.description,
    parameters: spec.parameters,
    execute: async (input) => {
      try {
        const client = new BigQuery({
          projectId: PROJECT_PARAMETERS.parse(input).project_id,
          authClient: deps.credentials,
          location: deps.settings.location,
          userAgent: [BQ_USER_AGENT, deps.settings.applicationName, spec.name]
            .filter(Boolean)
            .join(' '),
        });
        return await spec.read(client, input);
      } catch (error: unknown) {
        return toBigQueryToolError(error);
      }
    },
  });
}

/**
 * Builds every BigQuery metadata tool, in the order adk-python lists them.
 *
 * @param deps The credentials and settings of the owning toolset.
 * @return The five read-only metadata tools.
 */
export function createBigQueryMetadataTools(
  deps: BigQueryToolDependencies,
): BaseTool[] {
  return [
    createMetadataTool(deps, {
      name: 'get_dataset_info',
      description:
        'Get metadata information about a BigQuery dataset, such as its ' +
        'description, location and access list.',
      parameters: DATASET_PARAMETERS,
      read: async (client, input) => {
        const [metadata] = await client.dataset(input.dataset_id).getMetadata();
        return metadata;
      },
    }),
    createMetadataTool(deps, {
      name: 'get_table_info',
      description:
        'Get metadata information about a BigQuery table, such as its ' +
        'schema, description, row count and size.',
      parameters: z.object({
        project_id: PROJECT_ID,
        dataset_id: DATASET_ID,
        table_id: z.string().describe('The BigQuery table id.'),
      }),
      read: async (client, input) => {
        const [metadata] = await client
          .dataset(input.dataset_id)
          .table(input.table_id)
          .getMetadata();
        return metadata;
      },
    }),
    createMetadataTool(deps, {
      name: 'list_dataset_ids',
      description:
        'List BigQuery dataset ids in a Google Cloud project. For example, ' +
        'list_dataset_ids("bigquery-public-data") returns ["austin_311", ' +
        '"baseball", ...].',
      parameters: z.object({project_id: PROJECT_ID}),
      read: async (client) => {
        const [datasets] = await client.getDatasets();
        return resourceIds(datasets);
      },
    }),
    createMetadataTool(deps, {
      name: 'list_table_ids',
      description:
        'List table ids in a BigQuery dataset. For example, ' +
        'list_table_ids("bigquery-public-data", "cdc_places") returns ' +
        '["chronic_disease_indicators", ...].',
      parameters: DATASET_PARAMETERS,
      read: async (client, input) => {
        const [tables] = await client.dataset(input.dataset_id).getTables();
        return resourceIds(tables);
      },
    }),
    createMetadataTool(deps, {
      name: 'get_job_info',
      description:
        'Get metadata information about a BigQuery job, including its slot ' +
        'usage, configuration, statistics, status and original query.',
      parameters: z.object({
        project_id: PROJECT_ID,
        job_id: z
          .string()
          .describe(
            'The BigQuery job id, either bare or as project_id:region.job_id.',
          ),
      }),
      read: async (client, input) => {
        const [metadata] = await client.job(input.job_id).getMetadata();
        return metadata;
      },
    }),
  ];
}
