/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {z} from 'zod';

/**
 * A parameter that carries state between tools, and the tools that touch it.
 *
 * WARNING: This feature is **experimental** and its API or behavior may change
 * in future releases.
 */
export interface StatefulParameter {
  /** The name of the shared parameter, for example `ticket_id`. */
  parameterName: string;

  /** The tools that generate or modify the parameter. */
  creatingTools: string[];

  /** The tools that read the parameter. */
  consumingTools: string[];
}

/**
 * The stateful parameters a set of tools shares.
 *
 * WARNING: This feature is **experimental** and its API or behavior may change
 * in future releases.
 */
export interface ToolConnectionMap {
  /** Every stateful parameter found across the analyzed tools. */
  statefulParameters: StatefulParameter[];
}

/**
 * The snake_case shape the model reads and writes.
 *
 * The analysis prompt asks for `parameter_name`, `creating_tools` and
 * `consuming_tools`, and the mock prompt shows the map back to the model. Both
 * directions therefore stay snake_case, while the adk-js surface is camelCase.
 */
interface WireToolConnectionMap {
  stateful_parameters: Array<{
    parameter_name: string;
    creating_tools: string[];
    consuming_tools: string[];
  }>;
}

// The schema mirrors adk-python's pydantic models, which drop an unknown key
// rather than rejecting it. zod strips one by default, so `object` is right
// here even though the config module uses `strictObject` for caller input.
const wireToolConnectionMapSchema = z.object({
  stateful_parameters: z.array(
    z.object({
      parameter_name: z.string(),
      creating_tools: z.array(z.string()),
      consuming_tools: z.array(z.string()),
    }),
  ),
});

/**
 * Parses the map a model produced.
 *
 * @param value The parsed JSON document the model returned.
 * @returns The map in its adk-js camelCase form.
 * @throws {z.ZodError} When `value` does not have the documented shape.
 *     adk-python's `model_validate` raises here too.
 */
export function parseToolConnectionMap(value: unknown): ToolConnectionMap {
  const wire = wireToolConnectionMapSchema.parse(value);
  return {
    statefulParameters: wire.stateful_parameters.map((parameter) => ({
      parameterName: parameter.parameter_name,
      creatingTools: parameter.creating_tools,
      consumingTools: parameter.consuming_tools,
    })),
  };
}

/** Converts the map back to the snake_case shape a prompt shows the model. */
export function toWireToolConnectionMap(
  map: ToolConnectionMap,
): WireToolConnectionMap {
  return {
    stateful_parameters: map.statefulParameters.map((parameter) => ({
      parameter_name: parameter.parameterName,
      creating_tools: parameter.creatingTools,
      consuming_tools: parameter.consumingTools,
    })),
  };
}
