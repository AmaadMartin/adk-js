/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {z} from 'zod';

/**
 * Schema for a stateful parameter shared between tools, and the tools on each
 * side of that connection.
 */
export const StatefulParameterSchema = z.object({
  /** The name of the shared parameter (e.g. `ticket_id`). */
  parameterName: z.string(),
  /** The tools that generate or modify this parameter. */
  creatingTools: z.array(z.string()),
  /** The tools that take this parameter as input. */
  consumingTools: z.array(z.string()),
});

/** Schema for the map of stateful connections between tools. */
export const ToolConnectionMapSchema = z.object({
  statefulParameters: z.array(StatefulParameterSchema),
});

/** A stateful parameter and the tools that create and consume it. */
export type StatefulParameter = z.infer<typeof StatefulParameterSchema>;

/** The map of stateful connections between tools. */
export type ToolConnectionMap = z.infer<typeof ToolConnectionMapSchema>;
