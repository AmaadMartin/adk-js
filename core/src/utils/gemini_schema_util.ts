/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Schema, Type} from '@google/genai';
import {camelCase} from './case_utils.js';
import {NUMERIC_STRING_KEYS} from './genai_schema_to_json.js';

type MCPToolSchema = {
  type: 'object';
  properties?: Record<string, unknown>;
  required?: string[];
};
type MCPTypeArrayItem = string | {type: string};

function toGeminiType(mcpType: string | undefined): Type {
  if (!mcpType) return Type.TYPE_UNSPECIFIED;

  switch (mcpType.toLowerCase()) {
    case 'text':
    case 'string':
      return Type.STRING;
    case 'number':
      return Type.NUMBER;
    case 'boolean':
      return Type.BOOLEAN;
    case 'integer':
      return Type.INTEGER;
    case 'array':
      return Type.ARRAY;
    case 'object':
      return Type.OBJECT;
    case 'null':
      return Type.NULL;
    default:
      return Type.TYPE_UNSPECIFIED;
  }
}

const getTypeFromArrayItem = (
  mcpType: MCPTypeArrayItem,
): string | undefined => {
  if (typeof mcpType === 'string') {
    return mcpType.toLowerCase();
  }
  return mcpType?.type?.toLowerCase?.();
};

