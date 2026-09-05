/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ports
 * `tests/unittests/tools/environment_simulation/test_environment_simulation_engine.py`
 * from google/adk-python (`main`, commit `c7ef8cfa`). Every `it` title is the
 * name of the reference test it ports. The own tests live in
 * `environment_simulation_engine_own_test.ts`.
 *
 * adk-python patches `ToolConnectionAnalyzer` and `_create_mock_strategy` per
 * test. adk-js registers a fake model instead, so the real analyzer and the
 * real strategy run against scripted model output. A test that asserts a
 * fall-through to the mock strategy therefore asserts the strategy's response
 * rather than a call record.
 */

import {
  EnvironmentSimulationEngine,
  Logger,
  MockStrategy,
  ToolSimulationConfigParams,
  createEnvironmentSimulationConfig,
  createInjectionConfig,
  createToolSimulationConfig,
  getLogger,
  setLogger,
} from '@google/adk';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {
  FAKE_SIMULATION_MODEL,
  RecordingLogger,
  UncallableTool,
  createToolContext,
  scriptModel,
} from './simulation_test_support.js';

function engineFor(
  toolConfig: ToolSimulationConfigParams,
): EnvironmentSimulationEngine {
  return new EnvironmentSimulationEngine(
    createEnvironmentSimulationConfig({
      toolSimulationConfigs: [createToolSimulationConfig(toolConfig)],
      simulationModel: FAKE_SIMULATION_MODEL,
      simulationModelConfiguration: {},
    }),
  );
}

describe('EnvironmentSimulationEngine.simulate', () => {
  let previousLogger: Logger;
  let recordingLogger: RecordingLogger;

  beforeEach(() => {
    previousLogger = getLogger();
    recordingLogger = new RecordingLogger();
    setLogger(recordingLogger);
    scriptModel();
  });

  afterEach(() => {
    setLogger(previousLogger);
  });

  it('test_simulate_no_op_for_unconfigured_tool', async () => {
    const engine = engineFor({
      toolName: 'configured_tool',
      mockStrategyType: MockStrategy.MOCK_STRATEGY_TOOL_SPEC,
    });

    const result = await engine.simulate({
      tool: new UncallableTool('unconfigured_tool'),
      args: {},
      context: createToolContext(),
    });

    expect(result).toBeUndefined();
  });

  it('test_injection_with_matching_args', async () => {
    const engine = engineFor({
      toolName: 'test_tool',
      injectionConfigs: [
        createInjectionConfig({
          matchArgs: {param: 'value'},
          injectedResponse: {injected: true},
        }),
      ],
    });

    const result = await engine.simulate({
      tool: new UncallableTool('test_tool'),
      args: {param: 'value'},
      context: createToolContext(),
    });

    expect(result).toEqual({injected: true});
  });

  it('test_injection_not_applied_with_mismatched_args', async () => {
    scriptModel('{"mocked": true}');
    const engine = engineFor({
      toolName: 'test_tool',
      injectionConfigs: [
        createInjectionConfig({
          matchArgs: {param: 'value'},
          injectedResponse: {injected: true},
        }),
      ],
      mockStrategyType: MockStrategy.MOCK_STRATEGY_TOOL_SPEC,
    });

    const result = await engine.simulate({
      tool: new UncallableTool('test_tool'),
      args: {param: 'different_value'},
      context: createToolContext(),
    });

    expect(result).toEqual({mocked: true});
  });

  it('test_no_op_when_no_injection_hit_and_unspecified_strategy', async () => {
    const engine = engineFor({
      toolName: 'test_tool',
      injectionConfigs: [
        createInjectionConfig({
          matchArgs: {param: 'value'},
          injectedResponse: {injected: true},
        }),
      ],
      mockStrategyType: MockStrategy.MOCK_STRATEGY_UNSPECIFIED,
    });

    const result = await engine.simulate({
      tool: new UncallableTool('test_tool'),
      args: {param: 'different_value'},
      context: createToolContext(),
    });

    expect(result).toBeUndefined();
    expect(recordingLogger.warnings.join('\n')).toContain(
      'did not hit any injection config and has no mock strategy',
    );
  });

  it('test_injection_with_random_seed_is_deterministic', async () => {
    // adk-python's seeds carry over unchanged even though the generator does
    // not: CPython uses a Mersenne Twister and adk-js a mulberry32, and both
    // land seed 42's first draw above 0.5 and seed 100's below it.
    scriptModel('{"mocked": true}');
    const mockedEngine = engineFor({
      toolName: 'test_tool',
      injectionConfigs: [
        createInjectionConfig({
          injectionProbability: 0.5,
          randomSeed: 42,
          injectedResponse: {injected: true},
        }),
      ],
      mockStrategyType: MockStrategy.MOCK_STRATEGY_TOOL_SPEC,
    });
    const tool = new UncallableTool('test_tool');

    const mockedResult = await mockedEngine.simulate({
      tool,
      args: {},
      context: createToolContext(),
    });

    expect(mockedResult).toEqual({mocked: true});

    const injectedEngine = engineFor({
      toolName: 'test_tool',
      injectionConfigs: [
        createInjectionConfig({
          injectionProbability: 0.5,
          randomSeed: 100,
          injectedResponse: {injected: true},
        }),
      ],
      mockStrategyType: MockStrategy.MOCK_STRATEGY_TOOL_SPEC,
    });

    const injectedResult = await injectedEngine.simulate({
      tool,
      args: {},
      context: createToolContext(),
    });

    expect(injectedResult).toEqual({injected: true});
  });

  it('test_injected_latency_awaits_asyncio_sleep', async () => {
    // Regression guard against a blocking sleep, and against reading the
    // config's seconds as milliseconds.
    vi.useFakeTimers();
    try {
      const engine = engineFor({
        toolName: 'test_tool',
        injectionConfigs: [
          createInjectionConfig({
            injectedLatencySeconds: 0.2,
            injectedResponse: {injected: true},
          }),
        ],
      });

      let settled = false;
      const pending = engine
        .simulate({
          tool: new UncallableTool('test_tool'),
          args: {},
          context: createToolContext(),
        })
        .then((result) => {
          settled = true;
          return result;
        });

      await vi.advanceTimersByTimeAsync(199);
      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      expect(await pending).toEqual({injected: true});
    } finally {
      vi.useRealTimers();
    }
  });
});
