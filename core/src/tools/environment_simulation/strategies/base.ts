/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {BaseTool} from '../../base_tool.js';
import {ToolConnectionMap} from '../tool_connection_map.js';

/**
 * The call a mock strategy is asked to answer.
 *
 * WARNING: This feature is **experimental** and its API or behavior may change
 * in future releases.
 */
export interface MockRequest {
  /** The tool whose response is being mocked. */
  tool: BaseTool;

  /** The arguments the agent called the tool with. */
  args: Record<string, unknown>;

  /** How the analyzed tools share state, absent when analysis did not run. */
  toolConnectionMap: ToolConnectionMap | undefined;

  /**
   * The entities earlier mocked calls created, keyed by parameter name and
   * then by parameter value. A strategy may add to it.
   */
  stateStore: Record<string, unknown>;

  /** Environment-specific data, as a JSON string. */
  environmentData?: string;

  /** A prior agent run trace, as a JSON string. */
  tracing?: string;
}

/**
 * Produces the response a simulated tool call returns.
 *
 * adk-python names this class `MockStrategy`. adk-js exports the enum of that
 * name from the same barrel, so the class takes the `Base` prefix that
 * `BaseTool` and `BasePlugin` already use.
 *
 * WARNING: This feature is **experimental** and its API or behavior may change
 * in future releases.
 */
export abstract class BaseMockStrategy {
  /**
   * Generates a mock response for a tool call.
   *
   * @param request The tool call to answer.
   * @returns The tool response body, with snake_case keys, because the model
   *     reads it as a tool result rather than as an adk-js object.
   */
  abstract mock(request: MockRequest): Promise<Record<string, unknown>>;
}

/**
 * A placeholder for the withdrawn tracing strategy.
 *
 * @deprecated Use the tool-spec strategy with tracing input instead.
 *
 * WARNING: This feature is **experimental** and its API or behavior may change
 * in future releases.
 */
export class TracingMockStrategy extends BaseMockStrategy {
  override async mock(): Promise<Record<string, unknown>> {
    return {status: 'error', error_message: 'Not implemented'};
  }
}
