/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {GenerateContentConfig} from '@google/genai';

import {Context} from '../../../agents/context.js';
import {NotImplementedError} from '../../../errors/not_implemented_error.js';
import {
  FeatureName,
  isFeatureEnabled,
} from '../../../features/feature_registry.js';
import {experimental} from '../../../utils/experimental.js';
import {BaseTool} from '../../base_tool.js';
import {ToolConnectionMap} from '../tool_connection_map.js';

/**
 * The tool call a mock strategy has to answer.
 */
export interface MockRequest {
  /** The tool the model called. */
  tool: BaseTool;
  /** The arguments the model called the tool with. */
  args: Record<string, unknown>;
  /** The context of the tool call. */
  toolContext: Context;
  /** The stateful connections between the agent's tools, when they are known. */
  toolConnectionMap?: ToolConnectionMap;
  /**
   * The simulated state shared across the calls of one run.
   *
   * A strategy that simulates a creating tool records its response here, so a
   * later consuming call stays consistent with it. The object is mutated in
   * place.
   */
  stateStore: Record<string, unknown>;
  /** A description of the environment the strategy simulates. */
  environmentData?: string;
  /** A trace of the calls made so far. */
  tracing?: string;
}

function assertEnvironmentSimulationEnabled(): void {
  if (!isFeatureEnabled(FeatureName.ENVIRONMENT_SIMULATION)) {
    throw new Error(
      `Feature ${FeatureName.ENVIRONMENT_SIMULATION} is not enabled.`,
    );
  }
}

/**
 * Base class for mock strategies.
 *
 * A mock strategy answers a tool call with a simulated response, so an agent
 * can be exercised without the tool's real backend. Subclass it and override
 * {@link BaseMockStrategy.mock}.
 */
@experimental
export class BaseMockStrategy {
  constructor() {
    assertEnvironmentSimulationEnabled();
  }

  /**
   * Generates a mock response for a tool call.
   *
   * @param _request The tool call to answer.
   * @return The simulated tool response.
   */
  async mock(_request: MockRequest): Promise<Record<string, unknown>> {
    throw new NotImplementedError('MockStrategy.mock is not implemented.');
  }
}

/**
 * A placeholder strategy that would answer a call from an execution trace.
 *
 * It carries the model it would use and always reports that it is not
 * implemented. adk-python ships the same placeholder.
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

  override async mock(_request: MockRequest): Promise<Record<string, unknown>> {
    return {status: 'error', errorMessage: 'Not implemented'};
  }
}
