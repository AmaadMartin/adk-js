/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The BigQuery and Dataplex clients the tools call through.
 *
 * Ported from adk-python `src/google/adk/integrations/bigquery/client.py`
 * (branch `main`). Both packages are optional peer dependencies, so they are
 * imported lazily: constructing a toolset downloads and loads nothing.
 */

import type {BigQuery} from '@google-cloud/bigquery';
import type {CatalogServiceClient} from '@google-cloud/dataplex';

import {loadOptionalPeer} from '../../utils/optional_peer.js';
import {version} from '../../version.js';

import {
  BigQueryCredentialsConfig,
  resolveBigQueryScopes,
} from './bigquery_credentials.js';
import {ResolvedBigQueryToolConfig} from './config.js';

/** The ADK release, as both clients report it. */
export const USER_AGENT_BASE = `google-adk/${version}`;

/** Leading user agent fragment of every BigQuery call. */
export const BQ_USER_AGENT = `adk-bigquery-tool ${USER_AGENT_BASE}`;

/** Leading user agent fragment of every Dataplex call. */
export const DP_USER_AGENT = `adk-dataplex-tool ${USER_AGENT_BASE}`;

/**
 * Joins the user agent fragments of one call, dropping the absent ones.
 *
 * @param base The leading fragment naming the client.
 * @param extras The application name and the calling tool, either may be
 *     absent.
 * @return The user agent string.
 */
export function buildUserAgent(
  base: string,
  extras: ReadonlyArray<string | undefined>,
): string {
  return [base, ...extras.filter((extra) => !!extra)].join(' ');
}

/** What one BigQuery client is built for. */
export interface BigQueryClientOptions {
  /** The project the client bills and scopes requests to. */
  projectId?: string;
  /** The BigQuery location, or absent to let BigQuery choose it. */
  location?: string;
  /** The application name and the calling tool, for the user agent. */
  userAgentExtras?: ReadonlyArray<string | undefined>;
}

/**
 * Builds a BigQuery client, loading `@google-cloud/bigquery` on first use.
 *
 * @param options What the client is built for.
 * @param credentialsConfig How to authenticate. Absent means the application
 *     default credentials of the process.
 * @return The client.
 * @throws If `@google-cloud/bigquery` is not installed.
 */
export async function getBigQueryClient(
  options: BigQueryClientOptions,
  credentialsConfig?: BigQueryCredentialsConfig,
): Promise<BigQuery> {
  const bigquery = await loadOptionalPeer(
    {packageName: '@google-cloud/bigquery', feature: 'BigQueryToolset'},
    () => import('@google-cloud/bigquery'),
  );

  return new bigquery.BigQuery({
    projectId: options.projectId,
    location: options.location,
    userAgent: buildUserAgent(BQ_USER_AGENT, options.userAgentExtras ?? []),
    credentials: credentialsConfig?.credentials,
    keyFilename: credentialsConfig?.keyFilename,
    scopes: resolveBigQueryScopes(credentialsConfig),
  });
}

/**
 * Builds a Dataplex catalog client, loading `@google-cloud/dataplex` on first
 * use. The caller owns the client and must close it.
 *
 * @param userAgentExtras The application name and the calling tool.
 * @param credentialsConfig How to authenticate. Absent means the application
 *     default credentials of the process.
 * @return The client.
 * @throws If `@google-cloud/dataplex` is not installed.
 */
export async function getDataplexCatalogClient(
  userAgentExtras: ReadonlyArray<string | undefined>,
  credentialsConfig?: BigQueryCredentialsConfig,
): Promise<CatalogServiceClient> {
  const dataplex = await loadOptionalPeer(
    {packageName: '@google-cloud/dataplex', feature: 'BigQueryToolset'},
    () => import('@google-cloud/dataplex'),
  );

  return new dataplex.CatalogServiceClient({
    credentials: credentialsConfig?.credentials,
    keyFilename: credentialsConfig?.keyFilename,
    scopes: resolveBigQueryScopes(credentialsConfig),
    'grpc.primary_user_agent': buildUserAgent(DP_USER_AGENT, userAgentExtras),
  });
}

/**
 * The BigQuery clients one toolset has opened.
 *
 * A tool call reuses the client of an identical earlier call, and
 * {@link BigQueryToolset.close} releases the whole set. adk-python builds a
 * fresh client per call and has nothing to release; adk-js keeps the clients
 * so that a long-lived agent does not rebuild one per tool call.
 */
export class BigQueryClientCache {
  private readonly clients = new Map<string, Promise<BigQuery>>();

  constructor(private readonly credentialsConfig?: BigQueryCredentialsConfig) {}

  /**
   * Returns the client for these options, building it on first request.
   *
   * @param options What the client is built for.
   * @return The client.
   */
  async get(options: BigQueryClientOptions): Promise<BigQuery> {
    const key = [
      options.projectId ?? '',
      options.location ?? '',
      buildUserAgent(BQ_USER_AGENT, options.userAgentExtras ?? []),
    ].join('\n');

    let client = this.clients.get(key);
    if (!client) {
      // A failed build must not be cached, or every later call inherits it.
      client = getBigQueryClient(options, this.credentialsConfig).catch(
        (err: unknown) => {
          this.clients.delete(key);
          throw err;
        },
      );
      this.clients.set(key, client);
    }
    return client;
  }

  /** Releases every client this cache has opened. */
  close(): void {
    this.clients.clear();
  }
}

/** What every BigQuery tool needs in order to reach the service. */
export interface BigQueryToolDeps {
  /** The clients the owning toolset has opened. */
  clients: BigQueryClientCache;
  /** The toolset's validated configuration. */
  settings: ResolvedBigQueryToolConfig;
  /** How to authenticate, for the clients the cache does not own. */
  credentialsConfig?: BigQueryCredentialsConfig;
}

/**
 * Returns the BigQuery client one tool call runs on.
 *
 * @param deps What the calling tool was built with.
 * @param projectId The project the call runs in.
 * @param toolName The calling tool, reported in the user agent.
 * @return The client.
 */
export function getToolClient(
  deps: BigQueryToolDeps,
  projectId: string,
  toolName: string,
): Promise<BigQuery> {
  return deps.clients.get({
    projectId,
    location: deps.settings.location,
    userAgentExtras: [deps.settings.applicationName, toolName],
  });
}
