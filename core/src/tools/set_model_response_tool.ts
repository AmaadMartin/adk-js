/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {FunctionDeclaration, Schema, Type} from '@google/genai';
import {z as z3} from 'zod/v3';
import {z as z4} from 'zod/v4';

import {sanitizeSchemaFormatsForGemini} from '../utils/gemini_schema_util.js';
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
import {GoogleLLMVariant} from '../utils/variant_utils.js';
import {BaseTool, RunAsyncToolRequest} from './base_tool.js';

/** The name the model calls to return its structured answer. */
export const SET_MODEL_RESPONSE_TOOL_NAME = 'set_model_response';

/**
 * The docstring of adk-python's synthesized `set_model_response`, which is what
 * it declares as the tool description. The Python source indentation its
 * `.strip()` leaves on the second paragraph is dropped here.
 */
const SET_MODEL_RESPONSE_TOOL_DESCRIPTION =
  'Set your final response using the required output schema.\n\n' +
  'Use this tool to provide your final structured answer instead of ' +
  'outputting text directly.';

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

/** Whether the value is an object literal rather than a class instance. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Returns `value` without its `null` and `undefined` fields, recursively,
 * reproducing adk-python's `model_dump(exclude_none=True)`.
 *
 * Array entries all survive: `exclude_none` drops model fields, not list
 * entries, so a `list[str | None]` field keeps its nulls. A class instance a
 * validator produced (a `Date`, say) is returned as it is rather than rebuilt.
 * The argument is never mutated.
 */
function stripNullish(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => stripNullish(entry));
  }
  if (!isPlainObject(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => entry !== null && entry !== undefined)
      .map(([key, entry]) => [key, stripNullish(entry)]),
  );
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

  /** The declaration parameters before any variant-specific filtering. */
  private readonly parameters: Schema;

  /**
   * The parameters per variant. The variant comes from the environment and can
   * change between turns, so both forms are kept rather than one being frozen
   * at construction time.
   */
  private readonly parametersByVariant = new Map<GoogleLLMVariant, Schema>();

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
    const variant = this.apiVariant;
    const declaration: FunctionDeclaration = {
      name: this.name,
      description: this.description,
      parameters: this.parametersFor(variant),
    };
    if (variant === GoogleLLMVariant.VERTEX_AI) {
      // adk-python synthesizes `set_model_response() -> str`, and its
      // declaration builder attaches the return schema off GEMINI_API only.
      declaration.response = {type: Type.STRING};
    }
    return declaration;
  }

  override async runAsync({
    args,
    toolContext,
  }: RunAsyncToolRequest): Promise<unknown> {
    let result: unknown;
    if (this.wrapperKey === 'response') {
      // adk-python returns `args.get('response')` for a schema that is neither
      // a model nor a list of models, with no validation and no error path.
      result = args['response'];
    } else {
      // `args.get('items', [])`: an omitted list is empty, not a failure.
      const submitted =
        this.wrapperKey === 'items' ? (args['items'] ?? []) : args;
      try {
        result = stripNullish(parseWithSchema(this.outputSchema, submitted));
      } catch (error: unknown) {
        return {
          error:
            `Validation Error found:\n${formatSchemaValidationError(error)}\n` +
            RETRY_INSTRUCTION,
        };
      }
    }
    toolContext.actions.setModelResponse = result;
    return result;
  }

  /** The parameters the model sees under `variant`, built once per variant. */
  private parametersFor(variant: GoogleLLMVariant): Schema {
    const cached = this.parametersByVariant.get(variant);
    if (cached) {
      return cached;
    }
    // A Zod string validator renders as a `format` the Gemini API rejects.
    const parameters =
      variant === GoogleLLMVariant.GEMINI_API
        ? sanitizeSchemaFormatsForGemini(this.parameters)
        : this.parameters;
    this.parametersByVariant.set(variant, parameters);
    return parameters;
  }
}
