/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

export interface DiscoverySchema {
  type?: string;
  description?: string;
  format?: string;
  enum?: string[];
  pattern?: string;
  default?: string;
  required?: boolean;
  $ref?: string;
  items?: DiscoverySchema;
  properties?: Record<string, DiscoverySchema>;
}

export interface DiscoveryParameter extends DiscoverySchema {
  location?: string;
}

export interface DiscoveryMethod {
  id?: string;
  path?: string;
  flatPath?: string;
  httpMethod?: string;
  description?: string;
  parameters?: Record<string, DiscoveryParameter>;
  request?: {$ref?: string};
  response?: {$ref?: string};
  scopes?: string[];
}

export interface DiscoveryResource {
  methods?: Record<string, DiscoveryMethod>;
  resources?: Record<string, DiscoveryResource>;
}

export interface DiscoveryDocument {
  kind?: string;
  id?: string;
  name?: string;
  version?: string;
  title?: string;
  description?: string;
  documentationLink?: string;
  protocol?: string;
  rootUrl?: string;
  servicePath?: string;
  auth?: {oauth2?: {scopes?: Record<string, {description?: string}>}};
  schemas?: Record<string, DiscoverySchema>;
  resources?: Record<string, DiscoveryResource>;
  methods?: Record<string, DiscoveryMethod>;
}

export const DISCOVERY_URL_TEMPLATE =
  'https://www.googleapis.com/discovery/v1/apis/{api}/{apiVersion}/rest';

export function discoveryUrl(apiName: string, apiVersion: string): string {
  return DISCOVERY_URL_TEMPLATE.replace('{api}', apiName).replace(
    '{apiVersion}',
    apiVersion,
  );
}

export async function fetchDiscoveryDocument(
  apiName: string,
  apiVersion: string,
): Promise<DiscoveryDocument> {
  const response = await fetch(discoveryUrl(apiName, apiVersion));
  if (!response.ok) {
    throw new Error(
      `Failed to fetch the discovery document for ${apiName} ${apiVersion}: ` +
        `HTTP ${response.status}`,
    );
  }
  return (await response.json()) as DiscoveryDocument;
}
