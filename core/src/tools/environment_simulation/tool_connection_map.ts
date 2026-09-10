/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {z} from 'zod';

/**
 * One parameter that carries state from the tools that create it to the tools
 * that read it.
 *
 * WARNING: This feature is **experimental** and its API or behavior may change
 * in future releases.
 */
export interface StatefulParameter {
  /** The name of the shared parameter, for example `ticketId`. */
  parameterName: string;

  /** The tools that create or modify the parameter's state. */
  creatingTools: string[];

  /** The tools that read the parameter without changing its state. */
  consumingTools: string[];
}

/**
 * How a set of tools connect to each other through their stateful parameters.
 *
 * WARNING: This feature is **experimental** and its API or behavior may change
 * in future releases.
 */
export interface ToolConnectionMap {
  /** Every stateful parameter the analyzer found. */
  statefulParameters: StatefulParameter[];
}

// A model writes this document, so an unknown key is expected and is dropped
// rather than rejected. That is looser than the config module, which uses
// `strictObject` because a human writes its input.
const statefulParameterSchema = z.object({
  parameterName: z.string(),
  creatingTools: z.array(z.string()),
  consumingTools: z.array(z.string()),
});

const toolConnectionMapSchema = z.object({
  statefulParameters: z.array(statefulParameterSchema),
});

/**
 * Reads a {@link ToolConnectionMap} out of a parsed JSON value.
 *
 * @param value The value a model produced, already parsed from JSON.
 * @returns The connection map, or `undefined` when `value` does not have the
 *     expected shape.
 */
export function parseToolConnectionMap(
  value: unknown,
): ToolConnectionMap | undefined {
  const result = toolConnectionMapSchema.safeParse(value);
  return result.success ? result.data : undefined;
}
