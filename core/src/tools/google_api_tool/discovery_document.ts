/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as https from 'node:https';
import {logger} from '../../utils/logger.js';
import {MtlsClientCerts} from '../../utils/mtls_utils.js';

/**
 * A schema definition inside a Google API Discovery document.
 *
 * Only the fields the OpenAPI conversion reads are declared.
 *
 * @see {@link https://developers.google.com/discovery/v1/reference/apis}
 */
export interface DiscoverySchema {
  type?: string;
  description?: string;
  format?: string;
  pattern?: string;
  default?: unknown;
  enum?: string[];
  /** Discovery marks a required property inline on the property itself. */
  required?: boolean;
  $ref?: string;
  properties?: Record<string, DiscoverySchema>;
  items?: DiscoverySchema;
}

/** A declared method parameter, which is a schema plus a location. */
export interface DiscoveryParameter extends DiscoverySchema {
  /** Where the parameter travels, e.g. `path` or `query`. */
  location?: string;
}

/** A single callable method of a Discovery resource. */
export interface DiscoveryMethod {
  id?: string;
  description?: string;
  httpMethod?: string;
  path?: string;
  flatPath?: string;
  parameters?: Record<string, DiscoveryParameter>;
  request?: {$ref?: string};
  response?: {$ref?: string};
  scopes?: string[];
}

/** A Discovery resource: a group of methods and nested resources. */
export interface DiscoveryResource {
  methods?: Record<string, DiscoveryMethod>;
  resources?: Record<string, DiscoveryResource>;
}

/** A Google API Discovery document. */
export interface DiscoveryDocument {
  title?: string;
  description?: string;
  version?: string;
  documentationLink?: string;
  rootUrl?: string;
  /** The root URL of the mutual-TLS variant of the service, when it has one. */
  mtlsRootUrl?: string;
  servicePath?: string;
  auth?: {oauth2?: {scopes?: Record<string, {description?: string}>}};
  schemas?: Record<string, DiscoverySchema>;
  resources?: Record<string, DiscoveryResource>;
  methods?: Record<string, DiscoveryMethod>;
}

/**
 * The public Google API Discovery service endpoint template.
 *
 * `{api}` and `{apiVersion}` are substituted with the requested API id pair.
 */
export const DEFAULT_DISCOVERY_URL =
  'https://www.googleapis.com/discovery/v1/apis/{api}/{apiVersion}/rest';

/**
 * The mutual-TLS Discovery service endpoint template.
 *
 * It is the default once a client certificate is loaded, because the plain
 * host does not accept one.
 */
export const MTLS_DISCOVERY_URL =
  'https://www.mtls.googleapis.com/discovery/v1/apis/{api}/{apiVersion}/rest';

/** How a Discovery document is fetched. */
export interface FetchDiscoveryOptions {
  /**
   * An alternative Discovery URL template, which wins over both defaults.
   * `{api}` and `{apiVersion}` are substituted when present; a URL with no
   * placeholders is fetched verbatim.
   */
  discoveryUrl?: string;
  /** A client certificate to present, for a mutual-TLS connection. */
  certs?: MtlsClientCerts;
}

/**
 * Picks the Discovery URL to fetch and substitutes its placeholders.
 *
 * @param apiName The Discovery API id, e.g. `calendar`.
 * @param apiVersion The API version, e.g. `v3`.
 * @param discoveryUrl An explicit template, which wins over both defaults.
 * @param hasClientCerts Whether a client certificate will be presented.
 * @return The URL to request.
 */
export function resolveDiscoveryUrl(
  apiName: string,
  apiVersion: string,
  discoveryUrl?: string,
  hasClientCerts = false,
): string {
  const template =
    discoveryUrl ??
    (hasClientCerts ? MTLS_DISCOVERY_URL : DEFAULT_DISCOVERY_URL);

  // Function replacements, so a `$` in an api id cannot be expanded as a
  // replacement pattern.
  return template
    .replaceAll('{api}', () => apiName)
    .replaceAll('{apiVersion}', () => apiVersion);
}

/** One HTTPS GET, optionally presenting a client certificate. */
function getWithClientCert(
  url: string,
  certs?: MtlsClientCerts,
): Promise<{status: number; body: string}> {
  return new Promise((resolve, reject) => {
    const request = https.request(
      url,
      {
        headers: {'Accept': 'application/json'},
        // `globalThis.fetch` cannot present a client certificate in Node,
        // which is why this transport is `node:https` rather than fetch.
        agent: certs
          ? new https.Agent({
              cert: certs.cert,
              key: certs.key,
              passphrase: certs.passphrase,
            })
          : undefined,
      },
      (response) => {
        let body = '';
        response.setEncoding('utf-8');
        response.on('data', (chunk: string) => {
          body += chunk;
        });
        response.on('error', reject);
        response.on('end', () => {
          resolve({status: response.statusCode ?? 0, body});
        });
      },
    );
    request.on('error', reject);
    request.end();
  });
}

/**
 * Fetches the Discovery document describing a Google API.
 *
 * @param apiName The Discovery API id, e.g. `calendar`.
 * @param apiVersion The API version, e.g. `v3`.
 * @param options How to reach the Discovery service.
 * @return The parsed Discovery document.
 * @throws If the Discovery service responds with a non-2xx status, or answers
 *     with something that is not a Discovery document.
 */
export async function fetchDiscoveryDocument(
  apiName: string,
  apiVersion: string,
  options: FetchDiscoveryOptions = {},
): Promise<DiscoveryDocument> {
  const url = resolveDiscoveryUrl(
    apiName,
    apiVersion,
    options.discoveryUrl,
    options.certs !== undefined,
  );

  logger.debug(`Fetching Google API discovery document from ${url}`);

  const {status, body} = await getWithClientCert(url, options.certs);

  if (status < 200 || status >= 300) {
    throw new Error(
      `Failed to fetch the discovery document for ${apiName} ${apiVersion} ` +
        `from ${url}: HTTP ${status}`,
    );
  }

  const document = parseDiscoveryDocument(body);
  if (!document) {
    throw new Error(
      `Failed to retrieve the API specification for ${apiName} ` +
        `${apiVersion} from ${url}: the response is not a discovery document.`,
    );
  }
  return document;
}

/** Parses a response body, or returns `undefined` when it is not a document. */
function parseDiscoveryDocument(body: string): DiscoveryDocument | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body) as unknown;
  } catch {
    return undefined;
  }

  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    Array.isArray(parsed) ||
    Object.keys(parsed).length === 0
  ) {
    return undefined;
  }
  return parsed;
}
