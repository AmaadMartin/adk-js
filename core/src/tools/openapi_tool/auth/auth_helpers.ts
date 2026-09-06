/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {OpenAPIV3} from 'openapi-types';
import {AuthCredential} from '../../../auth/auth_credential.js';
import {isRecord} from '../../../utils/type_guards.js';

/** The locations an API key security scheme may name in its `in` field. */
const API_KEY_LOCATIONS = ['query', 'header', 'cookie'];

function requireString(data: Record<string, unknown>, field: string): void {
  if (typeof data[field] !== 'string') {
    throw new Error(
      `Invalid security scheme data: '${field}' must be a string.`,
    );
  }
}

function requireApiKeyLocation(data: Record<string, unknown>): void {
  const location = data['in'];
  if (typeof location !== 'string' || !API_KEY_LOCATIONS.includes(location)) {
    throw new Error(
      `Invalid security scheme data: 'in' must be one of ` +
        `${API_KEY_LOCATIONS.join(', ')}.`,
    );
  }
}

function requireObject(data: Record<string, unknown>, field: string): void {
  if (!isRecord(data[field])) {
    throw new Error(
      `Invalid security scheme data: '${field}' must be an object.`,
    );
  }
}

// Each assertion below checks the fields its scheme type requires. Call one
// only after `dictToAuthScheme` has matched the `type` discriminator.

function assertApiKeyScheme(
  data: Record<string, unknown>,
): asserts data is Record<string, unknown> & OpenAPIV3.ApiKeySecurityScheme {
  requireString(data, 'name');
  requireApiKeyLocation(data);
}

function assertHttpScheme(
  data: Record<string, unknown>,
): asserts data is Record<string, unknown> & OpenAPIV3.HttpSecurityScheme {
  requireString(data, 'scheme');
}

function assertOAuth2Scheme(
  data: Record<string, unknown>,
): asserts data is Record<string, unknown> & OpenAPIV3.OAuth2SecurityScheme {
  requireObject(data, 'flows');
}

function assertOpenIdConnectScheme(
  data: Record<string, unknown>,
): asserts data is Record<string, unknown> & OpenAPIV3.OpenIdSecurityScheme {
  requireString(data, 'openIdConnectUrl');
}

/**
 * Coerces an untyped security scheme into a typed one, and validates it.
 *
 * A parsed OpenAPI specification carries its security schemes as plain data,
 * so the `type` discriminator and the fields that type requires are checked
 * here rather than trusted.
 *
 * @see {@link https://github.com/OAI/OpenAPI-Specification/blob/main/versions/3.1.0.md#security-scheme-object}
 * @param data The untyped security scheme.
 * @throws {Error} If the scheme names no type, an unknown type, or a known
 *   type whose required fields are missing or the wrong shape.
 * @returns The validated security scheme.
 */
export function dictToAuthScheme(
  data: unknown,
): OpenAPIV3.SecuritySchemeObject {
  if (!isRecord(data) || !('type' in data)) {
    throw new Error("Missing 'type' field in security scheme dictionary.");
  }

  switch (data['type']) {
    case 'apiKey':
      assertApiKeyScheme(data);
      return data;
    case 'http':
      assertHttpScheme(data);
      return data;
    case 'oauth2':
      assertOAuth2Scheme(data);
      return data;
    case 'openIdConnect':
      assertOpenIdConnectScheme(data);
      return data;
    default:
      throw new Error(`Invalid security scheme type: ${String(data['type'])}`);
  }
}

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
