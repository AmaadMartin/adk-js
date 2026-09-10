/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  EnvironmentSimulationConfigParams,
  FeatureName,
  InjectedError,
  InjectionConfigParams,
  InputValidationError,
  MockStrategy,
  ToolSimulationConfig,
  createEnvironmentSimulationConfig,
  createInjectedError,
  createInjectionConfig,
  createToolSimulationConfig,
  isFeatureEnabled,
  overrideFeatureEnabled,
} from '@google/adk';
import {afterEach, beforeAll, describe, expect, it} from 'vitest';

function injectedError(): InjectedError {
  return createInjectedError({
    injectedHttpErrorCode: 404,
    errorMessage: 'not found',
  });
}

function toolConfig(toolName = 'my_tool'): ToolSimulationConfig {
  return createToolSimulationConfig({
    toolName,
    mockStrategyType: MockStrategy.MOCK_STRATEGY_TOOL_SPEC,
  });
}

function expectInputValidationError(
  call: () => unknown,
  messageFragment: string,
): void {
  expect(call).toThrow(InputValidationError);
  expect(call).toThrow(messageFragment);
}

/*
 * The three describe blocks below are ported from google/adk-python at
 * 44e0b2a8b121,
 * `tests/unittests/tools/environment_simulation/test_environment_simulation_config.py`.
 * All 10 reference tests are here, and each keeps its Python name.
 *
 * Two translation notes:
 * - adk-python raises `pydantic.ValidationError`; adk-js raises
 *   `InputValidationError`.
 * - A message that names a field names the camelCase spelling, so the matched
 *   substring differs wherever a field appears in it. `Duplicate tool_name
 *   found` is unchanged, because `tool_name` there labels the repeated value
 *   rather than a field.
 */

describe('InjectionConfig.check_injected_error_or_response', () => {
  it('test_neither_error_nor_response_raises', () => {
    expectInputValidationError(
      () => createInjectionConfig(),
      'but not both, and not neither',
    );
  });

  it('test_both_error_and_response_raises', () => {
    expectInputValidationError(
      () =>
        createInjectionConfig({
          injectedError: injectedError(),
          injectedResponse: {status: 'ok'},
        }),
      'but not both, and not neither',
    );
  });

  it('test_only_error_is_accepted', () => {
    const config = createInjectionConfig({injectedError: injectedError()});

    expect(config.injectedError?.injectedHttpErrorCode).toBe(404);
    expect(config.injectedResponse).toBeUndefined();
  });

  it('test_only_response_is_accepted', () => {
    const config = createInjectionConfig({injectedResponse: {status: 'ok'}});

    expect(config.injectedResponse).toEqual({status: 'ok'});
    expect(config.injectedError).toBeUndefined();
  });
});

describe('ToolSimulationConfig.check_mock_strategy_type', () => {
  it('test_no_injections_and_unspecified_strategy_raises', () => {
    expectInputValidationError(
      () => createToolSimulationConfig({toolName: 'my_tool'}),
      'mockStrategyType cannot be MOCK_STRATEGY_UNSPECIFIED',
    );
  });

  it('test_injections_alone_are_enough', () => {
    const config = createToolSimulationConfig({
      toolName: 'my_tool',
      injectionConfigs: [
        createInjectionConfig({injectedError: injectedError()}),
      ],
    });

    expect(config.mockStrategyType).toBe(
      MockStrategy.MOCK_STRATEGY_UNSPECIFIED,
    );
    expect(config.injectionConfigs).toHaveLength(1);
    expect(config.injectionConfigs[0].injectedError?.errorMessage).toBe(
      'not found',
    );
  });

  it('test_strategy_alone_is_enough', () => {
    const config = createToolSimulationConfig({
      toolName: 'my_tool',
      mockStrategyType: MockStrategy.MOCK_STRATEGY_TOOL_SPEC,
    });

    expect(config.injectionConfigs).toEqual([]);
  });
});

describe('EnvironmentSimulationConfig.check_tool_simulation_configs', () => {
  it('test_explicitly_empty_tool_simulation_configs_raises', () => {
    expectInputValidationError(
      () => createEnvironmentSimulationConfig({toolSimulationConfigs: []}),
      'toolSimulationConfigs must be provided',
    );
  });

  it('test_duplicate_tool_names_raise_and_name_the_duplicate', () => {
    const toolConfig = createToolSimulationConfig({
      toolName: 'dup_tool',
      mockStrategyType: MockStrategy.MOCK_STRATEGY_TOOL_SPEC,
    });

    expectInputValidationError(
      () =>
        createEnvironmentSimulationConfig({
          toolSimulationConfigs: [toolConfig, {...toolConfig}],
        }),
      'Duplicate tool_name found: dup_tool',
    );
  });

  it('test_distinct_tool_names_are_kept_in_order', () => {
    const config = createEnvironmentSimulationConfig({
      toolSimulationConfigs: [
        createToolSimulationConfig({
          toolName: 'first',
          mockStrategyType: MockStrategy.MOCK_STRATEGY_TOOL_SPEC,
        }),
        createToolSimulationConfig({
          toolName: 'second',
          mockStrategyType: MockStrategy.MOCK_STRATEGY_TRACING,
        }),
      ],
    });

    expect(config.toolSimulationConfigs.map((c) => c.toolName)).toEqual([
      'first',
      'second',
    ]);
    expect(config.toolSimulationConfigs[1].mockStrategyType).toBe(
      MockStrategy.MOCK_STRATEGY_TRACING,
    );
  });
});

