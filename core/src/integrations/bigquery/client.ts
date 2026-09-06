/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {BigQuery, BigQueryOptions} from '@google-cloud/bigquery';
import type {CatalogServiceClient} from '@google-cloud/dataplex';
import type {AuthClient} from 'google-auth-library';

import {loadOptionalPeer} from '../../utils/optional_peer.js';
import {version} from '../../version.js';

/** The optional peer the BigQuery tools load on their first call. */
export const BIGQUERY_PEER = {
  packageName: '@google-cloud/bigquery',
  feature: 'BigQueryToolset',
};

/** The optional peer `search_catalog` loads on its first call. */
export const DATAPLEX_PEER = {
  packageName: '@google-cloud/dataplex',
  feature: 'BigQueryToolset',
};

/** How ADK identifies itself, whichever service is being called. */
export const USER_AGENT_BASE = `google-adk/${version}`;

/** The leading user-agent token of a BigQuery call. */
export const BIGQUERY_USER_AGENT = `adk-bigquery-tool ${USER_AGENT_BASE}`;

/** The library name a Dataplex call reports. */
export const DATAPLEX_LIB_NAME = 'adk-dataplex-tool';

/**
 * Joins the tokens a call identifies itself with.
 *
 * @param base The leading token, naming the tool family.
 * @param extra Further tokens, such as the application name and the tool that
 *     started the call. An absent or empty token is dropped.
 * @return The tokens, space separated.
 */
export function composeUserAgent(
  base: string,
  extra: ReadonlyArray<string | undefined> = [],
): string {
  return [base, ...extra.filter((token): token is string => Boolean(token))]
    .join(' ')
    .trim();
}

/** What `CatalogServiceClient`'s constructor accepts. */
type DataplexClientConstructorOptions = NonNullable<
  ConstructorParameters<typeof CatalogServiceClient>[0]
>;

/** The option objects the two SDK clients are built from. */
type SdkClientOptions = BigQueryOptions | DataplexClientConstructorOptions;

/**
 * Hands a resolved credential to a Google Cloud client.
 *
 * Both SDKs declare `authClient` through google-auth-library's
 * `GoogleAuthOptions`. `@google-cloud/bigquery` reaches that package through
 * `@google-cloud/common` and `@google-cloud/dataplex` through `google-gax`;
 * both nest version 11, which they declare as `^11.0.0`, while adk resolves
 * version 10. The two `AuthClient` declarations are therefore nominally
 * distinct, although this is the object the SDKs call `getRequestHeaders()`
 * on, and the assignment type-checks within one copy. An npm override pinning
 * the nested copies to version 10 would break the range both packages
 * declare, so the mismatch is absorbed at this one point instead.
 *
 * The suppression covers the value alone. `options` keeps its SDK type and is
 * returned unwidened, so renaming or dropping `authClient` still fails the
 * build.
 *
 * @param options The client options being assembled.
 * @param credentials The credential to authenticate with, if there is one.
 * @return `options`, with the credential set when one was supplied.
 */
function withAuthClient<TOptions extends SdkClientOptions>(
  options: TOptions,
  credentials?: AuthClient,
): TOptions {
  if (credentials) {
    // @ts-expect-error two nominally distinct google-auth-library copies
    options.authClient = credentials;
  }
  return options;
}

/** What {@link getBigQueryClient} needs to open a client. */
export interface BigQueryClientOptions {
  /** The Google Cloud project the calls are billed to. */
  project: string;
  /** The credentials to authenticate with, or application default. */
  credentials?: AuthClient;
  /** The BigQuery location, or unset to let BigQuery derive it. */
  location?: string;
  /** Tokens appended to the user agent, such as the calling tool's name. */
  userAgent?: ReadonlyArray<string | undefined>;
}

/**
 * Opens a BigQuery client, loading the SDK on first use.
 *
 * A client is built per call, as adk-python builds one: it holds no channel
 * and no socket of its own, so pooling would buy nothing and would risk
 * handing one end user's credential to another.
 *
 * @param options The project, credentials, location and user-agent tokens.
 * @return The client, once the BigQuery package has loaded.
 * @throws {Error} If `@google-cloud/bigquery` is not installed.
 */
export async function getBigQueryClient(
  options: BigQueryClientOptions,
): Promise<BigQuery> {
  const {BigQuery: BigQueryClient} = await loadOptionalPeer(
    BIGQUERY_PEER,
    () => import('@google-cloud/bigquery'),
  );
  const clientOptions: BigQueryOptions = {
    projectId: options.project,
    location: options.location,
    userAgent: composeUserAgent(BIGQUERY_USER_AGENT, options.userAgent),
  };
  return new BigQueryClient(withAuthClient(clientOptions, options.credentials));
}

/** What {@link getDataplexCatalogClient} needs to open a client. */
export interface DataplexClientOptions {
  /** The credentials to authenticate with, or application default. */
  credentials?: AuthClient;
}

/**
 * Opens a Dataplex catalog client, loading the SDK on first use.
 *
 * The client owns a gRPC channel, so the caller must `close()` it.
 *
 * @param options The credentials to authenticate with.
 * @return The client, once the Dataplex package has loaded.
 * @throws {Error} If `@google-cloud/dataplex` is not installed.
 */
export async function getDataplexCatalogClient(
  options: DataplexClientOptions,
): Promise<CatalogServiceClient> {
  const {CatalogServiceClient: DataplexClient} = await loadOptionalPeer(
    DATAPLEX_PEER,
    () => import('@google-cloud/dataplex'),
  );
  const clientOptions: DataplexClientConstructorOptions = {
    libName: DATAPLEX_LIB_NAME,
    libVersion: version,
  };
  return new DataplexClient(withAuthClient(clientOptions, options.credentials));
}
