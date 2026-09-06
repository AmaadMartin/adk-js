/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Schema, Type} from '@google/genai';

/** A JSON Schema object, as produced by an MCP server or an OpenAPI spec. */
type JsonSchemaObject = {[key: string]: unknown};
type MCPTypeArrayItem = string | {type: string};

/**
 * `format` values the Gemini API accepts, keyed by the JSON Schema type that
 * carries them.
 *
 * This is narrower than the set the genai `Schema.format` doc comment lists,
 * because the backend rejects the rest. It mirrors
 * `_sanitize_schema_formats_for_gemini` in adk-python's
 * `tools/_gemini_schema_util.py`, including the two rows that read oddly: a
 * `number` keeps `int32`/`int64` and loses `float`/`double`, and a node with no
 * type keeps no format at all.
 */
const SUPPORTED_FORMATS: Readonly<Record<string, readonly string[]>> = {
  integer: ['int32', 'int64'],
  number: ['int32', 'int64'],
  string: ['date-time', 'enum'],
};

/**
 * Bounds that JSON Schema carries as numbers and genai carries as strings.
 * The inverse list lives in `genai_schema_to_json.ts`.
 */
const NUMERIC_STRING_KEYS = [
  'minLength',
  'maxLength',
  'minItems',
  'maxItems',
  'minProperties',
  'maxProperties',
] as const;

function isSupportedFormat(type: unknown, format: unknown): format is string {
  if (typeof type !== 'string' || typeof format !== 'string') {
    return false;
  }
  return SUPPORTED_FORMATS[type]?.includes(format) ?? false;
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === 'string')
  );
}

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

export function toGeminiSchema(
  mcpSchema?: JsonSchemaObject,
): Schema | undefined {
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

    // Evaluated after the nullable unwrap above, so `{type: ['string',
    // 'null'], format: 'date-time'}` keeps its format. adk-python tests the
    // raw type and drops it.
    if (isSupportedFormat(mcp.type, mcp.format)) {
      geminiSchema.format = mcp.format;
    }

    if (typeof mcp.pattern === 'string') {
      geminiSchema.pattern = mcp.pattern;
    }

    if (typeof mcp.minimum === 'number') {
      geminiSchema.minimum = mcp.minimum;
    }

    if (typeof mcp.maximum === 'number') {
      geminiSchema.maximum = mcp.maximum;
    }

    for (const key of NUMERIC_STRING_KEYS) {
      if (typeof mcp[key] === 'number') {
        geminiSchema[key] = String(mcp[key]);
      }
    }

    if (isStringArray(mcp.propertyOrdering)) {
      geminiSchema.propertyOrdering = mcp.propertyOrdering;
    }

    if (mcp.default !== undefined) {
      geminiSchema.default = mcp.default;
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
