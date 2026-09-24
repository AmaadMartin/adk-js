/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {z} from 'zod';

/**
 * A parameter that carries state between tools.
 *
 * WARNING: This feature is **experimental** and its API or behavior may change
 * in future releases.
 */
export interface StatefulParameter {
  /** The name of the shared parameter, such as `ticket_id`. */
  parameterName: string;

  /** The tools that create or modify the parameter. */
  creatingTools: string[];

  /** The tools that read using the parameter. */
  consumingTools: string[];
}

/**
 * How a set of tools connects through its stateful parameters.
 *
 * WARNING: This feature is **experimental** and its API or behavior may change
 * in future releases.
 */
export interface ToolConnectionMap {
  /** Every stateful parameter the analysis found. */
  statefulParameters: StatefulParameter[];
}

// The analysis prompt asks the model for snake_case keys, so the wire shape is
// snake_case and the in-memory shape is camelCase.
const toolConnectionMapSchema = z
  .object({
    stateful_parameters: z.array(
      z.object({
        parameter_name: z.string(),
        creating_tools: z.array(z.string()),
        consuming_tools: z.array(z.string()),
      }),
    ),
  })
  .transform(
    (value): ToolConnectionMap => ({
      statefulParameters: value.stateful_parameters.map((parameter) => ({
        parameterName: parameter.parameter_name,
        creatingTools: parameter.creating_tools,
        consumingTools: parameter.consuming_tools,
      })),
    }),
  );

/**
 * Reads a {@link ToolConnectionMap} out of a model's parsed JSON answer.
 *
 * @param value The parsed JSON the model produced.
 * @returns The connection map, or undefined when `value` does not carry one.
 */
export function parseToolConnectionMap(
  value: unknown,
): ToolConnectionMap | undefined {
  const result = toolConnectionMapSchema.safeParse(value);
  return result.success ? result.data : undefined;
}

/**
 * Renders a {@link ToolConnectionMap} in the snake_case shape a model reads.
 *
 * A prompt that embeds the map has to spell its keys the way the analysis
 * prompt asked for them, otherwise the model sees two namings of one thing.
 *
 * @param connectionMap The connection map to render.
 * @returns The map as an indented JSON string.
 */
export function toWireJson(connectionMap: ToolConnectionMap): string {
  return JSON.stringify(
    {
      stateful_parameters: connectionMap.statefulParameters.map(
        (parameter) => ({
          parameter_name: parameter.parameterName,
          creating_tools: parameter.creatingTools,
          consuming_tools: parameter.consumingTools,
        }),
      ),
    },
    null,
    2,
  );
}
