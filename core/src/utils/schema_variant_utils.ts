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
