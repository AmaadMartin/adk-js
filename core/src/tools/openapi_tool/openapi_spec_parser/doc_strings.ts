/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {OpenAPIV3} from 'openapi-types';
import type {ApiParameter} from './operation_parser.js';

/** The TypeScript type name each OpenAPI scalar type maps onto. */
const SCALAR_TYPE_HINTS = new Map([
  ['string', 'string'],
  ['integer', 'number'],
  ['number', 'number'],
  ['boolean', 'boolean'],
  ['object', 'Record<string, unknown>'],
]);

/** The type name used for a schema this mapping does not cover. */
const UNKNOWN_TYPE_HINT = 'unknown';

/** Indent of an object property line inside an argument's documentation. */
const PARAM_PROPERTY_INDENT = ' '.repeat(7);

/** Indent of an object property line inside the return documentation. */
const RETURN_PROPERTY_INDENT = ' '.repeat(8);

/**
 * The order a response status sorts in. Numeric statuses sort ascending and
 * before the non-numeric ones OpenAPI also allows, such as `default` and
 * `2XX`.
 */
function statusOrder(status: string): number {
  return /^\d+$/.test(status) ? Number(status) : Number.POSITIVE_INFINITY;
}

/**
 * Replaces a `$ref` with an empty schema. The spec reaches the parser already
 * resolved, so an unresolved reference carries no type to describe.
 */
function schemaOrEmpty(
  schema: OpenAPIV3.ReferenceObject | OpenAPIV3.SchemaObject | undefined,
): OpenAPIV3.SchemaObject {
  return !schema || '$ref' in schema ? {} : schema;
}

/**
 * Documents the properties of an object schema, one indented line each.
 * Returns an empty string for any other schema.
 */
function objectPropertiesDoc(
  schema: OpenAPIV3.SchemaObject,
  indent: string,
): string {
  const properties = schema.type === 'object' ? (schema.properties ?? {}) : {};
  const names = Object.keys(properties);
  if (names.length === 0) {
    return '';
  }
  let doc = ' Object properties:\n';
  for (const name of names) {
    const property = schemaOrEmpty(properties[name]);
    const description = property.description ?? '';
    doc += `${indent}${name} (${typeHint(property)}): ${description}\n`;
  }
  return doc;
}

/**
 * Returns the TypeScript type name that describes an OpenAPI schema.
 *
 * @param schema The schema to describe.
 * @returns A TypeScript type name, or `unknown` when the schema declares no
 *   type this mapping covers.
 */
export function typeHint(schema: OpenAPIV3.SchemaObject): string {
  if (schema.type === 'array') {
    const items = schemaOrEmpty(schema.items);
    return `Array<${SCALAR_TYPE_HINTS.get(items.type ?? '') ?? UNKNOWN_TYPE_HINT}>`;
  }
  return SCALAR_TYPE_HINTS.get(schema.type ?? '') ?? UNKNOWN_TYPE_HINT;
}

/**
 * Documents one tool argument, so the model learns its name, type and purpose.
 *
 * @param param The parsed parameter to document.
 * @returns The documentation line, plus a property block for an object schema.
 */
export function generateParamDoc(param: ApiParameter): string {
  const description = (param.description ?? '').trim();
  const doc = `${param.name} (${typeHint(param.paramSchema)}): ${description}`;
  return doc + objectPropertiesDoc(param.paramSchema, PARAM_PROPERTY_INDENT);
}

/**
 * Documents what an operation returns, taking the 2xx response with the
 * smallest status code that carries content.
 *
 * @param responses The responses the operation declares.
 * @returns The return documentation, or an empty string when no 2xx response
 *   carries content.
 */
export function generateReturnDoc(
  responses: OpenAPIV3.ResponsesObject,
): string {
  const sorted = Object.entries(responses).sort(
    ([left], [right]) => statusOrder(left) - statusOrder(right),
  );

  for (const [status, response] of sorted) {
    if (!status.startsWith('2') || '$ref' in response) {
      continue;
    }
    const content = response.content ?? {};
    if (Object.keys(content).length === 0) {
      continue;
    }
    const mediaType = content['application/json'] ?? Object.values(content)[0];
    const schema = schemaOrEmpty(mediaType.schema);
    const description = (response.description ?? '').trim();
    return (
      `Returns (${typeHint(schema)}): ${description}` +
      objectPropertiesDoc(schema, RETURN_PROPERTY_INDENT)
    );
  }
  return '';
}
