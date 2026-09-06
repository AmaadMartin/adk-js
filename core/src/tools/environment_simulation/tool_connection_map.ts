/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/** A parameter shared between tools, and the tools on each side of it. */
export interface StatefulParameter {
  /** The name of the shared parameter, for example `ticket_id`. */
  parameterName: string;
  /** The tools that generate this parameter. */
  creatingTools: string[];
  /** The tools that consume this parameter as input. */
  consumingTools: string[];
}

/** The stateful connections between an agent's tools. */
export interface ToolConnectionMap {
  statefulParameters: StatefulParameter[];
}
