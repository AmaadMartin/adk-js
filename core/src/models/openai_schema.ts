/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * JSON-schema helpers for the OpenAI Chat Completions API.
 *
 * Ported from adk-python `src/google/adk/labs/openai/_openai_schema.py`
 * (`enforce_strict_openai_schema`) and `_update_type_string` in
 * `src/google/adk/labs/openai/_openai_llm.py`.
 */

/** A JSON Schema node. Keys are schema keywords; values are unconstrained. */
export type JsonSchemaObject = Record<string, unknown>;

/** Keywords whose value maps names to subschemas. */
const SCHEMA_MAP_KEYWORDS = [
  '$defs',
  'dependentSchemas',
  'patternProperties',
  'properties',
] as const;

/** Keywords whose value is a subschema, or a list of them. */
const SCHEMA_OR_LIST_KEYWORDS = [
  'additionalProperties',
  'allOf',
  'anyOf',
  'contains',
  'else',
  'if',
  'items',
  'not',
  'oneOf',
  'prefixItems',
  'propertyNames',
  'then',
  'unevaluatedProperties',
] as const;

/** Keywords that combine subschemas, recursed into by the strict transform. */
const STRICT_COMBINATOR_KEYWORDS = ['anyOf', 'oneOf', 'allOf'] as const;

/** Narrows an arbitrary value to a JSON Schema node. */
export function isJsonSchemaObject(value: unknown): value is JsonSchemaObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Lowercases every nested `type` keyword, in place.
 *
 * The genai dialect spells types as an uppercase enum (`STRING`); JSON Schema,
 * and therefore OpenAI, wants `string`. A schema that is already lowercase is
 * left unchanged.
 *
 * @param value A schema node, or a list of them.
 */
export function lowercaseSchemaTypes(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      lowercaseSchemaTypes(item);
    }
    return;
  }
  if (!isJsonSchemaObject(value)) {
    return;
  }

  const schemaType = value['type'];
  if (typeof schemaType === 'string') {
    value['type'] = schemaType.toLowerCase();
  }

  for (const keyword of SCHEMA_MAP_KEYWORDS) {
    const child = value[keyword];
    if (isJsonSchemaObject(child)) {
      for (const subschema of Object.values(child)) {
        lowercaseSchemaTypes(subschema);
      }
    }
  }
  for (const keyword of SCHEMA_OR_LIST_KEYWORDS) {
    lowercaseSchemaTypes(value[keyword]);
  }
}

/**
 * Rewrites a schema, in place, into the subset OpenAI accepts for strict
 * structured outputs.
 *
 * Strict mode requires every object to forbid extra properties and to list all
 * of its properties as required, and it rejects a `$ref` that carries sibling
 * keywords.
 *
 * @param schema The schema node to transform.
 */
export function enforceStrictOpenAiSchema(schema: JsonSchemaObject): void {
  if ('$ref' in schema) {
    for (const key of Object.keys(schema)) {
      if (key !== '$ref') {
        delete schema[key];
      }
    }
    return;
  }

  const properties = schema['properties'];
  if (schema['type'] === 'object' && isJsonSchemaObject(properties)) {
    schema['additionalProperties'] = false;
    schema['required'] = Object.keys(properties).sort();
  }

  for (const keyword of ['$defs', 'properties'] as const) {
    const child = schema[keyword];
    if (isJsonSchemaObject(child)) {
      for (const subschema of Object.values(child)) {
        if (isJsonSchemaObject(subschema)) {
          enforceStrictOpenAiSchema(subschema);
        }
      }
    }
  }

  for (const keyword of STRICT_COMBINATOR_KEYWORDS) {
    const child = schema[keyword];
    if (Array.isArray(child)) {
      for (const subschema of child) {
        if (isJsonSchemaObject(subschema)) {
          enforceStrictOpenAiSchema(subschema);
        }
      }
    }
  }

  const items = schema['items'];
  if (isJsonSchemaObject(items)) {
    enforceStrictOpenAiSchema(items);
  }
}
