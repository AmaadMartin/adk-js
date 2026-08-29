/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Schema, Type} from '@google/genai';

/** The only `format` values the Gemini Developer API accepts on a number. */
const GEMINI_NUMERIC_FORMATS = new Set(['int32', 'int64']);

/** The only `format` values the Gemini Developer API accepts on a string. */
const GEMINI_STRING_FORMATS = new Set(['date-time', 'enum']);

function isFormatSupportedByGemini(
  type: Type | undefined,
  format: string,
): boolean {
  switch (type) {
    case Type.INTEGER:
    case Type.NUMBER:
      return GEMINI_NUMERIC_FORMATS.has(format);
    case Type.STRING:
      return GEMINI_STRING_FORMATS.has(format);
    default:
      return false;
  }
}

/**
 * Drops the `format` values the Gemini Developer API rejects, recursing into
 * `items`, `properties` and `anyOf`.
 *
 * The Vertex AI API accepts the wider OpenAPI `format` vocabulary, so callers
 * run this only for the `GEMINI_API` variant. A schema that survives unchanged
 * is still returned as a copy, because the caller may hold the input. Mirrors
 * adk-python's `_sanitize_schema_formats_for_gemini`.
 */
export function stripUnsupportedGeminiFormats(schema: Schema): Schema {
  const sanitized: Schema = {...schema};

  if (
    sanitized.format &&
    !isFormatSupportedByGemini(schema.type, sanitized.format)
  ) {
    delete sanitized.format;
  }
  if (sanitized.items) {
    sanitized.items = stripUnsupportedGeminiFormats(sanitized.items);
  }
  if (sanitized.properties) {
    sanitized.properties = Object.fromEntries(
      Object.entries(sanitized.properties).map(([name, property]) => [
        name,
        stripUnsupportedGeminiFormats(property),
      ]),
    );
  }
  if (sanitized.anyOf) {
    sanitized.anyOf = sanitized.anyOf.map(stripUnsupportedGeminiFormats);
  }
  return sanitized;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNullBranch(branch: unknown): boolean {
  return isJsonObject(branch) && branch['type'] === 'null';
}

/**
 * Rewrites `anyOf: [X, {type: 'null'}]` as `X` plus `nullable: true`, recursing
 * into `properties`, `items` and the surviving branches.
 *
 * Vertex AI rejects a subschema that declares no top-level `type`, and that is
 * the form Zod emits for a nullable field. A union that keeps more than one
 * non-null branch stays a union and only gains `nullable`; a union with no null
 * branch is left alone. Mirrors adk-python's `_annotate_nullable_fields`.
 *
 * Total by construction: a value it cannot interpret is copied through rather
 * than rejected, so a declaration can never fail to build here.
 */
export function flattenNullableAnyOf(
  jsonSchema: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {...jsonSchema};

  if (isJsonObject(out['items'])) {
    out['items'] = flattenNullableAnyOf(out['items']);
  }
  if (isJsonObject(out['properties'])) {
    out['properties'] = Object.fromEntries(
      Object.entries(out['properties']).map(([name, property]) => [
        name,
        isJsonObject(property) ? flattenNullableAnyOf(property) : property,
      ]),
    );
  }
  if (!Array.isArray(out['anyOf'])) {
    return out;
  }

  const branches: unknown[] = out['anyOf'].map((branch) =>
    isJsonObject(branch) ? flattenNullableAnyOf(branch) : branch,
  );
  const nonNull = branches.filter((branch) => !isNullBranch(branch));
  if (nonNull.length === branches.length) {
    out['anyOf'] = branches;
    return out;
  }

  // Only an object branch can be merged upwards; a boolean branch has no keys
  // to carry, so the union is kept rather than dropping what it allowed.
  const [survivor] = nonNull;
  if (nonNull.length === 1 && isJsonObject(survivor)) {
    delete out['anyOf'];
    return {...out, ...survivor, nullable: true};
  }
  if (nonNull.length === 0) {
    delete out['anyOf'];
    return {...out, nullable: true};
  }
  return {...out, anyOf: nonNull, nullable: true};
}
