/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Context} from '../../../agents/context.js';
import {experimental} from '../../../utils/experimental.js';
import {BaseTool} from '../../base_tool.js';
import {ToolConnectionMap} from '../tool_connection_map.js';

/**
 * The entities a simulated run has created so far.
 *
 * The outer key is a stateful parameter name, such as `ticket_id`. The inner
 * key is one value of that parameter, and the value is the mocked response
 * that produced it.
 *
 * WARNING: This feature is **experimental** and its API or behavior may change
 * in future releases.
 */
export type SimulationStateStore = Record<
  string,
  Record<string, Record<string, unknown>>
>;

/**
 * The call a mock strategy answers.
 *
 * adk-python passes these positionally. adk-js passes one options object,
 * matching `SingleBeforeToolCallback` and `BasePlugin`.
 *
 * WARNING: This feature is **experimental** and its API or behavior may change
 * in future releases.
 */
export interface MockStrategyParams {
  /** The tool whose response is mocked. */
  tool: BaseTool;

  /** The arguments the model called the tool with. */
  args: Record<string, unknown>;

  /** The context of the intercepted tool call. */
  toolContext: Context;

  /** How the tools connect, when an analysis produced a map. */
  toolConnectionMap?: ToolConnectionMap;

  /** The entities created so far. A strategy may add to it. */
  stateStore: SimulationStateStore;

  /** Environment-specific data, as a JSON string. */
  environmentData?: string;

  /** A prior agent run trace, as a JSON string. */
  tracing?: string;
}

/**
 * Produces the response a simulated tool call returns.
 *
 * WARNING: This feature is **experimental** and its API or behavior may change
 * in future releases.
 */
export abstract class BaseMockStrategy {
  /**
   * Mocks one tool call.
   *
   * @param params The tool call to answer.
   * @returns The response the agent reads as the tool result.
   */
  abstract mock(params: MockStrategyParams): Promise<Record<string, unknown>>;
}

/**
 * Mocks a tool response from a recorded trace.
 *
 * adk-python ships this strategy as a stub, and so does adk-js. Use
 * `MOCK_STRATEGY_TOOL_SPEC` with `tracing` set on the config instead.
 *
 * WARNING: This feature is **experimental** and its API or behavior may change
 * in future releases.
 */
@experimental
export class TracingMockStrategy extends BaseMockStrategy {
  async mock(_params: MockStrategyParams): Promise<Record<string, unknown>> {
    return {status: 'error', error_message: 'Not implemented'};
  }
}
