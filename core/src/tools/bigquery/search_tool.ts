/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Context} from '../../agents/context.js';
import {getDataplexClient} from './client_helper.js';
import {BigQueryToolConfig} from './config.js';
import {BigQueryCredentialsConfig} from './credentials.js';

/**
 * Finds BigQuery datasets and tables using natural language semantic search via Dataplex.
 */
export async function searchCatalog(
  args: {
    prompt: string;
    projectId: string;
    location?: string;
    pageSize?: number;
    projectIdsFilter?: string[];
    datasetIdsFilter?: string[];
    typesFilter?: string[];
  },
  credentialsConfig?: BigQueryCredentialsConfig,
  toolConfig?: Partial<BigQueryToolConfig>,
  context?: Context,
): Promise<unknown> {
  const {
    prompt,
    projectId,
    location,
    pageSize = 10,
    projectIdsFilter,
    datasetIdsFilter,
    typesFilter,
  } = args;

  try {
    if (!projectId) {
      return {
        status: 'ERROR',
        error_details: 'projectId must be provided.',
      };
    }

    const dataplexClient = await getDataplexClient(
      credentialsConfig,
      toolConfig,
      context,
    );

    const queryParts: string[] = [];
    if (prompt) {
      queryParts.push(`(${prompt})`);
    }

    const projectsToFilter = projectIdsFilter || [projectId];
    if (projectsToFilter.length > 0) {
      queryParts.push(
        constructSearchQueryHelper('projectid', '=', projectsToFilter),
      );
    }

    if (datasetIdsFilter && datasetIdsFilter.length > 0) {
      const datasetResourceFilters: string[] = [];
      for (const pid of projectsToFilter) {
        for (const did of datasetIdsFilter) {
          datasetResourceFilters.push(
            `linked_resource:"//bigquery.googleapis.com/projects/${pid}/datasets/${did}/*"`,
          );
        }
      }
      if (datasetResourceFilters.length > 0) {
        queryParts.push(`(${datasetResourceFilters.join(' OR ')})`);
      }
    }

    if (typesFilter) {
      queryParts.push(constructSearchQueryHelper('type', '=', typesFilter));
    }

    queryParts.push('system=BIGQUERY');

    const fullQuery = queryParts.filter(Boolean).join(' AND ');
    const searchLocation = location || toolConfig?.location || 'global';
    const searchScope = `projects/${projectId}/locations/${searchLocation}`;

    const [responseResults] = await dataplexClient.searchEntries({
      name: searchScope,
      query: fullQuery,
      pageSize: pageSize,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const results = (responseResults || []).map((result: any) => {
      const entry = result.dataplexEntry || {};
      const source = entry.entrySource || {};
      return {
        name: entry.name,
        display_name: source.displayName || '',
        entry_type: entry.entryType,
        update_time: entry.updateTime ? String(entry.updateTime) : '',
        linked_resource: source.resource || '',
        description: source.description || '',
        location: source.location || '',
      };
    });

    return {status: 'SUCCESS', results};
  } catch (ex: unknown) {
    return {
      status: 'ERROR',
      error_details: ex instanceof Error ? ex.message : String(ex),
    };
  }
}

function constructSearchQueryHelper(
  predicate: string,
  operator: string,
  items: string[],
): string {
  if (!items || items.length === 0) {
    return '';
  }

  const clauses = items.map((item) => `${predicate}${operator}"${item}"`);
  return items.length > 1 ? `(${clauses.join(' OR ')})` : clauses[0];
}
