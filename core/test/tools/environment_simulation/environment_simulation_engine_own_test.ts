/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  EnvironmentSimulationConfig,
  EnvironmentSimulationEngine,
  InjectionConfig,
  InputValidationError,
  LlmAgent,
  MockStrategy,
  SequentialAgent,
  createEnvironmentSimulationConfig,
  createInjectedError,
  createInjectionConfig,
  createToolSimulationConfig,
} from '@google/adk';
import {beforeEach, describe, expect, it} from 'vitest';

import {createMockStrategy} from '../../../src/tools/environment_simulation/environment_simulation_engine.js';

import {
  FAKE_SIMULATION_MODEL,
  FakeTool,
  createToolContext,
  recordedRequests,
  resetFakeModel,
  scriptModelAnswer,
} from './simulation_test_support.js';

const TOOL_NAME = 'test_tool';

/** Builds a config whose single tool carries `injectionConfigs`. */
function createInjectingConfig(
  injectionConfigs: InjectionConfig[],
  mockStrategyType = MockStrategy.MOCK_STRATEGY_UNSPECIFIED,
): EnvironmentSimulationConfig {
  return createEnvironmentSimulationConfig({
    toolSimulationConfigs: [
      createToolSimulationConfig({
        toolName: TOOL_NAME,
        injectionConfigs,
        mockStrategyType,
      }),
    ],
    simulationModel: FAKE_SIMULATION_MODEL,
    simulationModelConfiguration: {},
  });
}

function simulate(
  config: EnvironmentSimulationConfig,
  args: Record<string, unknown> = {},
): Promise<Record<string, unknown> | undefined> {
  return new EnvironmentSimulationEngine(config).simulate({
    tool: new FakeTool({name: TOOL_NAME}),
    args,
    toolContext: createToolContext(),
  });
}

describe('EnvironmentSimulationEngine injected errors', () => {
  it('returns the error code and message under their wire names', async () => {
    const config = createInjectingConfig([
      createInjectionConfig({
        injectedError: createInjectedError({
          injectedHttpErrorCode: 404,
          errorMessage: 'City not found.',
        }),
      }),
    ]);

    expect(await simulate(config)).toEqual({
      error_code: 404,
      error_message: 'City not found.',
    });
  });
});

describe('EnvironmentSimulationEngine matchArgs', () => {
  const config = createInjectingConfig([
    createInjectionConfig({
      matchArgs: {city: 'Munich'},
      injectedResponse: {injected: true},
    }),
  ]);

  it('matches a call that carries extra arguments', async () => {
    expect(await simulate(config, {city: 'Munich', unit: 'C'})).toEqual({
      injected: true,
    });
  });

  it('does not match a call that omits the key', async () => {
    expect(await simulate(config, {unit: 'C'})).toBeUndefined();
  });

  it('does not match a call whose value differs', async () => {
    expect(await simulate(config, {city: 'Berlin'})).toBeUndefined();
  });

  it('does not match an undefined argument value', async () => {
    expect(await simulate(config, {city: undefined})).toBeUndefined();
  });
});

describe('EnvironmentSimulationEngine injection order', () => {
  it('returns the first rule that matches and stops', async () => {
    const config = createInjectingConfig([
      createInjectionConfig({injectedResponse: {rule: 'first'}}),
      createInjectionConfig({injectedResponse: {rule: 'second'}}),
    ]);

    expect(await simulate(config)).toEqual({rule: 'first'});
  });

  it('skips a rule whose arguments do not match and tries the next', async () => {
    const config = createInjectingConfig([
      createInjectionConfig({
        matchArgs: {city: 'Munich'},
        injectedResponse: {rule: 'first'},
      }),
      createInjectionConfig({injectedResponse: {rule: 'second'}}),
    ]);

    expect(await simulate(config, {city: 'Berlin'})).toEqual({rule: 'second'});
  });

  it('never fires a rule whose probability is zero', async () => {
    const config = createInjectingConfig([
      createInjectionConfig({
        injectionProbability: 0,
        injectedResponse: {rule: 'never'},
      }),
      createInjectionConfig({injectedResponse: {rule: 'always'}}),
    ]);

    expect(await simulate(config)).toEqual({rule: 'always'});
  });

  it('always fires a rule whose probability is one', async () => {
    const config = createInjectingConfig([
      createInjectionConfig({
        injectionProbability: 1,
        injectedResponse: {rule: 'always'},
      }),
    ]);

    for (let attempt = 0; attempt < 20; attempt++) {
      expect(await simulate(config)).toEqual({rule: 'always'});
    }
  });
});

