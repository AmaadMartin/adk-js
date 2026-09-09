/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {OpenAPIV3} from 'openapi-types';
import {snakeCase} from '../../utils/case_utils.js';

/** Argument name used when a parameter's location is not a known one. */
const DEFAULT_NAME = 'value';

/**
 * Argument name used when a parameter's name derives to nothing.
 *
 * A `Map`, because the key is a location straight from the document.
 */
const DEFAULT_NAME_BY_LOCATION: ReadonlyMap<string, string> = new Map([
  ['body', 'body'],
  ['query', 'query_param'],
  ['path', 'path_param'],
  ['header', 'header_param'],
  ['cookie', 'cookie_param'],
]);

/** One argument of a tool generated from an OpenAPI operation. */
export interface ApiParameter {
  originalName: string;
  paramLocation: string;
  paramSchema: OpenAPIV3.SchemaObject;
  description?: string;
  name: string; // The name used in the generated tool schema (may be snake_cased)
  required: boolean;
}

/** The values {@link createApiParameter} derives a parameter from. */
export interface ApiParameterInit {
  originalName: string;
  paramLocation: string;
  paramSchema?: OpenAPIV3.SchemaObject;
  description?: string;
  /** Overrides the derived name when provided. */
  name?: string;
  required?: boolean;
}

/**
 * Derives a tool-facing parameter from an OpenAPI parameter.
 *
 * The name is the caller's, else the snake_case original, else a name for the
 * parameter's location. The description is the caller's, else the schema's
 * own. `init` is not modified.
 *
 * @param init The parameter as the document declares it.
 * @returns The parameter.
 */
export function createApiParameter(init: ApiParameterInit): ApiParameter {
  const paramSchema = init.paramSchema ?? {};
  return {
    originalName: init.originalName,
    paramLocation: init.paramLocation,
    paramSchema,
    description: init.description || paramSchema.description || '',
    name:
      init.name ||
      snakeCase(init.originalName) ||
      DEFAULT_NAME_BY_LOCATION.get(init.paramLocation) ||
      DEFAULT_NAME,
    required: init.required ?? false,
  };
}
