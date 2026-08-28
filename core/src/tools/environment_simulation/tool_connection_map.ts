/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {isRecord} from '../../utils/object_utils.js';

import {JSON_INDENT} from './model_json_request.js';

/**
 * A parameter that carries state between tools, and the tools on each side of
 * it.
 */
export interface StatefulParameter {
  /** The shared parameter, for example `ticket_id`. */
  parameterName: string;
  /** The tools that create or modify the parameter's state. */
  creatingTools: string[];
  /** The tools that read state through the parameter. */
  consumingTools: string[];
}

/** How a set of tools connect to each other through stateful parameters. */
export interface ToolConnectionMap {
  statefulParameters: StatefulParameter[];
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === 'string');
}

function toStatefulParameter(value: unknown): StatefulParameter | undefined {
  if (!isRecord(value) || typeof value['parameter_name'] !== 'string') {
    return undefined;
  }
  return {
    parameterName: value['parameter_name'],
    creatingTools: toStringArray(value['creating_tools']),
    consumingTools: toStringArray(value['consuming_tools']),
  };
}

/**
 * Reads a connection map out of a model's JSON reply.
 *
 * The reply is untrusted, so an entry that does not have the documented shape
 * is dropped instead of failing the whole analysis.
 *
 * @param value The parsed JSON reply.
 * @return The connection map the reply describes, empty when it describes
 *     none.
 */
export function toToolConnectionMap(value: unknown): ToolConnectionMap {
  if (!isRecord(value) || !Array.isArray(value['stateful_parameters'])) {
    return {statefulParameters: []};
  }
  const statefulParameters = value['stateful_parameters']
    .map(toStatefulParameter)
    .filter((parameter) => parameter !== undefined);
  return {statefulParameters};
}

/**
 * Renders a connection map back into the JSON shape the prompts describe.
 *
 * The keys stay snake_case because the model is told to read and write them
 * under those names.
 *
 * @param map The connection map to render.
 * @return The map as indented JSON.
 */
export function formatToolConnectionMap(map: ToolConnectionMap): string {
  return JSON.stringify(
    {
      stateful_parameters: map.statefulParameters.map((parameter) => ({
        parameter_name: parameter.parameterName,
        creating_tools: parameter.creatingTools,
        consuming_tools: parameter.consumingTools,
      })),
    },
    null,
    JSON_INDENT,
  );
}
