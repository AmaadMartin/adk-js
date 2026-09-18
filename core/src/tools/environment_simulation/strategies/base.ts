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
 * The entities a simulation has created so far, keyed by parameter name and
 * then by that parameter's value.
 *
 * adk-python types this `Dict[str, Any]`; adk-js names the nested shape the
 * strategies actually write.
 *
 * WARNING: This feature is **experimental** and its API or behavior may change
 * in future releases.
 */
export type SimulationStateStore = Record<string, Record<string, unknown>>;

/**
 * The tool call a mock strategy has to answer.
 *
 * WARNING: This feature is **experimental** and its API or behavior may change
 * in future releases.
 */
export interface MockParams {
  /** The tool the agent asked to call. */
  tool: BaseTool;

  /** The arguments the agent passed to the tool. */
  args: Record<string, unknown>;

  /** The context of the tool call. */
  context: Context;

  /** How the simulated tools connect, when the analyzer produced a map. */
  toolConnectionMap?: ToolConnectionMap;

  /**
   * The entities created so far in this simulation. A strategy that creates an
   * entity writes it here, so a later tool call can read it back.
   */
  stateStore: SimulationStateStore;

  /** Environment-specific data, such as a small database dump. */
  environmentData?: string;

  /** A prior agent run trace. */
  tracing?: string;
}

/**
 * Produces the response of a tool that is never called.
 *
 * WARNING: This feature is **experimental** and its API or behavior may change
 * in future releases.
 */
export abstract class BaseMockStrategy {
  /**
   * Generates a mock response for one tool call.
   *
   * @param params The tool call to answer.
   * @returns The response to hand back in place of the tool's own.
   */
  abstract mock(params: MockParams): Promise<Record<string, unknown>>;
}

/**
 * The placeholder strategy behind the deprecated
 * `MockStrategy.MOCK_STRATEGY_TRACING`, which reports that it does nothing.
 *
 * Pass the trace as `tracing` on the environment simulation config and use
 * `MockStrategy.MOCK_STRATEGY_TOOL_SPEC` instead.
 *
 * WARNING: This feature is **experimental** and its API or behavior may change
 * in future releases.
 */
@experimental
export class TracingMockStrategy extends BaseMockStrategy {
  /**
   * @returns An error response, because this strategy mocks nothing.
   */
  async mock(): Promise<Record<string, unknown>> {
    return {status: 'error', errorMessage: 'Not implemented'};
  }
}
