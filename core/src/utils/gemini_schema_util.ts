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

/** A JSON-Schema-like node as it appears in an MCP tool declaration. */
interface McpSchemaNode {
  type?: string | unknown[];
  anyOf?: unknown[];
  properties?: Record<string, unknown>;
  items?: unknown;
  required?: string[];
  description?: string;
  enum?: unknown[];
  const?: unknown;
  $ref?: string;
}

function isMcpSchemaNode(value: unknown): value is McpSchemaNode {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Coerces an untyped JSON-Schema fragment into a schema node. */
function toSchemaNode(value: unknown): McpSchemaNode {
  if (isMcpSchemaNode(value)) return value;
  if (typeof value === 'string') return {type: value};
  return {};
}

function toGeminiType(mcpType: McpSchemaNode['type']): Type {
  if (typeof mcpType !== 'string') return Type.TYPE_UNSPECIFIED;

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

const getTypeFromArrayItem = (item: unknown): string | undefined => {
  const {type} = toSchemaNode(item);
  return typeof type === 'string' ? type.toLowerCase() : undefined;
};

export function toGeminiSchema(mcpSchema?: MCPToolSchema): Schema | undefined {
  if (!mcpSchema) {
    return undefined;
  }

  function recursiveConvert(mcp: McpSchemaNode): Schema {
    const sourceType = mcp.anyOf ?? mcp.type;
    let isNullable = false;
    if (Array.isArray(sourceType)) {
      const nonNullTypes = sourceType.filter(
        (t) => getTypeFromArrayItem(t) !== 'null',
      );
      isNullable = sourceType.some((t) => getTypeFromArrayItem(t) === 'null');

      if (nonNullTypes.length === 1) {
        const nonNullType = nonNullTypes[0];
        if (isMcpSchemaNode(nonNullType)) {
          mcp = nonNullType;
        } else {
          const {type: _removed, anyOf: _removedAnyOf, ...rest} = mcp;
          mcp = {...rest, type: getTypeFromArrayItem(nonNullType)};
        }
      } else if (nonNullTypes.length === 0 && isNullable) {
        const {type: _removed, anyOf: _removedAnyOf, ...rest} = mcp;
        mcp = {...rest, type: 'null'};
      } else if (typeof mcp.anyOf === 'undefined') {
        const {type: _removed, ...rest} = mcp;
        mcp = {...rest, anyOf: sourceType};
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
        const enumTypes = new Set(mcp.enum.map((v) => typeof v));
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
      geminiSchema.anyOf = mcp.anyOf.map((item) =>
        recursiveConvert(toSchemaNode(item)),
      );
    } else {
      geminiSchema.type = geminiType;
    }

    if (mcp.description) {
      geminiSchema.description = mcp.description;
    }

    if (mcp.enum) {
      geminiSchema.enum = mcp.enum.map(String);
    }

    if (isNullable && mcp.type !== 'null') {
      geminiSchema.nullable = true;
    }

    if (geminiType === Type.OBJECT) {
      geminiSchema.properties = {};
      if (mcp.properties) {
        for (const name in mcp.properties) {
          geminiSchema.properties[name] = recursiveConvert(
            toSchemaNode(mcp.properties[name]),
          );
        }
      }
      if (mcp.required) {
        geminiSchema.required = mcp.required;
      }
    } else if (geminiType === Type.ARRAY) {
      if (mcp.items) {
        geminiSchema.items = recursiveConvert(toSchemaNode(mcp.items));
      }
    }
    return geminiSchema;
  }
  return recursiveConvert(mcpSchema);
}
