/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/** A stateful parameter, and the tools that create and consume it. */
export interface StatefulParameter {
  /** The name of the shared parameter (e.g. `ticket_id`). */
  parameterName: string;
  /** The tools that generate or modify this parameter. */
  creatingTools: string[];
  /** The tools that take this parameter as input. */
  consumingTools: string[];
}

/** The map of stateful connections between a set of tools. */
export interface ToolConnectionMap {
  /** The stateful parameters the tools share. */
  statefulParameters: StatefulParameter[];
}
