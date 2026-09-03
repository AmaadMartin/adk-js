/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Schema, Type} from '@google/genai';
import {z as z3} from 'zod/v3';
import {z as z4} from 'zod/v4';

import {Context} from '../agents/context.js';
import {Event, getFunctionResponses} from '../events/event.js';
import {
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
import {FunctionTool} from './function_tool.js';

/** The name the model calls to return its structured answer. */
export const SET_MODEL_RESPONSE_TOOL_NAME = 'set_model_response';

/** The wrapper parameter for a list-of-object output schema. */
const ITEMS_PARAMETER = 'items';

/** The wrapper parameter for any other non-object output schema. */
const VALUE_PARAMETER = 'response';

const TOOL_DESCRIPTION =
  'Call this tool to submit your final response conforming to the output ' +
  'schema. Use this tool only when you have collected all the information ' +
  'and are ready to return the final answer.';

/**
 * The instruction appended to a validation failure. Reproduced from
 * adk-python `tools/set_model_response_tool.py`, because the model is prompted
 * against this wording.
 */
const RETRY_INSTRUCTION =
  `Recall the ${SET_MODEL_RESPONSE_TOOL_NAME} function correctly, fix the ` +
  'errors, and call it again with all required fields using the correct types.';

/**
 * Builds the tool an agent uses to deliver structured output on a model that
 * cannot accept an output schema and tools in the same request.
 *
 * The tool's parameters are the agent's output schema, so the model submits its
 * final answer as a function call. The arguments are validated against that
 * schema: a valid call is recorded on `actions.setModelResponse` for the agent
 * to promote into its final response, and an invalid one is answered with the
 * validation error so the model can correct itself.
 *
 * Ported from adk-python `tools/set_model_response_tool.py`.
 *
 * @param outputSchema The agent's output schema, in the dialect it was
 *   supplied in. It is both what the model is shown and what its arguments are
 *   checked against.
 */
export function createSetModelResponseTool(
  outputSchema: SchemaLike,
): FunctionTool<Schema> {
  const shape = parameterShape(outputSchema);
  return new FunctionTool<Schema>({
    name: SET_MODEL_RESPONSE_TOOL_NAME,
    description: TOOL_DESCRIPTION,
    parameters: declarationParameters(outputSchema, shape),
    execute: (args, toolContext) =>
      submitModelResponse(args, toolContext, shape, outputSchema),
  });
}

/**
 * Reads the validated `set_model_response` payload off a function-response
 * event, as JSON, or `undefined` when the event carries none.
 *
 * Both signals are required, as in adk-python: a rejected call still produces
 * the function response, and must not be promoted to a final answer.
 */
export function getStructuredModelResponse(
  functionResponseEvent: Event,
): string | undefined {
  const response = functionResponseEvent.actions.setModelResponse;
  if (response === undefined || response === null) {
    return undefined;
  }
  const submitted = getFunctionResponses(functionResponseEvent).some(
    (functionResponse) =>
      functionResponse.name === SET_MODEL_RESPONSE_TOOL_NAME,
  );
  return submitted ? JSON.stringify(response) : undefined;
}

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

/**
 * Validates the model's arguments and records the answer.
 *
 * A schema violation is data, not a fault: the model is told what is wrong and
 * gets another turn. Nothing is recorded, so the agent does not promote a
 * rejected answer.
 */
function submitModelResponse(
  args: unknown,
  toolContext: Context | undefined,
  shape: SchemaShape,
  outputSchema: SchemaLike,
): unknown {
  if (!toolContext) {
    throw new Error(
      `Tool '${SET_MODEL_RESPONSE_TOOL_NAME}' requires a tool context.`,
    );
  }
  let validated: unknown;
  try {
    validated = parseWithSchema(outputSchema, submittedValue(args, shape));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {error: `Validation Error found:\n${message}\n${RETRY_INSTRUCTION}`};
  }
  const response = withoutUndefinedFields(validated);
  toolContext.actions.setModelResponse = response;
  return response;
}

/** The value the model submitted, unwrapped for the schema's shape. */
function submittedValue(args: unknown, shape: SchemaShape): unknown {
  if (shape === 'object') {
    return args;
  }
  const record = isRecord(args) ? args : {};
  if (shape === 'objectArray') {
    return record[ITEMS_PARAMETER] ?? [];
  }
  return record[VALUE_PARAMETER];
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
