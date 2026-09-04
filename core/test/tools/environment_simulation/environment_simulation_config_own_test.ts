/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * adk-js-only cases for the environment simulation config. None of these has a
 * counterpart in google/adk-python; the ported reference tests live in
 * `environment_simulation_config_test.ts`.
 */

import {
  EnvironmentSimulationConfigParams,
  FeatureName,
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

function toolConfig(toolName = 'my_tool'): ToolSimulationConfig {
  return createToolSimulationConfig({
    toolName,
    mockStrategyType: MockStrategy.MOCK_STRATEGY_TOOL_SPEC,
  });
}

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
