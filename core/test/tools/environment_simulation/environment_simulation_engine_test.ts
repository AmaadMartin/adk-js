/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ports
 * `tests/unittests/tools/environment_simulation/test_environment_simulation_engine.py`
 * from google/adk-python (`main`). Every `it` title is the name of the
 * reference test it ports. The own tests live in
 * `environment_simulation_engine_own_test.ts`.
 *
 * Three mechanisms differ from the reference:
 * - adk-python patches `_create_mock_strategy`. adk-js runs the real
 *   `ToolSpecMockStrategy` against a fake `BaseLlm`, and asserts on the
 *   response the strategy produced and on the model it resolved.
 * - adk-python reads `caplog`. adk-js spies on `logger.warn`.
 * - adk-python patches `asyncio.sleep`. adk-js spies on `setTimeout`, which
 *   keeps its real implementation, so the wait still happens.
 */

import {
  createEnvironmentSimulationConfig,
  createInjectionConfig,
  createToolSimulationConfig,
  EnvironmentSimulationConfigParams,
  EnvironmentSimulationEngine,
  LLMRegistry,
  MockStrategy,
} from '@google/adk';
import {logger} from '@google/adk/utils/logger.js';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {
  FakeTool,
  installFakeLlm,
  makeToolContext,
} from './simulation_test_utils.js';

/** The seed whose first mulberry32 draw is 0.601, above a 0.5 threshold. */
const SEED_ABOVE_HALF = 42;

/** The seed whose first mulberry32 draw is 0.204, below a 0.5 threshold. */
const SEED_BELOW_HALF = 100;

function makeConfig(params: EnvironmentSimulationConfigParams) {
  return createEnvironmentSimulationConfig({
    simulationModel: 'fake-model',
    simulationModelConfiguration: {},
    ...params,
  });
}

describe('EnvironmentSimulationEngine.simulate', () => {
  beforeEach(() => {
    installFakeLlm('{"mocked": true}');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('test_simulate_no_op_for_unconfigured_tool', async () => {
    const engine = new EnvironmentSimulationEngine(
      makeConfig({
        toolSimulationConfigs: [
          createToolSimulationConfig({
            toolName: 'configured_tool',
            mockStrategyType: MockStrategy.MOCK_STRATEGY_TOOL_SPEC,
          }),
        ],
      }),
    );

    const result = await engine.simulate(
      new FakeTool('unconfigured_tool'),
      {},
      makeToolContext(),
    );

    expect(result).toBeUndefined();
  });

  it('test_injection_with_matching_args', async () => {
    const engine = new EnvironmentSimulationEngine(
      makeConfig({
        toolSimulationConfigs: [
          createToolSimulationConfig({
            toolName: 'test_tool',
            injectionConfigs: [
              createInjectionConfig({
                matchArgs: {param: 'value'},
                injectedResponse: {injected: true},
              }),
            ],
          }),
        ],
      }),
    );

    const result = await engine.simulate(
      new FakeTool('test_tool'),
      {param: 'value'},
      makeToolContext(),
    );

    expect(result).toEqual({injected: true});
  });

  it('test_injection_not_applied_with_mismatched_args', async () => {
    const newLlm = vi.spyOn(LLMRegistry, 'newLlm');
    const engine = new EnvironmentSimulationEngine(
      makeConfig({
        toolSimulationConfigs: [
          createToolSimulationConfig({
            toolName: 'test_tool',
            injectionConfigs: [
              createInjectionConfig({
                matchArgs: {param: 'value'},
                injectedResponse: {injected: true},
              }),
            ],
            mockStrategyType: MockStrategy.MOCK_STRATEGY_TOOL_SPEC,
          }),
        ],
      }),
    );

    const result = await engine.simulate(
      new FakeTool('test_tool'),
      {param: 'different_value'},
      makeToolContext(),
    );

    expect(result).toEqual({mocked: true});
    expect(newLlm).toHaveBeenCalledWith('fake-model');
  });

  it('test_no_op_when_no_injection_hit_and_unspecified_strategy', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const engine = new EnvironmentSimulationEngine(
      makeConfig({
        toolSimulationConfigs: [
          createToolSimulationConfig({
            toolName: 'test_tool',
            injectionConfigs: [
              createInjectionConfig({
                matchArgs: {param: 'value'},
                injectedResponse: {injected: true},
              }),
            ],
            mockStrategyType: MockStrategy.MOCK_STRATEGY_UNSPECIFIED,
          }),
        ],
      }),
    );

    const result = await engine.simulate(
      new FakeTool('test_tool'),
      {param: 'different_value'},
      makeToolContext(),
    );

    expect(result).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(
        'did not hit any injection config and has no mock strategy',
      ),
    );
  });

  it('test_injection_with_random_seed_is_deterministic', async () => {
    const tool = new FakeTool('test_tool');
    const seededConfig = (randomSeed: number) =>
      makeConfig({
        toolSimulationConfigs: [
          createToolSimulationConfig({
            toolName: 'test_tool',
            injectionConfigs: [
              createInjectionConfig({
                injectionProbability: 0.5,
                randomSeed,
                injectedResponse: {injected: true},
              }),
            ],
            mockStrategyType: MockStrategy.MOCK_STRATEGY_TOOL_SPEC,
          }),
        ],
      });

    const mockedEngine = new EnvironmentSimulationEngine(
      seededConfig(SEED_ABOVE_HALF),
    );
    const injectedEngine = new EnvironmentSimulationEngine(
      seededConfig(SEED_BELOW_HALF),
    );

    expect(await mockedEngine.simulate(tool, {}, makeToolContext())).toEqual({
      mocked: true,
    });
    expect(await injectedEngine.simulate(tool, {}, makeToolContext())).toEqual({
      injected: true,
    });
  });

  it('test_injected_latency_awaits_asyncio_sleep', async () => {
    const latencySeconds = 0.2;
    const sleep = vi.spyOn(globalThis, 'setTimeout');
    const engine = new EnvironmentSimulationEngine(
      makeConfig({
        toolSimulationConfigs: [
          createToolSimulationConfig({
            toolName: 'test_tool',
            injectionConfigs: [
              createInjectionConfig({
                injectedLatencySeconds: latencySeconds,
                injectedResponse: {injected: true},
              }),
            ],
          }),
        ],
      }),
    );

    const result = await engine.simulate(
      new FakeTool('test_tool'),
      {},
      makeToolContext(),
    );

    expect(sleep).toHaveBeenCalledWith(expect.any(Function), 200);
    expect(result).toEqual({injected: true});
  });
});
