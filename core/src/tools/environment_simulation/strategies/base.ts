/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {GenerateContentConfig} from '@google/genai';

import {Context} from '../../../agents/context.js';
import {
  FeatureName,
  isFeatureEnabled,
} from '../../../features/feature_registry.js';
import {experimental} from '../../../utils/experimental.js';
import {BaseTool} from '../../base_tool.js';
import {ToolConnectionMap} from '../tool_connection_map.js';

/**
 * The entities a simulation has created so far, keyed by parameter name and
 * then by that parameter's value.
 *
 * This is the shape the built-in strategies write into a
 * {@link MockRequest.stateStore}. A strategy of your own may write any shape.
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
export interface MockRequest {
  /** The tool the model called. */
  tool: BaseTool;

  /** The arguments the model called the tool with. */
  args: Record<string, unknown>;

  /** The context of the tool call. */
  toolContext: Context;

  /** How the simulated tools connect, when the analyzer produced a map. */
  toolConnectionMap?: ToolConnectionMap;

  /**
   * The simulated state shared across the calls of one run.
   *
   * A strategy that simulates a creating tool records its response here, so a
   * later consuming call stays consistent with it. The object is mutated in
   * place. adk-python types this `Dict[str, Any]`, and adk-js keeps it open
   * for the same reason: the shape is the strategy's to choose.
   */
  stateStore: Record<string, unknown>;

  /** Environment-specific data, such as a small database dump. */
  environmentData?: string;

  /** A prior agent run trace. */
  tracing?: string;
}

/**
 * Base class for mock strategies.
 *
 * A mock strategy answers a tool call with a simulated response, so an agent
 * can be exercised without the tool's real backend. Subclass it and override
 * {@link BaseMockStrategy.mock}.
 *
 * WARNING: This feature is **experimental** and its API or behavior may change
 * in future releases.
 */
@experimental
export class BaseMockStrategy {
  constructor() {
    if (!isFeatureEnabled(FeatureName.ENVIRONMENT_SIMULATION)) {
      throw new Error(
        `Feature ${FeatureName.ENVIRONMENT_SIMULATION} is not enabled.`,
      );
    }
  }

  /**
   * Generates a mock response for one tool call.
   *
   * @param _request The tool call to answer.
   * @returns The response to hand back in place of the tool's own.
   */
  async mock(_request: MockRequest): Promise<Record<string, unknown>> {
    throw new Error(
      'BaseMockStrategy.mock() is not implemented. Subclass BaseMockStrategy and override mock().',
    );
  }
}

/**
 * A placeholder strategy that would answer a call from an execution trace.
 *
 * It carries the model it would use and always reports that it is not
 * implemented. adk-python ships the same placeholder, and the simulation
 * engine builds it for the deprecated `MockStrategy.MOCK_STRATEGY_TRACING`
 * config value. Pass the trace as `tracing` on the environment simulation
 * config and use `MockStrategy.MOCK_STRATEGY_TOOL_SPEC` instead.
 *
 * WARNING: This feature is **experimental** and its API or behavior may change
 * in future releases.
 */
export class TracingMockStrategy extends BaseMockStrategy {
  /**
   * @param llmName The model a real implementation would call.
   * @param llmConfig The generation config a real implementation would use.
   */
  constructor(
    readonly llmName: string = '',
    readonly llmConfig?: GenerateContentConfig,
  ) {
    super();
  }

  /**
   * @returns An error response, because this strategy mocks nothing.
   */
  override async mock(_request: MockRequest): Promise<Record<string, unknown>> {
    return {status: 'error', errorMessage: 'Not implemented'};
  }
}
