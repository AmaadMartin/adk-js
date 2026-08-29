/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {OpenAPIV3} from 'openapi-types';
import {AuthCredential} from '../../../auth/auth_credential.js';

/**
 * Applies the given credential to the request headers and URL.
 *
 * @param url The target URL.
 * @param headers The request headers.
 * @param credential The auth credential.
 * @param authScheme The auth scheme from OpenAPI spec.
 * @returns The updated URL (if modified by query params).
 */
export function applyCredential(
  url: string,
  headers: Record<string, string>,
  credential?: AuthCredential,
  authScheme?: OpenAPIV3.SecuritySchemeObject,
): string {
  if (!credential) return url;

  if (credential.apiKey) {
    let inLocation: string | undefined;
    let name = 'key';

    if (authScheme && authScheme.type === 'apiKey') {
      const apiKeyScheme = authScheme as OpenAPIV3.ApiKeySecurityScheme;
      inLocation = apiKeyScheme.in;
      name = apiKeyScheme.name;
    }

    if (inLocation === 'header') {
      headers[name] = credential.apiKey;
    } else if (inLocation === 'query') {
      const separator = url.includes('?') ? '&' : '?';
      url += `${separator}${name}=${encodeURIComponent(credential.apiKey)}`;
    } else {
      // Default to header Authorization if not specified or unknown location
      headers['Authorization'] = credential.apiKey;
    }
  } else if (
    credential.http &&
    credential.http.credentials &&
    credential.http.credentials.token
  ) {
    headers['Authorization'] = `Bearer ${credential.http.credentials.token}`;
  }

  return url;
}

/**
 * Helper to create a simple API Key auth scheme.
 */
export function createApiKeyScheme(
  name: string,
  inLocation: 'header' | 'query' | 'cookie',
): OpenAPIV3.SecuritySchemeObject {
  return {
    type: 'apiKey',
    name,
    in: inLocation,
  };
}

/**
 * Helper to create a simple Bearer Token auth scheme.
 */
export function createBearerScheme(): OpenAPIV3.SecuritySchemeObject {
  return {
    type: 'http',
    scheme: 'bearer',
  };
}

function requireString(value: unknown, field: string): void {
  if (typeof value !== 'string') {
    throw new Error(
      `Invalid security scheme data: '${field}' must be a string.`,
    );
  }
}

function requireObject(value: unknown, field: string): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(
      `Invalid security scheme data: '${field}' must be an object.`,
    );
  }
}

/**
 * Validates a security scheme supplied as an object or as JSON text.
 *
 * The analogue of adk-python's `dict_to_auth_scheme`. It accepts the four
 * OpenAPI security scheme types and rejects a scheme that omits the fields its
 * type requires, so a bad configuration fails where it is supplied rather than
 * at the first API call.
 *
 * @param value The security scheme, or the JSON text of one.
 * @throws {Error} If the scheme has no `type`, an unsupported `type`, or a
 *     missing required field. Malformed JSON raises `JSON.parse`'s own
 *     `SyntaxError`.
 * @returns The validated security scheme.
 */
export function parseAuthScheme(
  value: OpenAPIV3.SecuritySchemeObject | string,
): OpenAPIV3.SecuritySchemeObject {
  const scheme: OpenAPIV3.SecuritySchemeObject =
    typeof value === 'string'
      ? (JSON.parse(value) as OpenAPIV3.SecuritySchemeObject)
      : value;

  if (typeof scheme !== 'object' || scheme === null || !scheme.type) {
    throw new Error("Missing 'type' field in security scheme.");
  }
  const schemeType: string = scheme.type;

  switch (scheme.type) {
    case 'apiKey':
      requireString(scheme.name, 'name');
      requireString(scheme.in, 'in');
      return scheme;
    case 'http':
      requireString(scheme.scheme, 'scheme');
      return scheme;
    case 'oauth2':
      requireObject(scheme.flows, 'flows');
      return scheme;
    case 'openIdConnect':
      requireString(scheme.openIdConnectUrl, 'openIdConnectUrl');
      return scheme;
    default:
      throw new Error(`Invalid security scheme type: ${schemeType}`);
  }
}
