/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {CatalogServiceClient} from '@google-cloud/dataplex';

import {GoogleToolStatus} from '../../tools/google_tool.js';

import {BigQueryToolSettings} from './config.js';

/** The Dataplex location searched when neither the call nor the settings pick one. */
export const DEFAULT_SEARCH_LOCATION = 'global';

/** How many entries a search returns when the model asks for no cap. */
export const DEFAULT_SEARCH_PAGE_SIZE = 10;

/** Restricts the search to entries Dataplex harvested from BigQuery. */
const BIGQUERY_SYSTEM_CLAUSE = 'system=BIGQUERY';

/** One catalog entry the search matched. */
export interface CatalogSearchResult {
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

/** What {@link searchCatalog} answers with. */
export interface SearchCatalogResponse {
  status: GoogleToolStatus.SUCCESS;
  results: CatalogSearchResult[];
}

/** What {@link searchCatalog} needs from the model. */
export interface SearchCatalogOptions {
  /** The search query, in natural language or as keywords. */
  prompt: string;
  /** The project the search is scoped to. */
  projectId: string;
  /** The Dataplex location to search, overriding the configured one. */
  location?: string;
  /** How many entries to return. */
  pageSize?: number;
  /** Projects to match, defaulting to the scoping project alone. */
  projectIdsFilter?: string[];
  /** Datasets to match, within the matched projects. */
  datasetIdsFilter?: string[];
  /** Entry types to match. */
  typesFilter?: string[];
}

/**
 * Builds one search clause matching any of `items`.
 *
 * @param predicate The field the clause tests.
 * @param operator How the field is compared.
 * @param items The values to accept. An empty list produces no clause.
 * @return The clause, parenthesised when it has more than one alternative.
 */
function searchClause(
  predicate: string,
  operator: string,
  items: readonly string[],
): string {
  const clauses = items.map((item) => `${predicate}${operator}"${item}"`);
  if (clauses.length <= 1) {
    return clauses[0] ?? '';
  }
  return `(${clauses.join(' OR ')})`;
}

/** The clause matching any dataset in `datasetIds` under any of `projectIds`. */
function datasetClause(
  projectIds: readonly string[],
  datasetIds: readonly string[],
): string {
  const filters = projectIds.flatMap((projectId) =>
    datasetIds.map(
      (datasetId) =>
        `linked_resource:"//bigquery.googleapis.com/projects/${projectId}/datasets/${datasetId}/*"`,
    ),
  );
  return filters.length ? `(${filters.join(' OR ')})` : '';
}

/** Assembles the whole Dataplex search query. */
function buildSearchQuery(options: SearchCatalogOptions): string {
  const projectIds = options.projectIdsFilter?.length
    ? options.projectIdsFilter
    : [options.projectId];
  const parts = [
    options.prompt ? `(${options.prompt})` : '',
    searchClause('projectid', '=', projectIds),
    datasetClause(projectIds, options.datasetIdsFilter ?? []),
    searchClause('type', '=', options.typesFilter ?? []),
    BIGQUERY_SYSTEM_CLAUSE,
  ];
  return parts.filter(Boolean).join(' AND ');
}

/**
 * Finds BigQuery datasets and tables by meaning rather than by name.
 *
 * Reach for it when the exact ids are unknown and the agent is searching by
 * topic, by description, or by a question about the data.
 *
 * @param client The Dataplex catalog client to search through. The caller
 *     owns it and must close it.
 * @param options The search query and the filters narrowing it.
 * @param settings The settings the owning toolset was configured with.
 * @return The entries the search matched.
 * @throws {Error} If the project is missing, or the Dataplex call fails.
 */
export async function searchCatalog(
  client: CatalogServiceClient,
  options: SearchCatalogOptions,
  settings: BigQueryToolSettings,
): Promise<SearchCatalogResponse> {
  if (!options.projectId) {
    throw new Error('project_id must be provided.');
  }
  const searchLocation =
    options.location ?? settings.location ?? DEFAULT_SEARCH_LOCATION;
  const [matches] = await client.searchEntries({
    name: `projects/${options.projectId}/locations/${searchLocation}`,
    query: buildSearchQuery(options),
    pageSize: options.pageSize ?? DEFAULT_SEARCH_PAGE_SIZE,
    semanticSearch: true,
  });

  const results = matches.map((match): CatalogSearchResult => {
    const entry = match.dataplexEntry;
    const source = entry?.entrySource;
    return {
      name: entry?.name ?? '',
      display_name: source?.displayName ?? '',
      entry_type: entry?.entryType ?? '',
      update_time: String(entry?.updateTime ?? ''),
      linked_resource: source?.resource ?? '',
      description: source?.description ?? '',
      location: source?.location ?? '',
    };
  });
  return {status: GoogleToolStatus.SUCCESS, results};
}
