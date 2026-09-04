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
  SchemaShape,
  schemaShape,
} from '../utils/schema.js';
import {
  isZodObject,
  isZodSchema,
  isZodV3Schema,
  isZodV4Schema,
  zodObjectToSchema,
} from '../utils/simple_zod_to_json.js';
import {BaseTool, RunAsyncToolRequest} from './base_tool.js';

/** The name the model calls to return its structured answer. */
export const SET_MODEL_RESPONSE_TOOL_NAME = 'set_model_response';

/** The wrapper parameter for a list-of-object output schema. */
const ITEMS_PARAMETER = 'items';

/** The wrapper parameter for any other non-object output schema. */
const VALUE_PARAMETER = 'response';

const SET_MODEL_RESPONSE_TOOL_DESCRIPTION =
  'Call this tool to submit your final response conforming to the output' +
  ' schema. Use this tool only when you have collected all the information' +
  ' and are ready to return the final answer.';

/**
 * The instruction appended to a validation failure. Reproduced from
 * adk-python `tools/set_model_response_tool.py`, because the model is prompted
 * against this wording.
 */
const RETRY_INSTRUCTION =
  `Recall the ${SET_MODEL_RESPONSE_TOOL_NAME} function correctly, fix the` +
  ' errors, and call it again with all required fields using the correct' +
  ' types.';

/**
 * The shape the declaration and the call handler both work from.
 *
 * A Zod schema that renders as an object without being a `ZodObject` — an
 * optional object, for instance — has no field list to expose as parameters,
 * so it travels under the value parameter like any other value.
 */
function parameterShape(outputSchema: SchemaLike): SchemaShape {
  const shape = schemaShape(outputSchema);
  if (
    shape === 'object' &&
    isZodSchema(outputSchema) &&
    !isZodObject(outputSchema)
  ) {
    return 'value';
  }
  return shape;
}

/** The genai `Schema` the model sees as the tool's parameters. */
function declarationParameters(
  outputSchema: SchemaLike,
  shape: SchemaShape,
): Schema {
  if (shape === 'object') {
    // `parameterShape` only reports `'object'` for a `ZodObject` or a genai
    // `Schema`, so anything that is not the former is the latter.
    return isZodObject(outputSchema)
      ? zodObjectToSchema(outputSchema)
      : (outputSchema as Schema);
  }
  return wrapInObjectSchema(
    outputSchema,
    shape === 'objectArray' ? ITEMS_PARAMETER : VALUE_PARAMETER,
  );
}

/**
 * Declares `schema` as the single named parameter of an object schema, since
 * the API accepts only object-typed function parameters.
 *
 * The wrapper is built in the schema's own dialect. Converting the inner schema
 * instead would cost it the `default`, `format` and bound keywords that the
 * model needs to fill the parameter correctly.
 */
function wrapInObjectSchema(schema: SchemaLike, parameter: string): Schema {
  if (isZodV4Schema(schema)) {
    return renderWrapper(z4.object({[parameter]: schema}), parameter);
  }
  if (isZodV3Schema(schema)) {
    return renderWrapper(z3.object({[parameter]: schema}), parameter);
  }
  return {
    type: Type.OBJECT,
    properties: {[parameter]: schema as Schema},
    required: [parameter],
  };
}

/**
 * Renders a Zod wrapper object, falling back to an unconstrained parameter for
 * a schema the genai dialect cannot express — a date, for instance. The model
 * gets no shape to follow, but the tool stays callable and its arguments are
 * still validated when they arrive.
 */
function renderWrapper(
  wrapper: z3.ZodObject<z3.ZodRawShape> | z4.ZodObject<z4.ZodRawShape>,
  parameter: string,
): Schema {
  try {
    return zodObjectToSchema(wrapper);
  } catch {
    return {
      type: Type.OBJECT,
      properties: {[parameter]: {}},
      required: [parameter],
    };
  }
}

/** The value the model submitted, unwrapped for the schema's shape. */
function submittedValue(args: unknown, shape: SchemaShape): unknown {
  if (shape === 'object') {
    return args;
  }
  const record = isRecord(args) ? args : {};
  // adk-python reads `args.get('items', [])`, so an omitted list is empty
  // rather than a validation failure.
  if (shape === 'objectArray') {
    return record[ITEMS_PARAMETER] ?? [];
  }
  return record[VALUE_PARAMETER];
}