describe('createEnvironmentSimulationConfig defaults', () => {
  it('applies the reference defaults', () => {
    const config = createEnvironmentSimulationConfig({
      toolSimulationConfigs: [toolConfig()],
    });

    expect(config.simulationModel).toBe('gemini-2.5-flash');
    expect(config.simulationModelConfiguration.thinkingConfig).toEqual({
      includeThoughts: false,
      thinkingBudget: 10240,
    });
    expect(config.tracing).toBeUndefined();
    expect(config.environmentData).toBeUndefined();
  });

  it('gives each config its own model configuration object', () => {
    const first = createEnvironmentSimulationConfig();
    const second = createEnvironmentSimulationConfig();

    expect(first.simulationModelConfiguration).not.toBe(
      second.simulationModelConfiguration,
    );
  });

  it('applies the reference injection defaults', () => {
    const config = createInjectionConfig({injectedResponse: {status: 'ok'}});

    expect(config.injectionProbability).toBe(1);
    expect(config.injectedLatencySeconds).toBe(0);
  });
});

describe('the tool simulation configs default is not validated', () => {
  it('accepts an omitted list and holds an empty one', () => {
    // pydantic runs a field validator over a supplied value but never over a
    // default, so adk-python accepts this and rejects an explicit `[]`.
    const config = createEnvironmentSimulationConfig();

    expect(config.toolSimulationConfigs).toEqual([]);
  });

  it('rejects an explicitly empty list', () => {
    expect(() =>
      createEnvironmentSimulationConfig({toolSimulationConfigs: []}),
    ).toThrow('toolSimulationConfigs must be provided.');
  });
});

describe('an empty injected response counts as unset', () => {
  it('rejects an empty injected response on its own', () => {
    // Python evaluates `bool(injected_response)`, and `bool({})` is False.
    expect(() => createInjectionConfig({injectedResponse: {}})).toThrow(
      'but not both, and not neither',
    );
  });

  it('accepts an empty injected response alongside an injected error', () => {
    const config = createInjectionConfig({
      injectedError: createInjectedError({
        injectedHttpErrorCode: 500,
        errorMessage: 'boom',
      }),
      injectedResponse: {},
    });

    expect(config.injectedResponse).toEqual({});
  });
});

describe('injected latency has an upper bound and no lower bound', () => {
  it.each([0, 120, -1])('accepts %d seconds', (injectedLatencySeconds) => {
    const config = createInjectionConfig({
      injectedResponse: {status: 'ok'},
      injectedLatencySeconds,
    });

    expect(config.injectedLatencySeconds).toBe(injectedLatencySeconds);
  });

  it('rejects more than 120 seconds', () => {
    expect(() =>
      createInjectionConfig({
        injectedResponse: {status: 'ok'},
        injectedLatencySeconds: 120.1,
      }),
    ).toThrow(InputValidationError);
  });
});

describe('unknown keys are rejected', () => {
  // Deliberately stricter than adk-python, whose BaseModel drops an unknown key
  // in silence. A typo in a config document is a defect worth reporting.
  it('rejects an unknown key on an injection config', () => {
    const params: InjectionConfigParams = {injectedResponse: {status: 'ok'}};
    const withUnknownKey = {...params, injectionProbabilty: 0.5};

    expect(() => createInjectionConfig(withUnknownKey)).toThrow(
      'Unrecognized key',
    );
  });

  it('rejects an unknown key on an environment simulation config', () => {
    const params: EnvironmentSimulationConfigParams = {
      toolSimulationConfigs: [toolConfig()],
    };
    const withUnknownKey = {...params, tracingPath: 'prior_run_trace'};

    expect(() => createEnvironmentSimulationConfig(withUnknownKey)).toThrow(
      'Unrecognized key',
    );
  });
});

describe('nested configs are validated too', () => {
  it('reports a bad injection config reached through a tool config', () => {
    const broken = createInjectionConfig({injectedResponse: {status: 'ok'}});
    delete broken.injectedResponse;

    expect(() =>
      createToolSimulationConfig({
        toolName: 'my_tool',
        injectionConfigs: [broken],
      }),
    ).toThrow('but not both, and not neither');
  });
});

describe('every factory is gated on the feature flag', () => {
  beforeAll(() => {
    // The registry logs "[EXPERIMENTAL] feature ... is enabled" once per
    // process. Burn it here so it cannot land in another test's logger spy.
    isFeatureEnabled(FeatureName.ENVIRONMENT_SIMULATION);
  });

  afterEach(() => {
    overrideFeatureEnabled(FeatureName.ENVIRONMENT_SIMULATION, undefined);
  });

  it.each([
    [
      'createInjectedError',
      () =>
        createInjectedError({injectedHttpErrorCode: 404, errorMessage: 'no'}),
    ],
    [
      'createInjectionConfig',
      () => createInjectionConfig({injectedResponse: {status: 'ok'}}),
    ],
    ['createToolSimulationConfig', () => toolConfig()],
    ['createEnvironmentSimulationConfig', createEnvironmentSimulationConfig],
  ])('%s throws when the feature is disabled', (_name, call) => {
    overrideFeatureEnabled(FeatureName.ENVIRONMENT_SIMULATION, false);

    expect(call).toThrow('Feature ENVIRONMENT_SIMULATION is not enabled.');
  });
});
