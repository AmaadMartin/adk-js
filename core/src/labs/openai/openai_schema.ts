/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * JSON Schema helpers for the OpenAI labs models.
 *
 * Ports `enforce_strict_openai_schema` from adk-python
 * `src/google/adk/labs/openai/_openai_schema.py`, and `lowercase_schema_types`
 * from `src/google/adk/utils/_schema_utils.py`, which that module imports.
 * Both stay internal here, because the OpenAI Responses model is their only
 * consumer in adk-js. The Python spellings of the schema keywords are dropped:
 * JSON Schema and `@google/genai`'s `Schema` are both camelCase, so no input
 * reaching this module can carry them.
 */

/** Schema keywords whose value is an object of named subschemas. */
const NAMED_SUBSCHEMA_KEYS = [
  '$defs',
  'definitions',
  'dependentSchemas',
  'patternProperties',
  'properties',
] as const;

/** Schema keywords whose value is a single subschema. */
const SINGLE_SUBSCHEMA_KEYS = [
  'additionalProperties',
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
const LIST_SUBSCHEMA_KEYS = ['allOf', 'anyOf', 'oneOf', 'prefixItems'] as const;

/** Returns true when `value` is a plain JSON object. */
export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Lowercases the JSON Schema `type` strings in a schema, in place.
 *
 * A genai `Schema` carries its type as the uppercase enum name (`STRING`),
 * while JSON Schema and the providers that consume it expect `string`. A type
 * may also be a list of names, as in `['STRING', 'NULL']`. Nested subschemas
 * are reached through the schema keywords only, so a `type` key inside a
 * `default` or `example` value is left untouched.
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
  if (!isJsonObject(value)) {
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

  for (const key of NAMED_SUBSCHEMA_KEYS) {
    const child = value[key];
    if (isJsonObject(child)) {
      for (const nested of Object.values(child)) {
        lowercaseSchemaTypes(nested);
      }
    }
  }
  for (const key of SINGLE_SUBSCHEMA_KEYS) {
    lowercaseSchemaTypes(value[key]);
  }
  for (const key of LIST_SUBSCHEMA_KEYS) {
    const child = value[key];
    if (Array.isArray(child)) {
      lowercaseSchemaTypes(child);
    }
  }
}

/**
 * Transforms a JSON schema in place so OpenAI accepts it for strict
 * structured outputs.
 *
 * Strict mode requires every object to forbid additional properties and to
 * list every property as required, and requires a `$ref` to stand alone.
 *
 * @param schema The schema to transform. Mutated in place.
 */
export function enforceStrictOpenAiSchema(schema: unknown): void {
  if (!isJsonObject(schema)) {
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
  if (isJsonObject(properties)) {
    if (schema['type'] === 'object') {
      schema['additionalProperties'] = false;
      schema['required'] = Object.keys(properties).sort();
    }
    for (const property of Object.values(properties)) {
      enforceStrictOpenAiSchema(property);
    }
  }

  const defs = schema['$defs'];
  if (isJsonObject(defs)) {
    for (const definition of Object.values(defs)) {
      enforceStrictOpenAiSchema(definition);
    }
  }
  for (const key of ['anyOf', 'oneOf', 'allOf'] as const) {
    const branches = schema[key];
    if (Array.isArray(branches)) {
      for (const branch of branches) {
        enforceStrictOpenAiSchema(branch);
      }
    }
  }
  enforceStrictOpenAiSchema(schema['items']);
}
