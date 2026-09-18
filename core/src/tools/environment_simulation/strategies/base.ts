/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {BaseTool} from '../../base_tool.js';
import {ToolConnectionMap} from '../tool_connection_map.js';

/** The request passed to a mock strategy for one simulated tool call. */
export interface MockRequest {
  /** The tool whose response is being simulated. */
  tool: BaseTool;
  /** The arguments the model called the tool with. */
  args: Record<string, unknown>;
  /** The stateful connections between the agent's tools, when analyzed. */
  toolConnectionMap?: ToolConnectionMap;
  /**
   * The shared store of simulated entities, keyed by stateful parameter name
   * and then by that parameter's value. A strategy simulating a creating tool
   * records its response here, so a later consuming call stays consistent with
   * it. Mutated in place.
   */
  stateStore: Record<string, Record<string, unknown>>;
  /** Environment data to ground the mock in. */
  environmentData?: string;
  /** A prior run's trace to keep the mock consistent with. */
  tracing?: string;
}

/** Base class for strategies that mock a tool response. */
export abstract class BaseMockStrategy {
  /**
   * Generates a mock response for a tool call.
   *
   * @param request The tool, its arguments, and the simulation state.
   * @returns The simulated tool response, handed back to the model as-is.
   */
  abstract mock(request: MockRequest): Promise<Record<string, unknown>>;
}
