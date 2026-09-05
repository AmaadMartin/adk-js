/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `search_catalog`, which finds BigQuery datasets and tables by description.
 *
 * Ported from adk-python
 * `src/google/adk/integrations/bigquery/search_tool.py` (branch `main`).
 */

import {z} from 'zod';

import {logger} from '../../utils/logger.js';
import {BaseTool} from '../base_tool.js';
import {FunctionTool} from '../function_tool.js';

import {BigQueryToolDeps, getDataplexCatalogClient} from './client.js';
import {
  BigQueryToolResult,
  bigQueryToolError,
  runBigQueryTool,
} from './tool_result.js';

/** The Dataplex location searched when neither the call nor the config names one. */
const DEFAULT_SEARCH_LOCATION = 'global';

/** How many results the search returns by default. */
const DEFAULT_PAGE_SIZE = 10;

/** Arguments of {@link searchCatalog}. */
export const SEARCH_CATALOG_PARAMETERS = z.object({
  prompt: z
    .string()
    .describe('What to look for, in natural language or as keywords.'),
  project_id: z
    .string()
    .describe('The Google Cloud project the search is scoped to.'),
  location: z
    .string()
    .optional()
    .describe('The Dataplex location to search in.'),
  page_size: z.number().optional().describe('How many results to return.'),
  project_ids_filter: z
    .array(z.string())
    .optional()
    .describe(
      'The projects to include in the results. Absent means the project the ' +
        'search is scoped to.',
    ),
  dataset_ids_filter: z
    .array(z.string())
    .optional()
    .describe('The BigQuery datasets to restrict the results to.'),
  types_filter: z
    .array(z.string())
    .optional()
    .describe('The entry types to restrict the results to.'),
});

/** One BigQuery asset the catalog search found. */
export interface SearchCatalogEntry {
  /** The Dataplex entry name. */
  name: string;
  display_name: string;
  entry_type: string;
  update_time: string;
  /** The BigQuery resource the entry describes. */
  linked_resource: string;
  description: string;
  location: string;
}

/** What {@link searchCatalog} returns when the search ran. */
export interface SearchCatalogResult {
  status: 'SUCCESS';
  results: SearchCatalogEntry[];
}

/**
 * Builds one clause of the Dataplex search query.
 *
 * @param predicate The field to match, e.g. `projectid`.
 * @param operator The comparison, e.g. `=`.
 * @param items The values to accept. An empty list contributes nothing.
 * @return The clause, parenthesised when it holds more than one value.
 */
export function constructSearchQueryClause(
  predicate: string,
  operator: string,
  items: ReadonlyArray<string>,
): string {
  if (items.length === 0) {
    return '';
  }
  const clauses = items.map((item) => `${predicate}${operator}"${item}"`);
  return clauses.length > 1 ? `(${clauses.join(' OR ')})` : clauses[0];
}

/** Builds the whole Dataplex search query for one call. */
export function constructSearchQuery(
  input: z.infer<typeof SEARCH_CATALOG_PARAMETERS>,
): string {
  const parts: string[] = [];
  if (input.prompt) {
    parts.push(`(${input.prompt})`);
  }

  const projects =
    input.project_ids_filter && input.project_ids_filter.length > 0
      ? input.project_ids_filter
      : [input.project_id];
  parts.push(constructSearchQueryClause('projectid', '=', projects));

  const datasetIds = input.dataset_ids_filter;
  if (datasetIds && datasetIds.length > 0) {
    const datasetFilters = projects.flatMap((projectId) =>
      datasetIds.map(
        (datasetId) =>
          `linked_resource:"//bigquery.googleapis.com/projects/${projectId}` +
          `/datasets/${datasetId}/*"`,
      ),
    );
    parts.push(`(${datasetFilters.join(' OR ')})`);
  }

  if (input.types_filter && input.types_filter.length > 0) {
    parts.push(constructSearchQueryClause('type', '=', input.types_filter));
  }

  parts.push('system=BIGQUERY');

  return parts.filter((part) => !!part).join(' AND ');
}

/** Whether an error came back from the Dataplex API rather than from us. */
function isApiCallError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    typeof err.code === 'number'
  );
}

/**
 * Finds BigQuery datasets and tables by semantic search over the Dataplex
 * catalog.
 *
 * Reach for it when the exact names are unknown and the search has to run
 * over descriptions or topics instead.
 *
 * @param input What to look for and how to scope the search.
 * @param deps The clients and settings of the owning toolset.
 * @return The matching entries, or the failure envelope.
 */
export async function searchCatalog(
  input: z.infer<typeof SEARCH_CATALOG_PARAMETERS>,
  deps: BigQueryToolDeps,
): Promise<BigQueryToolResult<SearchCatalogResult>> {
  if (!input.project_id) {
    return bigQueryToolError('project_id must be provided.');
  }

  return runBigQueryTool(async () => {
    const client = await getDataplexCatalogClient(
      [deps.settings.applicationName, 'search_catalog'],
      deps.credentialsConfig,
    );
    const searchLocation =
      input.location ?? deps.settings.location ?? DEFAULT_SEARCH_LOCATION;
    try {
      const [entries] = await client.searchEntries(
        {
          name: `projects/${input.project_id}/locations/${searchLocation}`,
          query: constructSearchQuery(input),
          pageSize: input.page_size ?? DEFAULT_PAGE_SIZE,
          semanticSearch: true,
        },
        // `searchEntries` is a paged gax method whose `autoPaginate` defaults
        // to true, which walks every page and reduces `pageSize` to a
        // per-request size. adk-python reads one page, so ask for one page.
        {autoPaginate: false},
      );

      const results = entries.flatMap((result) => {
        const entry = result.dataplexEntry;
        if (!entry) {
          return [];
        }
        const source = entry.entrySource;
        return [
          {
            name: entry.name ?? '',
            display_name: source?.displayName ?? '',
            entry_type: entry.entryType ?? '',
            update_time: String(entry.updateTime ?? ''),
            linked_resource: source?.resource ?? '',
            description: source?.description ?? '',
            location: source?.location ?? '',
          },
        ];
      });
      return {status: 'SUCCESS', results} as const;
    } catch (err: unknown) {
      logger.debug('search_catalog tool: search failed', err);
      if (isApiCallError(err)) {
        return bigQueryToolError(`Dataplex API Error: ${String(err)}`);
      }
      throw err;
    } finally {
      await client.close();
    }
  });
}

/**
 * Builds the `search_catalog` tool.
 *
 * @param deps The clients and settings of the owning toolset.
 * @return The tool.
 */
export function createSearchTool(deps: BigQueryToolDeps): BaseTool {
  return new FunctionTool({
    name: 'search_catalog',
    description:
      'Find BigQuery datasets and tables by natural language semantic ' +
      'search over the Dataplex catalog. Use it to discover assets when the ' +
      'exact names are unknown.',
    parameters: SEARCH_CATALOG_PARAMETERS,
    execute: (input) => searchCatalog(input, deps),
  });
}
