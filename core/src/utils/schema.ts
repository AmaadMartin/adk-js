/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A single, reusable abstraction over the schema formats ADK APIs accept: a Zod
 * v3 type, a Zod v4 type, or a genai `Schema`. Mirrors the union
 * `FunctionTool` uses for its parameters, but at the `ZodType` level (any
 * schema, not just an object) so it also fits value validation.
 */

import {Schema} from '@google/genai';
import {zodToJsonSchema as toJSONSchemaV3} from 'zod-to-json-schema';
import {z as z3} from 'zod/v3';
import {toJSONSchema as toJSONSchemaV4, z as z4} from 'zod/v4';

import {genaiSchemaToJsonSchema} from './genai_schema_to_json.js';
import {
  isZodSchema,
  isZodV3Schema,
  isZodV4Schema,
} from './simple_zod_to_json.js';

/**
 * A schema accepted by ADK APIs, expressed as a Zod v3 type, a Zod v4 type, or
 * a genai `Schema`.
 *
 * Use `parseWithSchema` to validate a value against one, and `toJsonSchema` to
 * render one as a plain JSON Schema.
 */
export type SchemaLike = z3.ZodType | z4.ZodType | Schema;

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
 * Compiled validators for genai `Schema` objects, keyed by the schema itself.
 *
 * Compiling a schema means converting it to JSON Schema and building a Zod
 * type from it, which is far too costly to repeat per validated value — a node
 * validates its input and output on every single run. Schemas are long-lived
 * (an agent or node holds one for its lifetime) and callers pass the same
 * object each time, so a `WeakMap` keyed on the schema caches the compilation
 * for exactly as long as the schema is reachable.
 *
 * A schema that cannot be compiled caches `null`, so a malformed schema costs
 * one failed conversion rather than one per value.
 */
const genaiValidators = new WeakMap<Schema, z4.ZodType | null>();

/**
 * Returns a Zod validator for a genai `Schema`, or `undefined` if the schema
 * cannot be expressed as one.
 *
 * A genai `Schema` reaching a validator is not necessarily hand-written — it is
 * often the result of `zodObjectToSchema`, or came off the wire from a tool
 * declaration — so it can contain constructs Zod has no equivalent for. Those
 * are treated as "unvalidatable" rather than as a failure: refusing to run the
 * value would reject data that is perfectly valid, which is worse than the
 * pre-existing behaviour of not checking it at all.
 */
function genaiSchemaValidator(schema: Schema): z4.ZodType | undefined {
  const cached = genaiValidators.get(schema);
  if (cached !== undefined) {
    return cached ?? undefined;
  }
  let validator: z4.ZodType | null = null;
  try {
    // `fromJSONSchema` is documented as semi-experimental, so a schema it
    // cannot ingest must degrade to "unvalidated" rather than propagate.
    validator = z4.fromJSONSchema(
      genaiSchemaToJsonSchema(schema) as Parameters<
        typeof z4.fromJSONSchema
      >[0],
    );
  } catch {
    validator = null;
  }
  genaiValidators.set(schema, validator);
  return validator ?? undefined;
}

/**
 * Validates `value` against `schema`, returning the parsed value.
 *
 * Every schema form ADK accepts is enforced:
 *
 * - Zod v3/v4: runs `schema.parse(value)`.
 * - genai `Schema`: converted to JSON Schema and compiled to a Zod type once
 *   (then cached), so a declaration written in the genai dialect is checked
 *   just as a Zod one is.
 * - `undefined`: returns `value` unchanged.
 *
 * A genai `Schema` that has no Zod equivalent is left unenforced rather than
 * rejected — see {@link genaiSchemaValidator}.
 */
export function parseWithSchema<T>(
  schema: SchemaLike | undefined,
  value: T,
): T {
  if (schema === undefined) {
    return value;
  }
  if (isZodSchema(schema)) {
    return schema.parse(value) as T;
  }
  const validator = genaiSchemaValidator(schema as Schema);
  return validator ? (validator.parse(value) as T) : value;
}

/**
 * Renders a {@link SchemaLike} as a plain JSON Schema object.
 *
 * Zod v3 and v4 schemas are converted with their respective serializers. A
 * genai `Schema` is translated out of the genai/OpenAPI dialect (uppercase
 * type names, stringified bounds, `nullable`) so that every schema form
 * produces the same JSON Schema shape for a consumer to read.
 */
export function toJsonSchema(schema: SchemaLike): Record<string, unknown> {
  if (isZodV4Schema(schema)) {
    return toJSONSchemaV4(schema) as Record<string, unknown>;
  }
  if (isZodV3Schema(schema)) {
    return toJSONSchemaV3(schema) as Record<string, unknown>;
  }
  return genaiSchemaToJsonSchema(schema as Schema);
}

/**
 * Compiles a plain JSON Schema into a validator, for schemas that survive only
 * in serialized form — a `RequestInput.responseSchema` reaches the resume that
 * answers it as the JSON Schema recorded on the interrupt event, not as the
 * original {@link SchemaLike}.
 *
 * Returns `undefined` when the schema cannot be compiled (JSON Schema is wider
 * than Zod can express). Callers treat that as "no contract to check" rather
 * than failing: refusing data because we could not build the validator would be
 * worse than the unchecked pass-through this replaces.
 */
