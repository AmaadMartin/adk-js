/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Schema, Type} from '@google/genai';
import type {Tool} from '@modelcontextprotocol/sdk/types.js';

import {NUMERIC_STRING_KEYS} from '../../utils/genai_schema_to_json.js';
import {BaseTool} from '../base_tool.js';

/**
 * Keys copied straight through, under the same name, whatever their value.
 */
const DIRECT_KEYS = [
  'title',
  'description',
  'default',
  'enum',
  'format',
  'example',
] as const;

/** A genai key that carries a stringified bound, converted with `Number`. */
type NumericStringKey = (typeof NUMERIC_STRING_KEYS)[number];

/** Reports whether `value` is a non-null, non-array object. */
function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Narrows a JSON document to the object schema MCP requires. */
function isObjectSchemaDocument(value: unknown): value is Tool['inputSchema'] {
  return isJsonObject(value) && value['type'] === 'object';
}

/**
 * Rejects a value that is not a schema object, as adk-python does.
 *
 * The check lives in its own function so that narrowing `Schema` against an
 * index signature does not erase the field types the converter relies on.
 */
function assertSchemaObject(schema: Schema): void {
  if (!isJsonObject(schema)) {
    throw new TypeError(
      `Input must be a Schema object, got ${JSON.stringify(schema)}.`,
    );
  }
}

/** Copies each named key into `out` when the source schema defines it. */
function copyDefined(
  out: Record<string, unknown>,
  schema: Schema,
  keys: readonly (keyof Schema)[],
): void {
  for (const key of keys) {
    const value = schema[key];
    if (value !== undefined) {
      out[key] = value;
    }
  }
}

/** Copies each named key into `out` as a number when the source defines it. */
function copyNumeric(
  out: Record<string, unknown>,
  schema: Schema,
  keys: readonly NumericStringKey[],
): void {
  for (const key of keys) {
    const value = schema[key];
    if (value !== undefined) {
      out[key] = Number(value);
    }
  }
}

/**
 * Converts a genai `Schema` into a JSON Schema document.
 *
 * This is the MCP wire-format converter: it keeps the genai spellings that an
 * MCP client understands (`nullable: true`, `format: 'enum'`, `example`) and
 * drops constraints that do not apply to the declared type. It is a port of
 * `gemini_to_json_schema` in adk-python.
 *
 * `genaiSchemaToJsonSchema` in `core/src/utils/genai_schema_to_json.ts` maps the
 * same direction but answers to a different contract: its output feeds a Zod
 * validator, so it widens `nullable` into a type union and drops `format:
 * 'enum'` and `example`. Reach for that one when building a validator, and for
 * this one when serving an MCP client.
 *
 * @param schema The genai schema to convert.
 * @returns A plain JSON Schema document. The input is never mutated.
 * @throws TypeError If `schema` is not an object. TypeScript is structurally
 *   typed, so any object literal is a valid `Schema` and this check is narrower
 *   than the `isinstance` check in adk-python; it guards JavaScript callers and
 *   JSON-sourced input, which the compiler does not check.
 */
export function geminiToJsonSchema(schema: Schema): Record<string, unknown> {
  assertSchemaObject(schema);

  const out: Record<string, unknown> = {};
  const type = schema.type;
  out['type'] =
    type !== undefined && type !== Type.TYPE_UNSPECIFIED
      ? type.toLowerCase()
      : 'null';

  if (schema.nullable === true) {
    out['nullable'] = true;
  }

  copyDefined(out, schema, DIRECT_KEYS);

  switch (type) {
    case Type.STRING:
      copyDefined(out, schema, ['pattern']);
      copyNumeric(out, schema, ['minLength', 'maxLength']);
      break;
    case Type.NUMBER:
    case Type.INTEGER:
      copyDefined(out, schema, ['minimum', 'maximum']);
      break;
    case Type.ARRAY:
      if (schema.items !== undefined) {
        out['items'] = geminiToJsonSchema(schema.items);
      }
      copyNumeric(out, schema, ['minItems', 'maxItems']);
      break;
    case Type.OBJECT:
      if (schema.properties !== undefined) {
        out['properties'] = Object.fromEntries(
          Object.entries(schema.properties).map(([name, property]) => [
            name,
            geminiToJsonSchema(property),
          ]),
        );
      }
      copyDefined(out, schema, ['required']);
      copyNumeric(out, schema, ['minProperties', 'maxProperties']);
      break;
  }

  if (schema.anyOf !== undefined) {
    out['anyOf'] = schema.anyOf.map((subSchema) =>
      geminiToJsonSchema(subSchema),
    );
  }

  return out;
}

/**
 * Turns a resolved parameter document into an MCP `inputSchema`.
 *
 * @throws TypeError If the document is not an object schema.
 */
function toInputSchema(
  document: unknown,
  toolName: string,
): Tool['inputSchema'] {
  const filled =
    isJsonObject(document) && document['type'] === undefined
      ? {...document, type: 'object'}
      : document;
  if (!isObjectSchemaDocument(filled)) {
    const reported = isJsonObject(document) ? document['type'] : document;
    throw new TypeError(
      `Tool "${toolName}" declares parameters of type ` +
        `${JSON.stringify(reported)}; an MCP tool must declare an object ` +
        `schema.`,
    );
  }
  return filled;
}

/**
 * Converts an ADK tool into an MCP `Tool` descriptor.
 *
 * Use it to serve ADK tools *from* an MCP server: answer a `tools/list` request
 * with ADK's own declarations. It is the opposite direction to `MCPTool` and
 * `MCPToolset`, which consume a remote MCP server. It is a port of
 * `adk_to_mcp_tool_type` in adk-python.
 *
 * `inputSchema.type` is always the literal `'object'`, because the MCP
 * TypeScript SDK's `ToolSchema` rejects anything else. adk-python emits an
 * empty document for a tool that takes no parameters; the empty object schema
 * used here is the same unconstrained object to an MCP client.
 *
 * @param tool The ADK tool to convert.
 * @returns The MCP tool descriptor, which satisfies the SDK's `ToolSchema`.
 * @throws TypeError If the tool declares parameters that are not an object
 *   schema, which an MCP client would reject at the far end of the wire.
 *
 * @example
 * ```typescript
 * server.setRequestHandler(ListToolsRequestSchema, async () => ({
 *   tools: myAdkTools.map(adkToMcpToolType),
 * }));
 * ```
 */
export function adkToMcpToolType(tool: BaseTool): Tool {
  const declaration = tool._getDeclaration();
  let inputSchema: Tool['inputSchema'] = {type: 'object'};
  if (declaration?.parametersJsonSchema !== undefined) {
    inputSchema = toInputSchema(declaration.parametersJsonSchema, tool.name);
  } else if (declaration?.parameters !== undefined) {
    inputSchema = toInputSchema(
      geminiToJsonSchema(declaration.parameters),
      tool.name,
    );
  }
  return {name: tool.name, description: tool.description, inputSchema};
}
