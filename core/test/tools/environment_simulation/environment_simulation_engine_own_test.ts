/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Cases adk-python does not test, because it patches the analyzer and the
 * strategy factory away: when the analysis runs, deep argument matching, the
 * injected error body, the strategy factory and the feature gate. The ported
 * reference tests live in `environment_simulation_engine_test.ts`.
 */

import {
  createEnvironmentSimulationConfig,
  createInjectedError,
  createInjectionConfig,
  createToolSimulationConfig,
  EnvironmentSimulationConfigParams,
  EnvironmentSimulationEngine,
  EnvironmentSimulationFactory,
  FeatureName,
  LlmAgent,
  MockStrategy,
  overrideFeatureEnabled,
} from '@google/adk';
import {createMockStrategy} from '@google/adk/tools/environment_simulation/environment_simulation_engine.js';
import {logger} from '@google/adk/utils/logger.js';
import {createSeededRandom} from '@google/adk/utils/random_utils.js';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {
  FakeLlm,
  FakeTool,
  installFakeLlm,
  makeToolContext,
} from './simulation_test_utils.js';

/** A phrase only the tool connection analysis prompt contains. */
const ANALYSIS_PROMPT_MARKER = 'expert software architect';

/** Serves both the analyzer and the mock strategy in one fixed response. */
const SHARED_MODEL_RESPONSE = '{"stateful_parameters": [], "mocked": true}';

let fakeLlm: FakeLlm;

function makeConfig(params: EnvironmentSimulationConfigParams) {
  return createEnvironmentSimulationConfig({
    simulationModel: 'fake-model',
    simulationModelConfiguration: {},
    ...params,
  });
}

function mockedToolConfig(toolName: string) {
  return createToolSimulationConfig({
    toolName,
    mockStrategyType: MockStrategy.MOCK_STRATEGY_TOOL_SPEC,
  });
}

function countAnalysisPrompts(): number {
  return fakeLlm.requests.filter((request) =>
    request.contents[0].parts?.[0].text?.includes(ANALYSIS_PROMPT_MARKER),
  ).length;
}

function makeLlmAgentContext() {
  return makeToolContext(
    new LlmAgent({
      name: 'test_agent',
      model: 'fake-model',
      tools: [new FakeTool('test_tool')],
    }),
  );
}

