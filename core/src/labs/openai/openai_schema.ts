/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Shared JSON-schema helpers for the OpenAI labs models.
 *
 * Ported from `src/google/adk/labs/openai/_openai_schema.py` and
 * `src/google/adk/utils/_schema_utils.py` in google/adk-python.
 */

/** Schema keywords whose value is a map of subschemas. */
const SUBSCHEMA_MAP_KEYWORDS = [
  '$defs',
  'definitions',
  'defs',
  'dependentSchemas',
  'patternProperties',
  'properties',
] as const;

/** Schema keywords whose value is a single subschema, or a list of them. */
const SUBSCHEMA_KEYWORDS = [
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

/** Schema keywords whose value is a list of subschemas. */
const SUBSCHEMA_LIST_KEYWORDS = [
  'allOf',
  'all_of',
  'anyOf',
  'any_of',
  'oneOf',
  'one_of',
  'prefixItems',
] as const;

/** Keywords `enforceStrictOpenAiSchema` recurses into as lists of subschemas. */
const STRICT_COMPOSITION_KEYWORDS = ['anyOf', 'oneOf', 'allOf'] as const;

/** Returns true when `value` is a plain JSON object rather than an array. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Lowercases the JSON Schema `type` strings in a schema, in place.
 *
 * A genai `Schema` serializes its type as the uppercase enum name (`STRING`),
 * while JSON Schema and the providers that consume it expect `string`. A type
 * may also be a list of names, as in `['STRING', 'NULL']`. Only schema
 * keywords are followed, so a `type` key inside a `default` or an `example`
 * value is left alone.
 *
 * @param value A JSON Schema object, or a list of them. Mutated in place.
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
  } else if (Array.isArray(schemaType)) {
    value['type'] = schemaType.map((item) =>
      typeof item === 'string' ? item.toLowerCase() : item,
    );
  }

  for (const keyword of SUBSCHEMA_MAP_KEYWORDS) {
    const children = value[keyword];
    if (isRecord(children)) {
      for (const child of Object.values(children)) {
        lowercaseSchemaTypes(child);
      }
    }
  }
  for (const keyword of SUBSCHEMA_KEYWORDS) {
    lowercaseSchemaTypes(value[keyword]);
  }
  for (const keyword of SUBSCHEMA_LIST_KEYWORDS) {
    const children = value[keyword];
    if (Array.isArray(children)) {
      lowercaseSchemaTypes(children);
    }
  }
}

/**
 * Transforms a JSON schema for OpenAI strict structured output, in place.
 *
 * Strict mode requires every object to list all of its properties as
 * `required` and to forbid extra ones. A node carrying a `$ref` must carry
 * nothing else, so its siblings are dropped.
 *
 * @param schema The schema to transform. Mutated in place.
 */
export function enforceStrictOpenAiSchema(schema: unknown): void {
  if (!isRecord(schema)) {
    return;
  }
  if ('$ref' in schema) {
    for (const key of Object.keys(schema)) {
      if (key !== '$ref') {
        delete schema[key];
      }
    }
    return;
  }

  const properties = schema['properties'];
  if (schema['type'] === 'object' && isRecord(properties)) {
    schema['additionalProperties'] = false;
    schema['required'] = Object.keys(properties).sort();
  }

  const definitions = schema['$defs'];
  if (isRecord(definitions)) {
    for (const definition of Object.values(definitions)) {
      enforceStrictOpenAiSchema(definition);
    }
  }
  if (isRecord(properties)) {
    for (const property of Object.values(properties)) {
      enforceStrictOpenAiSchema(property);
    }
  }
  for (const keyword of STRICT_COMPOSITION_KEYWORDS) {
    const members = schema[keyword];
    if (Array.isArray(members)) {
      for (const member of members) {
        enforceStrictOpenAiSchema(member);
      }
    }
  }
  enforceStrictOpenAiSchema(schema['items']);
}
