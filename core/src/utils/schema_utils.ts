/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Rewrites for JSON Schema documents, shared by every model provider that has
 * to send genai's schemas as plain JSON Schema.
 */

import {isRecord} from './json_utils.js';

/** JSON-schema keys whose value is a map of sub-schemas. */
const SCHEMA_MAP_KEYS = [
  '$defs',
  'defs',
  'dependentSchemas',
  'patternProperties',
  'properties',
] as const;

/** JSON-schema keys whose value is a single sub-schema. */
const SCHEMA_SINGLE_KEYS = [
  'additionalProperties',
  'additional_properties',
  'contains',
  'else',
  'if',
  'items',
  'not',
  'propertyNames',
  'then',
  'unevaluatedProperties',
] as const;

/** JSON-schema keys whose value is a list of sub-schemas. */
const SCHEMA_LIST_KEYS = [
  'allOf',
  'all_of',
  'anyOf',
  'any_of',
  'oneOf',
  'one_of',
  'prefixItems',
] as const;

/**
 * Lowercases every nested JSON-schema `type` string, in place.
 *
 * genai spells its types `STRING` and `OBJECT`, which a provider expecting
 * plain JSON Schema rejects.
 *
 * @param value The schema, or a fragment of one, to rewrite.
 */
export function lowercaseSchemaTypes(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      lowercaseSchemaTypes(item);
    }
    return;
  }
  if (!isRecord(value)) {
    return;
  }
  const schemaType = value['type'];
  if (typeof schemaType === 'string') {
    value['type'] = schemaType.toLowerCase();
  }
  for (const key of SCHEMA_MAP_KEYS) {
    const child = value[key];
    if (isRecord(child)) {
      for (const childValue of Object.values(child)) {
        lowercaseSchemaTypes(childValue);
      }
    }
  }
  for (const key of SCHEMA_SINGLE_KEYS) {
    lowercaseSchemaTypes(value[key]);
  }
  for (const key of SCHEMA_LIST_KEYS) {
    const child = value[key];
    if (Array.isArray(child)) {
      lowercaseSchemaTypes(child);
    }
  }
}