export function compileJsonSchema(jsonSchema: unknown): z4.ZodType | undefined {
  if (jsonSchema === null || typeof jsonSchema !== 'object') {
    return undefined;
  }
  try {
    return z4.fromJSONSchema(jsonSchema as Record<string, unknown>);
  } catch {
    return undefined;
  }
}

/**
 * Per-field validators for object schemas, keyed by the schema itself. Built
 * once per schema for the same reason {@link genaiValidators} exists: a schema
 * outlives the values checked against it.
 */
const objectFieldValidators = new WeakMap<
  object,
  Map<string, z4.ZodType | undefined> | null
>();

/**
 * Decomposes an object {@link SchemaLike} into its declared fields, each mapped
 * to a validator for that field alone.
 *
 * This is what lets a *partial* object be checked key by key. A state schema
 * declares the keys a workflow may write, but the state holds only the ones
 * written so far, so validating the whole object against the schema would
 * reject it for missing fields that simply have not been set yet.
 *
 * Returns `undefined` when the schema is not an object schema or cannot be
 * decomposed, and maps a field to `undefined` when that field's own schema has
 * no Zod equivalent. Both mean "unvalidatable" rather than invalid, consistent
 * with {@link parseWithSchema}.
 */
export function objectSchemaFields(
  schema: SchemaLike,
): Map<string, z4.ZodType | undefined> | undefined {
  const cached = objectFieldValidators.get(schema as object);
  if (cached !== undefined) {
    return cached ?? undefined;
  }
  let fields: Map<string, z4.ZodType | undefined> | null = null;
  try {
    const document = toJsonSchema(schema);
    const properties = document['properties'];
    if (properties && typeof properties === 'object') {
      fields = new Map(
        Object.entries(properties as Record<string, unknown>).map(
          ([name, fieldSchema]) => [name, compileField(fieldSchema, document)],
        ),
      );
    }
  } catch {
    fields = null;
  }
  objectFieldValidators.set(schema as object, fields);
  return fields ?? undefined;
}

/** Sentinel for a `$ref` that cannot be inlined; caught per field. */
const UNRESOLVABLE_REF = Symbol('unresolvable-ref');

/**
 * Compiles one field of a schema document into a validator, resolving any
 * `$ref` it carries against that document first.
 *
 * A field whose refs cannot be inlined degrades to `undefined` — unvalidated —
 * on its own, rather than costing the other fields their validators.
 */
function compileField(
  fieldSchema: unknown,
  document: unknown,
): z4.ZodType | undefined {
  try {
    return compileJsonSchema(inlineRefs(fieldSchema, document));
  } catch {
    return undefined;
  }
}

/**
 * Resolves a local JSON Pointer (`#/properties/foo`) against `document`.
 */
function resolvePointer(document: unknown, ref: string): unknown {
  if (!ref.startsWith('#')) {
    throw UNRESOLVABLE_REF;
  }
  let node: unknown = document;
  for (const rawSegment of ref.slice(1).split('/').filter(Boolean)) {
    const segment = decodeURIComponent(rawSegment)
      .replaceAll('~1', '/')
      .replaceAll('~0', '~');
    if (node === null || typeof node !== 'object') {
      throw UNRESOLVABLE_REF;
    }
    node = (node as Record<string, unknown>)[segment];
  }
  if (node === undefined) {
    throw UNRESOLVABLE_REF;
  }
  return node;
}

/**
 * Replaces every local `$ref` in `node` with the schema it points at.
 *
 * A field is compiled on its own, detached from the document that defines it,
 * so a `$ref` in it would dangle. Zod v4 inlines repeated sub-schemas and never
 * emits one, but `zod-to-json-schema` (Zod v3) points the second use of a
 * shared sub-schema back at the first — `{"$ref": "#/properties/nested"}` — and
 * an uninlined field silently loses its type check.
 *
 * A ref that cannot be resolved, and a cycle (`z.lazy` recursion, which has no
 * finite inlining), throw {@link UNRESOLVABLE_REF}; the caller degrades that
 * field to unvalidated.
 */
function inlineRefs(
  node: unknown,
  document: unknown,
  seen: ReadonlySet<string> = new Set(),
): unknown {
  if (Array.isArray(node)) {
    return node.map((item) => inlineRefs(item, document, seen));
  }
  if (node === null || typeof node !== 'object') {
    return node;
  }
  const entries = Object.entries(node as Record<string, unknown>);
  const ref = (node as Record<string, unknown>)['$ref'];
  if (typeof ref === 'string') {
    if (seen.has(ref)) {
      throw UNRESOLVABLE_REF;
    }
    const target = inlineRefs(
      resolvePointer(document, ref),
      document,
      new Set([...seen, ref]),
    );
    const siblings = Object.fromEntries(
      entries.filter(([key]) => key !== '$ref'),
    );
    return {...(target as Record<string, unknown>), ...siblings};
  }
  return Object.fromEntries(
    entries.map(([key, value]) => [key, inlineRefs(value, document, seen)]),
  );
}
