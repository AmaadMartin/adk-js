/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {logger} from '../../utils/logger.js';

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
 * Fetches the Discovery document describing a Google API.
 *
 * @param apiName The Discovery API id, e.g. `calendar`.
 * @param apiVersion The API version, e.g. `v3`.
 * @param discoveryUrl An alternative Discovery URL template. `{api}` and
 *     `{apiVersion}` are substituted when present; a URL with no placeholders
 *     is fetched verbatim.
 * @return The parsed Discovery document.
 * @throws If the Discovery service responds with a non-2xx status.
 */
export async function fetchDiscoveryDocument(
  apiName: string,
  apiVersion: string,
  discoveryUrl: string = DEFAULT_DISCOVERY_URL,
): Promise<DiscoveryDocument> {
  // Function replacements, so a `$` in an api id cannot be expanded as a
  // replacement pattern.
  const url = discoveryUrl
    .replaceAll('{api}', () => apiName)
    .replaceAll('{apiVersion}', () => apiVersion);

  logger.debug(`Fetching Google API discovery document from ${url}`);

  const response = await globalThis.fetch(url, {
    headers: {'Accept': 'application/json'},
  });

  if (!response.ok) {
    throw new Error(
      `Failed to fetch the discovery document for ${apiName} ${apiVersion} ` +
        `from ${url}: HTTP ${response.status}`,
    );
  }

  return (await response.json()) as DiscoveryDocument;
}