export function toGeminiSchema(mcpSchema?: MCPToolSchema): Schema | undefined {
  if (!mcpSchema) {
    return undefined;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function recursiveConvert(mcp: any): Schema {
    const sourceType = mcp.anyOf ?? mcp.type;
    let isNullable = false;
    let nonNullTypes;
    if (Array.isArray(sourceType)) {
      nonNullTypes = sourceType.filter(
        (t: MCPTypeArrayItem) => getTypeFromArrayItem(t) !== 'null',
      );
      isNullable = sourceType.some(
        (t: MCPTypeArrayItem) => getTypeFromArrayItem(t) === 'null',
      );

      if (nonNullTypes.length === 1) {
        const nonNullType = nonNullTypes[0];
        if (typeof nonNullType === 'object') {
          mcp = nonNullType;
        } else {
          const {type: _removed, anyOf: _removedAnyOf, ...rest} = mcp;
          mcp = {...rest, type: nonNullType};
        }
      } else if (nonNullTypes.length === 0 && isNullable) {
        const {type: _removed, anyOf: _removedAnyOf, ...rest} = mcp;
        mcp = {...rest, type: 'null'};
      } else if (typeof mcp.anyOf === 'undefined') {
        const anyOfItems = mcp.type.map((t: MCPTypeArrayItem) => ({type: t}));
        const {type: _removed, ...rest} = mcp;
        mcp = {...rest, anyOf: anyOfItems};
      }
    }

    // Infer unknown types
    if (!mcp.type) {
      if (mcp.properties || mcp.$ref) {
        mcp.type = 'object';
      } else if (mcp.items) {
        mcp.type = 'array';
      } else if (isNullable) {
        mcp.type = 'null';
      } else if (mcp.enum) {
        // enum-only schema: infer type from enum values if all are the same
        // primitive type, otherwise leave type undefined (TYPE_UNSPECIFIED)
        const enumTypes = new Set((mcp.enum as unknown[]).map((v) => typeof v));
        if (enumTypes.size === 1) {
          const jsType = [...enumTypes][0];
          if (jsType === 'string') mcp.type = 'string';
          else if (jsType === 'number') mcp.type = 'number';
          else if (jsType === 'boolean') mcp.type = 'boolean';
        }
      } else if (mcp.const !== undefined) {
        // const-only schema: infer type from the const value and forward as
        // a single-element enum so the constraint is preserved in Gemini schema
        const jsType = typeof mcp.const;
        let inferredType: string | undefined;
        if (jsType === 'string') inferredType = 'string';
        else if (jsType === 'number') inferredType = 'number';
        else if (jsType === 'boolean') inferredType = 'boolean';
        mcp = {...mcp, type: inferredType, enum: [mcp.const]};
      }
    }

    const geminiType = toGeminiType(mcp.type);
    const geminiSchema: Schema = {};

    if (mcp.anyOf) {
      geminiSchema.anyOf = mcp.anyOf.map((item: Record<string, unknown>) =>
        recursiveConvert(item),
      );
    } else {
      geminiSchema.type = geminiType;
    }

    if (mcp.description) {
      geminiSchema.description = mcp.description;
    }

    if (mcp.enum) {
      geminiSchema.enum = (mcp.enum as unknown[]).map(String);
    }

    if (isNullable && mcp.type !== 'null') {
      geminiSchema.nullable = true;
    }

    if (geminiType === Type.OBJECT) {
      geminiSchema.properties = {};
      if (mcp.properties) {
        for (const name in mcp.properties) {
          geminiSchema.properties[name] = recursiveConvert(
            mcp.properties[name],
          );
        }
      }
      if (mcp.required) {
        geminiSchema.required = mcp.required;
      }
    } else if (geminiType === Type.ARRAY) {
      if (mcp.items) {
        geminiSchema.items = recursiveConvert(mcp.items);
      }
    }
    return geminiSchema;
  }
  return recursiveConvert(mcpSchema);
}

/**
 * Fields the genai `Schema` declares. `jsonSchemaToGeminiSchema` drops every
 * other key, because the Gemini API rejects a declaration that carries a
 * keyword it does not model.
 *
 * The `satisfies` clause fails the build if `@google/genai` renames or removes
 * one of these fields.
 */
const SUPPORTED_SCHEMA_FIELDS: ReadonlySet<string> = new Set([
  'anyOf',
  'default',
  'description',
  'enum',
  'example',
  'format',
  'items',
  'maxItems',
  'maxLength',
  'maxProperties',
  'maximum',
  'minItems',
  'minLength',
  'minProperties',
  'minimum',
  'nullable',
  'pattern',
  'properties',
  'propertyOrdering',
  'required',
  'title',
  'type',
] satisfies readonly (keyof Schema)[]);

/** `format` values genai accepts, keyed by the JSON Schema type they apply to. */
const SUPPORTED_FORMATS: Readonly<Record<string, readonly string[]>> = {
  integer: ['int32', 'int64'],
  number: ['int32', 'int64'],
  string: ['date-time', 'enum'],
};

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSupportedField(field: string): field is keyof Schema {
  return SUPPORTED_SCHEMA_FIELDS.has(field);
}

/**
 * Splits a JSON Schema `type` into a single type name plus a nullability flag.
 *
 * JSON Schema spells nullability as a type union (`['string', 'null']`) or as
 * the bare type `'null'`. genai has no union and no null type: it carries one
 * `type` and a separate `nullable` flag. A union keeps its first named member,
 * and a node that names nothing but null becomes a nullable object.
 */
function resolveSchemaType(rawType: unknown): {
  jsonType?: string;
  nullable: boolean;
} {
  const entries = Array.isArray(rawType) ? rawType : [rawType];
  const nullable = entries.includes('null');
  const named = entries.find(
    (entry): entry is string => typeof entry === 'string' && entry !== 'null',
  );
  if (named !== undefined) {
    return {jsonType: named, nullable};
  }
  return nullable ? {jsonType: 'object', nullable} : {nullable};
}

function isSupportedFormat(
  jsonType: string | undefined,
  format: unknown,
): format is string {
  if (jsonType === undefined || typeof format !== 'string') {
    return false;
  }
  return SUPPORTED_FORMATS[jsonType]?.includes(format) ?? false;
}

/**
 * Converts a plain JSON Schema object into a genai `Schema`.
 *
 * This is the counterpart of `genaiSchemaToJsonSchema`, and the converter an
 * OpenAPI-derived tool declaration goes through. A real OpenAPI document
 * carries keywords and `format` values that genai does not model, so the
 * conversion relaxes the input rather than rejecting it:
 *
 * - a key outside the genai `Schema` (`additionalProperties`, `allOf`, `$defs`,
 *   a vendor extension) is dropped;
 * - a `format` the declared type does not support is dropped;
 * - a type union becomes one type plus `nullable: true`;
 * - a count or length bound is stringified, which is how genai encodes it;
 * - a snake_case field name is normalized, while a property name is preserved.
 *
 * The function never throws and never mutates its argument. A node it cannot
 * make sense of degrades to an object rather than failing the whole toolset.
 *
 * `toGeminiSchema` cannot serve this path. It answers to the MCP contract: it
 * infers a missing type from `enum`, `const` or `$ref`, expands a multi-member
 * union into `anyOf`, and emits only 8 keys, so it discards `format`, `title`,
 * `default`, `pattern` and every bound an OpenAPI document declares.
 *
 * @param jsonSchema The JSON Schema object to convert.
 * @returns The equivalent genai `Schema`.
 */
export function jsonSchemaToGeminiSchema(
  jsonSchema: Record<string, unknown>,
): Schema {
  const {jsonType, nullable} = resolveSchemaType(jsonSchema['type']);
  const draft: Schema = {};

  for (const [key, value] of Object.entries(jsonSchema)) {
    if (value === null || value === undefined) {
      continue;
    }
    const field = camelCase(key);
    if (!isSupportedField(field)) {
      continue;
    }

    switch (field) {
      case 'type':
        break;
      case 'items':
        if (isJsonObject(value)) {
          draft.items = jsonSchemaToGeminiSchema(value);
        }
        break;
      case 'anyOf':
        if (Array.isArray(value)) {
          draft.anyOf = value
            .filter(isJsonObject)
            .map(jsonSchemaToGeminiSchema);
        }
        break;
      case 'properties':
        if (isJsonObject(value)) {
          draft.properties = sanitizeProperties(value);
        }
        break;
      case 'format':
        if (isSupportedFormat(jsonType, value)) {
          draft.format = value;
        }
        break;
      case 'enum':
        if (Array.isArray(value)) {
          draft.enum = value.map(String);
        }
        break;
      default:
        // The allow-list makes `field` a `keyof Schema`, but each field has its
        // own value type, so a keyed write cannot be checked against one union.
        (draft as Record<string, unknown>)[field] =
          NUMERIC_STRING_KEYS.has(field) && typeof value === 'number'
            ? String(value)
            : value;
    }
  }

  if (jsonType !== undefined) {
    draft.type = toGeminiType(jsonType);
  } else if (Object.keys(draft).length === 0) {
    draft.type = Type.OBJECT;
  }
  if (nullable) {
    draft.nullable = true;
  }
  return draft;
}

/**
 * Sanitizes each property schema, leaving the property names untouched: they
 * are the tool's argument names, not genai schema fields.
 */
function sanitizeProperties(
  properties: Record<string, unknown>,
): Record<string, Schema> {
  const sanitized: Record<string, Schema> = {};
  for (const [name, property] of Object.entries(properties)) {
    if (isJsonObject(property)) {
      sanitized[name] = jsonSchemaToGeminiSchema(property);
    }
  }
  return sanitized;
}
