/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The strict-mode JSON-schema transform the OpenAI labs models apply.
 *
 * Ported from `src/google/adk/labs/openai/_openai_schema.py` in
 * google/adk-python.
 */

import {isRecord} from '../../utils/schema.js';

/** Keywords `enforceStrictOpenAiSchema` recurses into as lists of subschemas. */
const STRICT_COMPOSITION_KEYWORDS = ['anyOf', 'oneOf', 'allOf'] as const;

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