describe('EnvironmentSimulationEngine mock strategies', () => {
  beforeEach(() => {
    resetFakeModel();
  });

  it('returns the tracing strategy stub', async () => {
    const config = createInjectingConfig(
      [],
      MockStrategy.MOCK_STRATEGY_TRACING,
    );

    expect(await simulate(config)).toEqual({
      status: 'error',
      error_message: 'Not implemented',
    });
    expect(recordedRequests).toHaveLength(0);
  });

  it('rejects a strategy type that names no strategy', () => {
    // simulate() answers an UNSPECIFIED tool itself, so the factory only ever
    // sees this value when that guard is gone.
    const buildUnspecified = () =>
      createMockStrategy({
        mockStrategyType: MockStrategy.MOCK_STRATEGY_UNSPECIFIED,
        model: FAKE_SIMULATION_MODEL,
        modelConfig: {},
      });

    expect(buildUnspecified).toThrow(InputValidationError);
    expect(buildUnspecified).toThrow(
      'Unknown mock strategy type: MOCK_STRATEGY_UNSPECIFIED',
    );
  });

  it('passes the environment data and the tracing history to the strategy', async () => {
    scriptModelAnswer('{"mocked": true}');
    const config = createEnvironmentSimulationConfig({
      toolSimulationConfigs: [
        createToolSimulationConfig({
          toolName: TOOL_NAME,
          mockStrategyType: MockStrategy.MOCK_STRATEGY_TOOL_SPEC,
        }),
      ],
      simulationModel: FAKE_SIMULATION_MODEL,
      simulationModelConfiguration: {},
      environmentData: '{"cities": ["Munich"]}',
      tracing: '{"calls": []}',
    });

    expect(await simulate(config)).toEqual({mocked: true});
    const prompt = recordedRequests[0].contents[0].parts?.[0].text ?? '';
    expect(prompt).toContain('{"cities": ["Munich"]}');
    expect(prompt).toContain('{"calls": []}');
  });
});

describe('EnvironmentSimulationEngine tool connection analysis', () => {
  beforeEach(() => {
    resetFakeModel();
  });

  function createMockingConfig(): EnvironmentSimulationConfig {
    return createEnvironmentSimulationConfig({
      toolSimulationConfigs: [
        createToolSimulationConfig({
          toolName: TOOL_NAME,
          mockStrategyType: MockStrategy.MOCK_STRATEGY_TOOL_SPEC,
        }),
      ],
      simulationModel: FAKE_SIMULATION_MODEL,
      simulationModelConfiguration: {},
    });
  }

  it('analyzes once and reuses the map on later calls', async () => {
    scriptModelAnswer(
      '{"stateful_parameters": [{"parameter_name": "ticket_id",' +
        ' "creating_tools": [], "consuming_tools": ["test_tool"]}]}',
    );
    scriptModelAnswer('{"mocked": 1}');
    scriptModelAnswer('{"mocked": 2}');

    const tool = new FakeTool({name: TOOL_NAME});
    const engine = new EnvironmentSimulationEngine(createMockingConfig());
    const toolContext = createToolContext(
      new LlmAgent({
        name: 'test_agent',
        model: FAKE_SIMULATION_MODEL,
        tools: [tool],
      }),
    );

    await engine.simulate({tool, args: {}, toolContext});
    await engine.simulate({tool, args: {}, toolContext});

    expect(recordedRequests).toHaveLength(3);
    const secondPrompt = recordedRequests[2].contents[0].parts?.[0].text ?? '';
    expect(secondPrompt).toContain('ticket_id');
  });

  it('skips the analysis when no tool asks for a mock strategy', async () => {
    const tool = new FakeTool({name: TOOL_NAME});
    const engine = new EnvironmentSimulationEngine(
      createInjectingConfig([
        createInjectionConfig({injectedResponse: {injected: true}}),
      ]),
    );

    await engine.simulate({
      tool,
      args: {},
      toolContext: createToolContext(
        new LlmAgent({
          name: 'test_agent',
          model: FAKE_SIMULATION_MODEL,
          tools: [tool],
        }),
      ),
    });

    expect(recordedRequests).toHaveLength(0);
  });

  it('skips the analysis when the agent is not an LlmAgent, and does not retry it', async () => {
    scriptModelAnswer('{"mocked": 1}');
    scriptModelAnswer('{"mocked": 2}');

    const tool = new FakeTool({name: TOOL_NAME});
    const engine = new EnvironmentSimulationEngine(createMockingConfig());
    const toolContext = createToolContext(
      new SequentialAgent({name: 'not_an_llm_agent'}),
    );

    expect(await engine.simulate({tool, args: {}, toolContext})).toEqual({
      mocked: 1,
    });
    expect(await engine.simulate({tool, args: {}, toolContext})).toEqual({
      mocked: 2,
    });

    // Two mock calls and no analysis call.
    expect(recordedRequests).toHaveLength(2);
  });
});
