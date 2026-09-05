/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {z} from 'zod';
import {InputValidationError} from '../../errors/input_validation_error.js';
import {
  FeatureName,
  isFeatureEnabled,
} from '../../features/feature_registry.js';
import {camelCaseKeys} from '../../utils/case_utils.js';

/**
 * Represents a stateful parameter and its connections.
 *
 * WARNING: This feature is **experimental** and its API or behavior may change
 * in future releases.
 */
export interface StatefulParameter {
  /** The name of the shared parameter (e.g., "ticket_id"). */
  parameterName: string;

  /** A list of tools that generate this parameter. */
  creatingTools: string[];

  /** A list of tools that use this parameter as input. */
  consumingTools: string[];
}

/**
 * Represents the map of tool connections.
 *
 * WARNING: This feature is **experimental** and its API or behavior may change
 * in future releases.
 */
export interface ToolConnectionMap {
  /** A list of stateful parameters and their connections. */
  statefulParameters: StatefulParameter[];
}

// The schemas below stay module-private: the interfaces and the functions are
// the public surface.
//
// `strictObject` rejects an unknown key. That is deliberately stricter than
// adk-python, whose models are plain `BaseModel` and therefore drop an unknown
// key in silence. A factory that also receives parsed JSON is the wrong place
// to swallow a misspelled field.

const statefulParameterShape = {
  parameterName: z.string(),
  creatingTools: z.array(z.string()),
  consumingTools: z.array(z.string()),
};

const statefulParameterSchema = z.strictObject(statefulParameterShape);

const toolConnectionMapSchema = z.strictObject({
  statefulParameters: z.array(statefulParameterSchema),
});

// The parse schemas share that shape but drop an unknown key instead of
// rejecting it, which is what pydantic does. Their input is a document a
// language model produced, and the model may volunteer a field the prompt
// never asked for.

const parsedToolConnectionMapSchema = z.object({
  statefulParameters: z.array(z.object(statefulParameterShape)),
});

function assertFeatureEnabled(): void {
  if (!isFeatureEnabled(FeatureName.ENVIRONMENT_SIMULATION)) {
    throw new Error(
      `Feature ${FeatureName.ENVIRONMENT_SIMULATION} is not enabled.`,
    );
  }
}

function parseOrThrow<S extends z.ZodType>(
  schema: S,
  typeName: string,
  value: unknown,
): z.infer<S> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new InputValidationError(
      `Invalid ${typeName}: ${z.prettifyError(result.error)}`,
    );
  }
  return result.data;
}

/**
 * Creates a {@link StatefulParameter}.
 *
 * @param params The parameter name, and the tools that create and consume it.
 *     The object is read, never mutated.
 * @returns A validated, freshly built {@link StatefulParameter}.
 * @throws {Error} When the `ENVIRONMENT_SIMULATION` feature is disabled.
 * @throws {InputValidationError} When a field is missing or has the wrong
 *     type, or when `params` carries an unknown key.
 */
export function createStatefulParameter(
  params: StatefulParameter,
): StatefulParameter {
  assertFeatureEnabled();
  return parseOrThrow(statefulParameterSchema, 'StatefulParameter', params);
}

/**
 * Creates a {@link ToolConnectionMap}.
 *
 * An empty `statefulParameters` list is valid: adk-python sets no minimum
 * length, and the analyzer returns an empty map when it cannot parse a reply.
 *
 * @param params The stateful parameters of the map. The object is read, never
 *     mutated.
 * @returns A validated, freshly built {@link ToolConnectionMap}.
 * @throws {Error} When the `ENVIRONMENT_SIMULATION` feature is disabled.
 * @throws {InputValidationError} When a nested parameter is invalid, or when
 *     `params` carries an unknown key.
 */
export function createToolConnectionMap(
  params: ToolConnectionMap,
): ToolConnectionMap {
  assertFeatureEnabled();
  return parseOrThrow(toolConnectionMapSchema, 'ToolConnectionMap', params);
}

/**
 * Parses the map a language model produced into a {@link ToolConnectionMap}.
 *
 * This is adk-python's `ToolConnectionMap.model_validate`. The caller owns the
 * decode: pass an already-parsed JSON document, not the raw text. The wire
 * keys stay snake_case, because the analyzer prompt fixes them as
 * `stateful_parameters`, `parameter_name`, `creating_tools` and
 * `consuming_tools`.
 *
 * The `ENVIRONMENT_SIMULATION` feature gate does not apply here. adk-python's
 * `@experimental` decorator wraps `__init__`, and `model_validate` builds
 * through pydantic's core validator instead, so validation succeeds with the
 * feature off. adk-js reproduces that.
 *
 * An unknown key is dropped rather than rejected, which is what pydantic does.
 * A dropped key never reaches the returned object.
 *
 * @param value A decoded JSON document with snake_case keys.
 * @returns A validated, freshly built {@link ToolConnectionMap}.
 * @throws {InputValidationError} When a required key is missing, or a value
 *     has the wrong type.
 */
export function parseToolConnectionMap(value: unknown): ToolConnectionMap {
  return parseOrThrow(
    parsedToolConnectionMapSchema,
    'ToolConnectionMap',
    camelCaseKeys(value),
  );
}