describe('EnvironmentSimulationEngine analysis', () => {
  beforeEach(() => {
    fakeLlm = installFakeLlm(SHARED_MODEL_RESPONSE);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('analyzes the agent tools once across two calls', async () => {
    const engine = new EnvironmentSimulationEngine(
      makeConfig({toolSimulationConfigs: [mockedToolConfig('test_tool')]}),
    );
    const tool = new FakeTool('test_tool');

    await engine.simulate(tool, {}, makeLlmAgentContext());
    await engine.simulate(tool, {}, makeLlmAgentContext());

    expect(countAnalysisPrompts()).toBe(1);
  });

  it('does not analyze when every tool leaves the strategy unspecified', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const engine = new EnvironmentSimulationEngine(
      makeConfig({
        toolSimulationConfigs: [
          createToolSimulationConfig({
            toolName: 'test_tool',
            injectionConfigs: [
              createInjectionConfig({
                matchArgs: {never: 'matches'},
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
      makeLlmAgentContext(),
    );

    expect(result).toBeUndefined();
    expect(countAnalysisPrompts()).toBe(0);
    expect(warn).toHaveBeenCalledOnce();
  });

  it('gives up on analysis for good when the first agent is not an LlmAgent', async () => {
    const engine = new EnvironmentSimulationEngine(
      makeConfig({toolSimulationConfigs: [mockedToolConfig('test_tool')]}),
    );
    const tool = new FakeTool('test_tool');

    await engine.simulate(tool, {}, makeToolContext());
    await engine.simulate(tool, {}, makeLlmAgentContext());

    expect(countAnalysisPrompts()).toBe(0);
  });
});

describe('EnvironmentSimulationEngine injection rules', () => {
  beforeEach(() => {
    fakeLlm = installFakeLlm(SHARED_MODEL_RESPONSE);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function engineMatching(matchArgs: Record<string, unknown>) {
    return new EnvironmentSimulationEngine(
      makeConfig({
        toolSimulationConfigs: [
          createToolSimulationConfig({
            toolName: 'test_tool',
            injectionConfigs: [
              createInjectionConfig({
                matchArgs,
                injectedResponse: {injected: true},
              }),
            ],
            mockStrategyType: MockStrategy.MOCK_STRATEGY_TOOL_SPEC,
          }),
        ],
      }),
    );
  }

  it('matches a nested object argument by value', async () => {
    const engine = engineMatching({filter: {city: 'sf'}});

    const result = await engine.simulate(
      new FakeTool('test_tool'),
      {filter: {city: 'sf'}},
      makeToolContext(),
    );

    expect(result).toEqual({injected: true});
  });

  it('skips the rule when a nested argument value differs', async () => {
    const engine = engineMatching({filter: {city: 'sf'}});

    const result = await engine.simulate(
      new FakeTool('test_tool'),
      {filter: {city: 'la'}},
      makeToolContext(),
    );

    expect(result).toEqual({stateful_parameters: [], mocked: true});
  });

  it('skips the rule when the matched argument is absent', async () => {
    const engine = engineMatching({filter: undefined});

    const result = await engine.simulate(
      new FakeTool('test_tool'),
      {},
      makeToolContext(),
    );

    expect(result).toEqual({stateful_parameters: [], mocked: true});
  });

  it('draws the same outcome twice for one seed', async () => {
    const engine = new EnvironmentSimulationEngine(
      makeConfig({
        toolSimulationConfigs: [
          createToolSimulationConfig({
            toolName: 'test_tool',
            injectionConfigs: [
              createInjectionConfig({
                injectionProbability: 0.5,
                randomSeed: 100,
                injectedResponse: {injected: true},
              }),
            ],
            mockStrategyType: MockStrategy.MOCK_STRATEGY_TOOL_SPEC,
          }),
        ],
      }),
    );
    const tool = new FakeTool('test_tool');

    const first = await engine.simulate(tool, {}, makeToolContext());
    const second = await engine.simulate(tool, {}, makeToolContext());

    expect(first).toEqual({injected: true});
    expect(second).toEqual(first);
  });

  it('returns the injected error as an error_code and error_message pair', async () => {
    const engine = new EnvironmentSimulationEngine(
      makeConfig({
        toolSimulationConfigs: [
          createToolSimulationConfig({
            toolName: 'test_tool',
            injectionConfigs: [
              createInjectionConfig({
                injectedError: createInjectedError({
                  injectedHttpErrorCode: 404,
                  errorMessage: 'not found',
                }),
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

    expect(result).toEqual({error_code: 404, error_message: 'not found'});
  });

  it('does not fire when the draw equals the probability exactly', async () => {
    const probe = createSeededRandom();
    probe.seed(100);
    const exactDraw = probe.next();
    const engine = new EnvironmentSimulationEngine(
      makeConfig({
        toolSimulationConfigs: [
          createToolSimulationConfig({
            toolName: 'test_tool',
            injectionConfigs: [
              createInjectionConfig({
                injectionProbability: exactDraw,
                randomSeed: 100,
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
      {},
      makeToolContext(),
    );

    expect(result).toEqual({stateful_parameters: [], mocked: true});
  });

  it('tries the next rule when the first one does not fire', async () => {
    const engine = new EnvironmentSimulationEngine(
      makeConfig({
        toolSimulationConfigs: [
          createToolSimulationConfig({
            toolName: 'test_tool',
            injectionConfigs: [
              createInjectionConfig({
                injectionProbability: 0,
                injectedResponse: {first: true},
              }),
              createInjectionConfig({injectedResponse: {second: true}}),
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

    expect(result).toEqual({second: true});
  });
});

describe('createMockStrategy', () => {
  beforeEach(() => {
    installFakeLlm(SHARED_MODEL_RESPONSE);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reports the tracing strategy as not implemented', async () => {
    const strategy = createMockStrategy(
      MockStrategy.MOCK_STRATEGY_TRACING,
      'fake-model',
      {},
    );

    await expect(
      strategy.mock({
        tool: new FakeTool('test_tool'),
        args: {},
        toolConnectionMap: undefined,
        stateStore: {},
      }),
    ).resolves.toEqual({status: 'error', error_message: 'Not implemented'});
  });

  it('rejects a strategy type it cannot build', () => {
    expect(() =>
      createMockStrategy(
        MockStrategy.MOCK_STRATEGY_UNSPECIFIED,
        'fake-model',
        {},
      ),
    ).toThrow('Unknown mock strategy type: MOCK_STRATEGY_UNSPECIFIED');
  });

  it('routes MOCK_STRATEGY_TRACING through the engine', async () => {
    const engine = new EnvironmentSimulationEngine(
      createEnvironmentSimulationConfig({
        simulationModel: 'fake-model',
        simulationModelConfiguration: {},
        toolSimulationConfigs: [
          createToolSimulationConfig({
            toolName: 'test_tool',
            mockStrategyType: MockStrategy.MOCK_STRATEGY_TRACING,
          }),
        ],
      }),
    );

    const result = await engine.simulate(
      new FakeTool('test_tool'),
      {},
      makeToolContext(),
    );

    expect(result).toEqual({
      status: 'error',
      error_message: 'Not implemented',
    });
  });
});

describe('the ENVIRONMENT_SIMULATION feature gate', () => {
  const NOT_ENABLED_MESSAGE = 'Feature ENVIRONMENT_SIMULATION is not enabled.';

  beforeEach(() => {
    installFakeLlm(SHARED_MODEL_RESPONSE);
  });

  afterEach(() => {
    overrideFeatureEnabled(FeatureName.ENVIRONMENT_SIMULATION, undefined);
    vi.restoreAllMocks();
  });

  it('stops the engine, the callback and the plugin when it is off', () => {
    const config = createEnvironmentSimulationConfig({
      simulationModel: 'fake-model',
      simulationModelConfiguration: {},
      toolSimulationConfigs: [mockedToolConfig('test_tool')],
    });
    overrideFeatureEnabled(FeatureName.ENVIRONMENT_SIMULATION, false);

    expect(() => new EnvironmentSimulationEngine(config)).toThrow(
      NOT_ENABLED_MESSAGE,
    );
    expect(() => EnvironmentSimulationFactory.createCallback(config)).toThrow(
      NOT_ENABLED_MESSAGE,
    );
    expect(() => EnvironmentSimulationFactory.createPlugin(config)).toThrow(
      NOT_ENABLED_MESSAGE,
    );
  });
});
