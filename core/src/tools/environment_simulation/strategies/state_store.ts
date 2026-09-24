/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {isJsonObject} from '../../../utils/llm_utils.js';
import {ToolConnectionMap} from '../tool_connection_map.js';

/**
 * Defines an own data property on `target`.
 *
 * Both the parameter names and the entity ids used as keys here come from
 * model output. A plain `target[key] = value` would, for the key `__proto__`,
 * invoke the setter inherited from `Object.prototype` and mutate the prototype
 * chain instead of storing anything.
 */
function setOwnProperty(
  target: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  Object.defineProperty(target, key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

/**
 * Depth-first search for `targetKey` in a parsed JSON value. An own key of the
 * current object wins; otherwise the search descends into the values, and into
 * array elements. A nullish hit does not stop the surrounding search.
 *
 * Only own keys count. Testing with `in` would walk the prototype chain, so a
 * model-chosen `__proto__` or `constructor` would "find" an inherited built-in
 * in every object the search visited.
 */
function findValueByKey(data: unknown, targetKey: string): unknown {
  if (Array.isArray(data)) {
    for (const item of data) {
      const result = findValueByKey(item, targetKey);
      if (result !== undefined && result !== null) {
        return result;
      }
    }
    return undefined;
  }
  if (isJsonObject(data)) {
    if (Object.hasOwn(data, targetKey)) {
      return data[targetKey];
    }
    for (const value of Object.values(data)) {
      const result = findValueByKey(value, targetKey);
      if (result !== undefined && result !== null) {
        return result;
      }
    }
  }
  return undefined;
}

/**
 * Records `mockResponse` against every stateful parameter that `toolName`
 * creates, so a later consuming call can be simulated consistently with it.
 *
 * The entry is keyed by the parameter's value found anywhere in the response.
 * A parameter the tool does not create, or one the response does not carry, is
 * left alone.
 *
 * @param toolName The name of the tool whose response was simulated.
 * @param mockResponse The simulated response.
 * @param stateStore The store of simulated entities, mutated in place.
 * @param toolConnectionMap The stateful connections between the tools.
 */
export function updateStateStore(
  toolName: string,
  mockResponse: Record<string, unknown>,
  stateStore: Record<string, Record<string, unknown>>,
  toolConnectionMap?: ToolConnectionMap,
): void {
  for (const parameter of toolConnectionMap?.statefulParameters ?? []) {
    if (!parameter.creatingTools.includes(toolName)) {
      continue;
    }
    const {parameterName} = parameter;
    const value = findValueByKey(mockResponse, parameterName);
    if (value === undefined || value === null) {
      continue;
    }
    if (!Object.hasOwn(stateStore, parameterName)) {
      setOwnProperty(stateStore, parameterName, {});
    }
    setOwnProperty(stateStore[parameterName], String(value), mockResponse);
  }
}
