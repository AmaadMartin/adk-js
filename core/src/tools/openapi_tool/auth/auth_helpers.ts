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

function requireStringField(scheme: object, field: string): void {
  const value: unknown = Reflect.get(scheme, field);
  if (typeof value !== 'string') {
    throw new Error(
      `Invalid security scheme data: '${field}' must be a string.`,
    );
  }
}

function requireObjectField(scheme: object, field: string): void {
  const value: unknown = Reflect.get(scheme, field);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(
      `Invalid security scheme data: '${field}' must be an object.`,
    );
  }
}

/**
 * Throws unless `scheme` is a usable OpenAPI security scheme.
 *
 * The analogue of adk-python's `dict_to_auth_scheme`. A scheme reaches a tool
 * from a parsed specification, so its shape is not what the TypeScript type
 * claims. Checking it here fails a bad specification where it is supplied,
 * rather than at the first API call.
 *
 * @param scheme The security scheme to check.
 * @throws {Error} If the scheme has no `type`, an unsupported `type`, or a
 *     missing required field.
 */
export function validateAuthScheme(scheme: unknown): void {
  if (typeof scheme !== 'object' || scheme === null) {
    throw new Error("Missing 'type' field in security scheme.");
  }

  const type: unknown = Reflect.get(scheme, 'type');
  switch (type) {
    case 'apiKey':
      requireStringField(scheme, 'name');
      requireStringField(scheme, 'in');
      return;
    case 'http':
      requireStringField(scheme, 'scheme');
      return;
    case 'oauth2':
      requireObjectField(scheme, 'flows');
      return;
    case 'openIdConnect':
      requireStringField(scheme, 'openIdConnectUrl');
      return;
    case undefined:
      throw new Error("Missing 'type' field in security scheme.");
    default:
      throw new Error(`Invalid security scheme type: ${String(type)}`);
  }
}
