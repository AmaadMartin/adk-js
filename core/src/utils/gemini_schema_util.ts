/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Schema, Type} from '@google/genai';
import {z} from 'zod';

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const MCPToolSchemaObject = z.object({
  type: z.literal('object'),
  properties: z.record(z.string(), z.unknown()).optional(),
  required: z.string().array().optional(),
});
type MCPToolSchema = z.infer<typeof MCPToolSchemaObject>;
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

/**
 * Bounds that JSON Schema counts in integers and the genai `Schema` carries as
 * strings, following the int64 encoding of the OpenAPI dialect.
 */
const STRING_ENCODED_BOUNDS = [
  'minItems',
  'maxItems',
  'minLength',
  'maxLength',
  'minProperties',
  'maxProperties',
] as const;

/** Bounds the genai `Schema` spells and types the same way JSON Schema does. */
const NUMERIC_BOUNDS = ['minimum', 'maximum'] as const;

/** String keywords the genai `Schema` spells the same way JSON Schema does. */
const STRING_KEYWORDS = ['pattern', 'title'] as const;

/** The `format` values Gemini accepts, keyed by the type of the node. */
const SUPPORTED_FORMATS: Partial<Record<Type, readonly string[]>> = {
  [Type.INTEGER]: ['int32', 'int64'],
  [Type.NUMBER]: ['int32', 'int64'],
  [Type.STRING]: ['date-time', 'enum'],
};

/** The constraint keywords a JSON Schema node may declare. */
interface ConstrainedNode {
  format?: string;
  minItems?: number;
  maxItems?: number;
  minLength?: number;
  maxLength?: number;
  minProperties?: number;
  maxProperties?: number;
  minimum?: number;
  maximum?: number;
  pattern?: string;
  title?: string;
  default?: unknown;
  propertyOrdering?: string[];
}

function isPresent<T>(value: T): value is NonNullable<T> {
  return value !== undefined && value !== null;
}

/**
 * Copies the constraint keywords a JSON Schema node declares into a genai
 * `Schema`, so the model is told what the tool will accept. A keyword outside
 * the table above stays dropped, because Gemini rejects a schema carrying a
 * keyword it does not model.
 *
 * A `format` survives only where Gemini supports it for `declaredType`, which
 * is the type the node itself declares.
 */
function forwardConstraints(node: ConstrainedNode, declaredType: Type): Schema {
  const constraints: Schema = {};

  for (const key of STRING_ENCODED_BOUNDS) {
    const value = node[key];
    if (isPresent(value)) {
      constraints[key] = String(value);
    }
  }
  for (const key of NUMERIC_BOUNDS) {
    const value = node[key];
    if (isPresent(value)) {
      constraints[key] = value;
    }
  }
  for (const key of STRING_KEYWORDS) {
    const value = node[key];
    if (isPresent(value)) {
      constraints[key] = value;
    }
  }
  if (isPresent(node.default)) {
    constraints.default = node.default;
  }
  if (isPresent(node.propertyOrdering)) {
    constraints.propertyOrdering = node.propertyOrdering;
  }
  if (
    isPresent(node.format) &&
    SUPPORTED_FORMATS[declaredType]?.includes(node.format)
  ) {
    constraints.format = node.format;
  }
  return constraints;
}

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

    // A format is licensed by the type the node declares, never by one the
    // block below infers, matching adk-python.
    const declaredType = toGeminiType(mcp.type);

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
    const geminiSchema: Schema = forwardConstraints(mcp, declaredType);

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
