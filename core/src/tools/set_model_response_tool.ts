/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {FunctionDeclaration, Schema, Type} from '@google/genai';
import {z as z3} from 'zod/v3';
import {z as z4} from 'zod/v4';

import {sanitizeSchemaFormatsForGemini} from '../utils/gemini_schema_util.js';
import {stripNullish} from '../utils/object_utils.js';
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

/** Declares `schema` as the single named parameter of an object schema. */
function wrapInObject(schema: Schema, wrapperKey: WrapperKey): Schema {
  return {
    type: Type.OBJECT,
    properties: {[wrapperKey]: schema},
    required: [wrapperKey],
  };
}

/**
 * Wraps a non-object Zod schema in a Zod object of the same major version,
 * which keeps the field's descriptions, defaults and nested items that a
 * hand-built genai wrapper would have to re-derive.
 */
function wrapZodInObject(
  schema: z3.ZodType | z4.ZodType,
  wrapperKey: WrapperKey,
): Schema {
  return isZodV4Schema(schema)
    ? zodObjectToSchema(z4.object({[wrapperKey]: schema}))
    : zodObjectToSchema(z3.object({[wrapperKey]: schema}));
}

/**
 * Classifies an output schema into the parameters the model sees and the
 * wrapper parameter its value travels under.
 *
 * `wrapperKey` is `undefined` when the schema is an object and its fields are
 * the parameters. An array of objects uses `items` and everything else uses
 * `response`, which is the distinction adk-python draws between
 * `list[BaseModel]` and `list[str]` / `dict[str, int]`.
 */
function resolveSchemaForm(schema: SchemaLike): {
  wrapperKey?: WrapperKey;
  parameters: Schema;
} {
  if (isZodObject(schema)) {
    return {parameters: zodObjectToSchema(schema)};
  }
  if (isGenaiSchema(schema)) {
    return schema.type === Type.OBJECT
      ? {parameters: schema}
      : {wrapperKey: 'response', parameters: wrapInObject(schema, 'response')};
  }
  const document = toJsonSchema(schema);
  const wrapperKey: WrapperKey =
    document['type'] === 'array' && isObjectSchema(document['items'])
      ? 'items'
      : 'response';
  return {wrapperKey, parameters: wrapZodInObject(schema, wrapperKey)};
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

  constructor(outputSchema: SchemaLike) {
    super({
      name: SET_MODEL_RESPONSE_TOOL_NAME,
      description: SET_MODEL_RESPONSE_TOOL_DESCRIPTION,
    });
    this.outputSchema = outputSchema;
    const {wrapperKey, parameters} = resolveSchemaForm(outputSchema);
    this.wrapperKey = wrapperKey;
    this.parameters = parameters;
  }

  override _getDeclaration(): FunctionDeclaration {
    // The variant comes from the environment, so it is read per call rather
    // than frozen at construction time.
    const variant = this.apiVariant;
    const declaration: FunctionDeclaration = {
      name: this.name,
      description: this.description,
      // A Zod string validator renders as a `format` the Gemini API rejects.
      parameters:
        variant === GoogleLLMVariant.GEMINI_API
          ? sanitizeSchemaFormatsForGemini(this.parameters)
          : this.parameters,
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
}
