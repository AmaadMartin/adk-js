/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Context} from '../../../agents/context.js';
import {BaseTool} from '../../base_tool.js';
import {ToolConnectionMap} from '../tool_connection_map.js';

/**
 * The entities a creating tool has minted so far.
 *
 * The outer key is a stateful parameter name, the inner key is the value the
 * model minted for it, and the value is the mock response that carried it.
 *
 * @experimental
 */
export type StateStore = Record<
  string,
  Record<string, Record<string, unknown>>
>;

/**
 * One tool call to mock.
 *
 * @experimental
 */
export interface MockRequest {
  /** The tool the agent called. */
  tool: BaseTool;
  /** The arguments the agent called it with. */
  args: Record<string, unknown>;
  /** The context of the call. */
  toolContext: Context;
  /** How the tools connect, when the analysis produced a map. */
  toolConnectionMap?: ToolConnectionMap;
  /** The entities minted so far. A creating tool adds to it. */
  stateStore: StateStore;
  /** Environment data, such as a small database dump, as JSON. */
  environmentData?: string;
  /** A prior agent run trace, as JSON. */
  tracing?: string;
}

/**
 * Produces a mock response for a tool call.
 *
 * @experimental
 */
export abstract class MockStrategy {
  /**
   * Mocks one tool call.
   *
   * @param request The call to mock.
   * @return The mocked tool response.
   */
  abstract mock(request: MockRequest): Promise<Record<string, unknown>>;
}

/**
 * A placeholder for mocking from a recorded trace.
 *
 * The strategy is not implemented, in adk-python either. It is reachable
 * through the deprecated `MOCK_STRATEGY_TRACING`; use
 * `MOCK_STRATEGY_TOOL_SPEC` with a `tracing` config instead.
 *
 * @experimental
 */
export class TracingMockStrategy extends MockStrategy {
  /**
   * @param _request The call to mock. Ignored.
   * @return An error response saying the strategy does not exist yet.
   */
  async mock(_request: MockRequest): Promise<Record<string, unknown>> {
    return {status: 'error', error_message: 'Not implemented'};
  }
}