/**
 * Renders a validation failure as the text the model reads.
 *
 * A schema error is listed field by field, so the model knows which field to
 * correct. Anything else is rendered as its own message: the model reads this
 * text as instructions, and the class name of a thrown `Error` is noise to it.
 */
function describeValidationFailure(error: unknown): string {
  if (error instanceof Error && !('issues' in error)) {
    return error.message;
  }
  return formatSchemaValidationError(error);
}

/** The payload a rejected call answers with, which asks the model to retry. */
function retryFeedback(error: unknown): {error: string} {
  return {
    error:
      `Validation Error found:\n${describeValidationFailure(error)}\n` +
      RETRY_INSTRUCTION,
  };
}

/**
 * Drops keys whose validated value is `undefined`, mirroring adk-python's
 * `model_dump(exclude_none=True)`.
 *
 * An explicit `null` is kept: a schema that declares a field nullable means it,
 * and dropping the null would lose data the caller asked for.
 */
function withoutUndefinedFields(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(withoutUndefinedFields);
  }
  if (!isPlainObject(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .map(([key, entry]) => [key, withoutUndefinedFields(entry)]),
  );
}

/** Narrows an unknown value to a plain (non-array) record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Whether the value is an object literal, as opposed to an instance of a class
 * a validator produced (a `Date`, say), whose fields must not be rebuilt.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
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
  /** How the schema reaches the model: as fields, or under a wrapper. */
  private readonly shape: SchemaShape;

  /** The declaration parameters, resolved once so they are stable per turn. */
  private readonly parameters: Schema;

  /** Returns the validated value, and throws when the arguments are bad. */
  private readonly validate: (value: unknown) => unknown;

  /**
   * @param outputSchema - The agent's output schema, in the dialect it was
   *   supplied in. It is both what the model is shown and, unless
   *   `validateOutput` says otherwise, what its arguments are checked against.
   * @param validateOutput - Returns the validated arguments, and throws when
   *   they do not satisfy the schema as the caller declared it, which may hold
   *   constraints the genai form cannot. Omit it to validate against
   *   `outputSchema` directly.
   */
  constructor(
    outputSchema: SchemaLike,
    validateOutput?: (value: unknown) => unknown,
  ) {
    super({
      name: SET_MODEL_RESPONSE_TOOL_NAME,
      description: SET_MODEL_RESPONSE_TOOL_DESCRIPTION,
    });
    this.shape = parameterShape(outputSchema);
    this.parameters = declarationParameters(outputSchema, this.shape);
    this.validate =
      validateOutput ?? ((value) => parseWithSchema(outputSchema, value));
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
      validated = this.validate(submittedValue(args, this.shape));
    } catch (error: unknown) {
      return retryFeedback(error);
    }
    const response = withoutUndefinedFields(validated);
    toolContext.actions.setModelResponse = response;
    return response;
  }
}

/**
 * Creates the tool as a function, for a caller that prefers a factory to
 * `new`.
 *
 * The tool is a {@link SetModelResponseTool} rather than a `FunctionTool`,
 * because `FunctionTool` rejects a call that omits a declared-required
 * argument before the body runs. That gate would turn an omitted `items`
 * argument into an error, where adk-python reads it as the empty list.
 *
 * A schema violation is reported to the model as data rather than raised: the
 * tool answers the call with an `error` payload and leaves
 * `actions.setModelResponse` unset, so the model gets another turn to correct
 * itself.
 *
 * @param outputSchema - The agent's output schema, in the dialect it was
 *   supplied in.
 * @param validateOutput - Returns the validated arguments, and throws when they
 *   do not satisfy the schema as the caller declared it. Omit it to validate
 *   against `outputSchema` directly.
 * @return The tool, ready to append to a request.
 */
export function createSetModelResponseTool(
  outputSchema: SchemaLike,
  validateOutput?: (value: unknown) => unknown,
): SetModelResponseTool {
  return new SetModelResponseTool(outputSchema, validateOutput);
}
