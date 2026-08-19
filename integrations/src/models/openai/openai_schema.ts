/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/** A decoded JSON object, such as a JSON Schema node. */
export type JsonObject = Record<string, unknown>;

/** Schema keywords whose value is an array of sub-schemas. */
const COMBINATOR_KEYWORDS = ['anyOf', 'oneOf', 'allOf'] as const;

/** Narrows a decoded JSON value to a JSON object. */
export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Returns the sub-schemas held as values of a JSON object keyword. */
function subSchemaValues(value: unknown): JsonObject[] {
  return isJsonObject(value) ? Object.values(value).filter(isJsonObject) : [];
}

/** Returns the sub-schemas held in an array-valued keyword. */
function subSchemaItems(value: unknown): JsonObject[] {
  return Array.isArray(value) ? value.filter(isJsonObject) : [];
}

/**
 * Rewrites a JSON Schema in place so the OpenAI Responses API accepts it for
 * strict structured output.
 *
 * Strict mode requires every object to list all of its properties as required
 * and to forbid additional ones, and it rejects a `$ref` that carries sibling
 * keywords.
 */
export function enforceStrictOpenAiSchema(schema: JsonObject): void {
  if ('$ref' in schema) {
    for (const key of Object.keys(schema)) {
      if (key !== '$ref') {
        delete schema[key];
      }
    }
    return;
  }

  const properties = schema['properties'];
  if (schema['type'] === 'object' && isJsonObject(properties)) {
    schema['additionalProperties'] = false;
    schema['required'] = Object.keys(properties).sort();
  }

  for (const definition of subSchemaValues(schema['$defs'])) {
    enforceStrictOpenAiSchema(definition);
  }
  for (const property of subSchemaValues(properties)) {
    enforceStrictOpenAiSchema(property);
  }
  for (const keyword of COMBINATOR_KEYWORDS) {
    for (const branch of subSchemaItems(schema[keyword])) {
      enforceStrictOpenAiSchema(branch);
    }
  }
  const items = schema['items'];
  if (isJsonObject(items)) {
    enforceStrictOpenAiSchema(items);
  }
}
