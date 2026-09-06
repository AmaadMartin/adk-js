/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Schema, Type} from '@google/genai';
import {z} from 'zod';

import {resolvePointer} from './schema.js';

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const MCPToolSchemaObject = z.object({
  type: z.literal('object'),
  properties: z.record(z.string(), z.unknown()).optional(),
  required: z.string().array().optional(),
});
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

/** A JSON Schema node as received; any key may be present. */
type JsonSchemaNode = Record<string, unknown>;

function isJsonSchemaNode(value: unknown): value is JsonSchemaNode {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Resolves a local pointer against the schema that declared it. Returns
 * undefined when the pointer is external, dangling, or aimed at something that
 * is not a schema node.
 */
function resolveDefinition(
  document: JsonSchemaNode,
  ref: string,
): JsonSchemaNode | undefined {
  let target: unknown;
  try {
    target = resolvePointer(document, ref);
  } catch {
    // A schema off the wire is untrusted, so a pointer that does not resolve
    // degrades instead of failing the whole conversion.
    return undefined;
  }
  return isJsonSchemaNode(target) ? target : undefined;
}

function resolveRefs(
  value: unknown,
  document: JsonSchemaNode,
  pathRefs: ReadonlySet<string>,
): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => resolveRefs(item, document, pathRefs));
  }
  if (!isJsonSchemaNode(value)) {
    return value;
  }

  const ref = value['$ref'];
  // A property can legitimately be named `$ref`, in which case its value is a
  // schema and not a pointer.
  if (typeof ref !== 'string') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        resolveRefs(item, document, pathRefs),
      ]),
    );
  }

  // The set carries the refs on the current path only. A global set would
  // report a definition reused in two sibling positions as a cycle.
  if (pathRefs.has(ref)) {
    const refKey = ref.slice(ref.lastIndexOf('/') + 1);
    return {type: 'object', description: `Circular ref to ${refKey}`};
  }

  const definition = resolveDefinition(document, ref);
  if (!definition) {
    // Gemini has no `$ref`, but an unresolvable pointer stays in place so the
    // inference below still reports the node as an object. The copy keeps the
    // conversion from writing to the caller's schema.
    return {...value};
  }

  const {$ref: _ref, ...siblings} = value;
  return resolveRefs(
    {...definition, ...siblings},
    document,
    new Set([...pathRefs, ref]),
  );
}

/**
 * Inlines every resolvable local `$ref`.
 *
 * The definition blocks are dropped from the schema that is converted, and
 * pointers resolve against the original document, so a definition stays
 * reachable after its block is gone.
 */
function dereferenceSchema(schema: JsonSchemaNode): unknown {
  const {$defs: _defs, definitions: _definitions, ...body} = schema;
  return resolveRefs(body, schema, new Set<string>());
}

export function toGeminiSchema(mcpSchema?: JsonSchemaNode): Schema | undefined {
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
  return recursiveConvert(dereferenceSchema(mcpSchema));
}
