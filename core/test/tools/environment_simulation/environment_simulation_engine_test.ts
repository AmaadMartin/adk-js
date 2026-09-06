/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// Ported from adk-python
// tests/unittests/tools/environment_simulation/test_environment_simulation_engine.py
// at google/adk-python@main.

import {
  EnvironmentSimulationEngine,
  MockStrategy,
  createEnvironmentSimulationConfig,
  createInjectionConfig,
  createToolSimulationConfig,
} from '@google/adk';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {logger} from '../../../src/utils/logger.js';

import {
  FAKE_SIMULATION_MODEL,
  FakeTool,
  createToolContext,
  recordedRequests,
  resetFakeModel,
  scriptModelAnswer,
} from './simulation_test_support.js';

/** The answer the fake model gives when a mock strategy asks it. */
const MOCKED_ANSWER = '{"mocked": true}';

describe('EnvironmentSimulationEngine.simulate', () => {
  beforeEach(() => {
    resetFakeModel();
  });

  it('test_simulate_no_op_for_unconfigured_tool', async () => {
    const config = createEnvironmentSimulationConfig({
      toolSimulationConfigs: [
        createToolSimulationConfig({
          toolName: 'configured_tool',
          mockStrategyType: MockStrategy.MOCK_STRATEGY_TOOL_SPEC,
        }),
      ],
      simulationModel: FAKE_SIMULATION_MODEL,
      simulationModelConfiguration: {},
    });

    const result = await new EnvironmentSimulationEngine(config).simulate({
      tool: new FakeTool({name: 'unconfigured_tool'}),
      args: {},
      toolContext: createToolContext(),
    });

    expect(result).toBeUndefined();
    expect(recordedRequests).toHaveLength(0);
  });

  it('test_injection_with_matching_args', async () => {
    const config = createEnvironmentSimulationConfig({
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
      simulationModel: FAKE_SIMULATION_MODEL,
      simulationModelConfiguration: {},
    });

    const result = await new EnvironmentSimulationEngine(config).simulate({
      tool: new FakeTool({name: 'test_tool'}),
      args: {param: 'value'},
      toolContext: createToolContext(),
    });

    expect(result).toEqual({injected: true});
  });

  it('test_injection_not_applied_with_mismatched_args', async () => {
    scriptModelAnswer(MOCKED_ANSWER);
    const modelConfig = {temperature: 0.25};
    const config = createEnvironmentSimulationConfig({
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
      simulationModel: FAKE_SIMULATION_MODEL,
      simulationModelConfiguration: modelConfig,
    });

    const result = await new EnvironmentSimulationEngine(config).simulate({
      tool: new FakeTool({name: 'test_tool'}),
      args: {param: 'different_value'},
      toolContext: createToolContext(),
    });

    expect(result).toEqual({mocked: true});
    // adk-python asserts the strategy factory saw the configured strategy,
    // model and model configuration. adk-js asserts the same wiring one step
    // further on, where the strategy calls that model with that configuration.
    expect(recordedRequests).toHaveLength(1);
    expect(recordedRequests[0].model).toBe(FAKE_SIMULATION_MODEL);
    expect(recordedRequests[0].config).toBe(modelConfig);
  });

  it('test_no_op_when_no_injection_hit_and_unspecified_strategy', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const config = createEnvironmentSimulationConfig({
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
      simulationModel: FAKE_SIMULATION_MODEL,
      simulationModelConfiguration: {},
    });

    const result = await new EnvironmentSimulationEngine(config).simulate({
      tool: new FakeTool({name: 'test_tool'}),
      args: {param: 'different_value'},
      toolContext: createToolContext(),
    });

    expect(result).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(
        'did not hit any injection config and has no mock strategy',
      ),
    );
    expect(recordedRequests).toHaveLength(0);
    warn.mockRestore();
  });

  // adk-python hard-codes the outcome CPython's Mersenne Twister produces for
  // seeds 42 and 100. JavaScript has no seedable Math.random, so this asserts
  // the ported property instead: one seed always makes the same decision. See
  // divergence D1 in the pull request body.
  it('test_injection_with_random_seed_is_deterministic', async () => {
    function simulateWithSeed(randomSeed: number) {
      const config = createEnvironmentSimulationConfig({
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
        simulationModel: FAKE_SIMULATION_MODEL,
        simulationModelConfiguration: {},
      });
      return new EnvironmentSimulationEngine(config).simulate({
        tool: new FakeTool({name: 'test_tool'}),
        args: {},
        toolContext: createToolContext(),
      });
    }

    scriptModelAnswer(MOCKED_ANSWER);
    scriptModelAnswer(MOCKED_ANSWER);
    const firstOutcomes = [
      await simulateWithSeed(42),
      await simulateWithSeed(100),
    ];
    const secondOutcomes = [
      await simulateWithSeed(42),
      await simulateWithSeed(100),
    ];

    expect(secondOutcomes).toEqual(firstOutcomes);
    // The two seeds draw different numbers, so exactly one of them injects.
    expect(firstOutcomes).toContainEqual({injected: true});
    expect(firstOutcomes).toContainEqual({mocked: true});
  });

  it('test_injected_latency_awaits_asyncio_sleep', async () => {
    vi.useFakeTimers();
    const latencySeconds = 0.2;
    const config = createEnvironmentSimulationConfig({
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
      simulationModel: FAKE_SIMULATION_MODEL,
      simulationModelConfiguration: {},
    });

    let settled = false;
    const pending = new EnvironmentSimulationEngine(config)
      .simulate({
        tool: new FakeTool({name: 'test_tool'}),
        args: {},
        toolContext: createToolContext(),
      })
      .then((result) => {
        settled = true;
        return result;
      });

    await vi.advanceTimersByTimeAsync(latencySeconds * 1000 - 1);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toEqual({injected: true});
  });

  afterEach(() => {
    vi.useRealTimers();
  });
});
