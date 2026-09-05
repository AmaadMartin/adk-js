/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {FunctionDeclaration, Schema, Type} from '@google/genai';
import {z as z3} from 'zod/v3';
import {z as z4} from 'zod/v4';

import {
  formatSchemaValidationError,
  parseWithSchema,
  SchemaLike,
  toJsonSchema,
} from '../utils/schema.js';
import {
  isZodObject,
  isZodV3Schema,
  isZodV4Schema,
  zodObjectToSchema,
} from '../utils/simple_zod_to_json.js';
import {BaseTool, RunAsyncToolRequest} from './base_tool.js';

/** The name the model calls to return its structured answer. */
export const SET_MODEL_RESPONSE_TOOL_NAME = 'set_model_response';

const SET_MODEL_RESPONSE_TOOL_DESCRIPTION =
  'Call this tool to submit your final response conforming to the output' +
  ' schema. Use this tool only when you have collected all the information' +
  ' and are ready to return the final answer.';

const RETRY_INSTRUCTION =
  'Recall the set_model_response function correctly, fix the errors, and call' +
  ' it again with all required fields using the correct types.';

/**
 * The parameter a non-object schema is carried under. The GenAI API only
 * accepts object-typed parameters, so a list or a primitive needs a name. The
 * two names are wire-observable and match adk-python.
 */
type WrapperKey = 'items' | 'response';

/** Whether a JSON Schema node describes an object. */
function isObjectSchema(node: unknown): boolean {
  return (
    typeof node === 'object' &&
    node !== null &&
    (node as {type?: unknown}).type === 'object'
  );
}

/** Whether a schema is a genai `Schema` rather than a Zod type. */
function isGenaiSchema(schema: SchemaLike): schema is Schema {
  return !isZodV3Schema(schema) && !isZodV4Schema(schema);
}

/**
 * Returns the wrapper parameter a schema needs, or `undefined` when the schema
 * is already an object and its fields can be the parameters directly.
 *
 * An array of objects uses `items` and everything else uses `response`, which
 * is the distinction adk-python draws between `list[BaseModel]` and
 * `list[str]` / `dict[str, int]`.
 */
function wrapperKeyFor(schema: SchemaLike): WrapperKey | undefined {
  if (isZodObject(schema)) {
    return undefined;
  }
  if (isGenaiSchema(schema) && schema.type === Type.OBJECT) {
    return undefined;
  }
  const document = toJsonSchema(schema);
  return document['type'] === 'array' && isObjectSchema(document['items'])
    ? 'items'
    : 'response';
}

/**
 * Builds the declaration parameters for a schema, wrapping it under
 * `wrapperKey` when it is not an object schema.
 */
function buildParameters(
  schema: SchemaLike,
  wrapperKey: WrapperKey | undefined,
): Schema {
  if (wrapperKey === undefined) {
    return isZodObject(schema) ? zodObjectToSchema(schema) : (schema as Schema);
  }
  // Wrapping in a Zod object of the same major version keeps the field's
  // descriptions, defaults and nested items, which a hand-built genai wrapper
  // would have to re-derive.
  if (isZodV4Schema(schema)) {
    return zodObjectToSchema(z4.object({[wrapperKey]: schema}));
  }
  if (isZodV3Schema(schema)) {
    return zodObjectToSchema(z3.object({[wrapperKey]: schema}));
  }
  return {
    type: Type.OBJECT,
    properties: {[wrapperKey]: schema},
    required: [wrapperKey],
  };
}

/**
 * The tool an agent calls to return structured output on a model that cannot
 * accept an output schema and tools in the same request.
 *
 * The agent's output schema becomes the tool's parameters, so the model fills
 * the schema in as a function call. The tool validates those arguments, and
 * publishes the validated value on `actions.setModelResponse` for the agent to
 * promote into its final response. A call that fails validation returns an
 * error message naming the offending fields instead, so the model can correct
 * itself and call again.
 *
 * Ported from `google/adk-python`
 * `tools/set_model_response_tool.py::SetModelResponseTool`.
 */
export class SetModelResponseTool extends BaseTool {
  /** The schema the model's arguments are validated against. */
  private readonly outputSchema: SchemaLike;

  /**
   * The parameter the value is carried under, or `undefined` when the schema is
   * an object and its fields are the parameters.
   */
  private readonly wrapperKey?: WrapperKey;

  /** The declaration parameters, resolved once so they are stable per turn. */
  private readonly parameters: Schema;

  constructor(outputSchema: SchemaLike) {
    super({
      name: SET_MODEL_RESPONSE_TOOL_NAME,
      description: SET_MODEL_RESPONSE_TOOL_DESCRIPTION,
    });
    this.outputSchema = outputSchema;
    this.wrapperKey = wrapperKeyFor(outputSchema);
    this.parameters = buildParameters(outputSchema, this.wrapperKey);
  }

  override _getDeclaration(): FunctionDeclaration {
    return {
      name: this.name,
      description: this.description,
      parameters: this.parameters,
    };
  }

  override async runAsync({
    args,
    toolContext,
  }: RunAsyncToolRequest): Promise<unknown> {
    let validated: unknown;
    try {
      validated = parseWithSchema(this.outputSchema, this.unwrap(args));
    } catch (error: unknown) {
      return {
        error:
          `Validation Error found:\n${formatSchemaValidationError(error)}\n` +
          RETRY_INSTRUCTION,
      };
    }
    toolContext.actions.setModelResponse = validated;
    return validated;
  }

  /** Extracts the value the model supplied from the call's arguments. */
  private unwrap(args: Record<string, unknown>): unknown {
    if (this.wrapperKey === undefined) {
      return args;
    }
    // adk-python reads `args.get('items', [])`, so an omitted list is empty
    // rather than a validation failure.
    if (this.wrapperKey === 'items') {
      return args['items'] ?? [];
    }
    return args['response'];
  }
}
