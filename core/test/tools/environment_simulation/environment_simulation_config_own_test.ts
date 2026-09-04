/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Cases adk-python does not test, because pydantic covers them: the defaults,
 * the latency bound, the strict key check, the freshness of the returned
 * object, and the feature gate. The ported reference tests live in
 * `environment_simulation_config_test.ts`.
 */

import {
  EnvironmentSimulationConfig,
  FeatureName,
  FeatureStage,
  InjectedError,
  InjectionConfig,
  InputValidationError,
  MockStrategy,
  createEnvironmentSimulationConfig,
  createInjectedError,
  createInjectionConfig,
  createToolSimulationConfig,
  getFeatureConfig,
  overrideFeatureEnabled,
} from '@google/adk';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';

const DISABLE_ENV_VAR = 'ADK_DISABLE_ENVIRONMENT_SIMULATION';
const NOT_ENABLED_MESSAGE = 'Feature ENVIRONMENT_SIMULATION is not enabled.';

const DEFAULT_MODEL_CONFIGURATION = {
  thinkingConfig: {includeThoughts: false, thinkingBudget: 10240},
};

function injectedError(): InjectedError {
  return createInjectedError({
    injectedHttpErrorCode: 404,
    errorMessage: 'not found',
  });
}

/**
 * Feeds a factory a JSON document, which is how unchecked input reaches it in
 * practice. TypeScript cannot check a parsed document, so these exercise the
 * runtime validation rather than the compiler's excess-property check.
 */
function environmentConfigFromJson(json: string): EnvironmentSimulationConfig {
  return createEnvironmentSimulationConfig(JSON.parse(json));
}

function injectionConfigFromJson(json: string): InjectionConfig {
  return createInjectionConfig(JSON.parse(json));
}

describe('environment simulation config', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = {...originalEnv};
    delete process.env[DISABLE_ENV_VAR];
  });

  afterEach(() => {
    process.env = originalEnv;
    overrideFeatureEnabled(FeatureName.ENVIRONMENT_SIMULATION, undefined);
  });

  it('registers ENVIRONMENT_SIMULATION as experimental and on by default', () => {
    const config = getFeatureConfig(FeatureName.ENVIRONMENT_SIMULATION);

    expect(config?.stage).toBe(FeatureStage.EXPERIMENTAL);
    expect(config?.defaultOn).toBe(true);
  });

  describe('defaults', () => {
    it('leaves an omitted tool list empty instead of rejecting it', () => {
      const config = createEnvironmentSimulationConfig();

      expect(config.toolSimulationConfigs).toEqual([]);
    });

    it('names the simulation model and its thinking budget', () => {
      const config = createEnvironmentSimulationConfig();

      expect(config.simulationModel).toBe('gemini-2.5-flash');
      expect(config.simulationModelConfiguration).toEqual(
        DEFAULT_MODEL_CONFIGURATION,
      );
    });

    it('leaves tracing and environmentData unset', () => {
      const config = createEnvironmentSimulationConfig();

      expect(config.tracing).toBeUndefined();
      expect(config.environmentData).toBeUndefined();
    });

    it('defaults an injection rule to always firing with no latency', () => {
      const config = createInjectionConfig({injectedError: injectedError()});

      expect(config.injectionProbability).toBe(1);
      expect(config.injectedLatencySeconds).toBe(0);
      expect(config.matchArgs).toBeUndefined();
      expect(config.randomSeed).toBeUndefined();
    });

    it('defaults a tool to no injections and no mock strategy', () => {
      const config = createToolSimulationConfig({
        toolName: 'my_tool',
        injectionConfigs: [{injectedError: injectedError()}],
      });

      expect(config.injectionConfigs).toHaveLength(1);
      expect(config.mockStrategyType).toBe(
        MockStrategy.MOCK_STRATEGY_UNSPECIFIED,
      );
    });
  });

  // Only the object-ness of the model configuration is checked, so the genai
  // SDK stays the single source of truth for its field list.
  describe('simulation model configuration', () => {
    it('keeps a caller-supplied model configuration', () => {
      const simulationModelConfiguration = {temperature: 0.2};

      const config = createEnvironmentSimulationConfig({
        simulationModelConfiguration,
      });

      expect(config.simulationModelConfiguration).toEqual({temperature: 0.2});
    });

    it('rejects a model configuration that is not an object', () => {
      expect(() =>
        environmentConfigFromJson('{"simulationModelConfiguration": 7}'),
      ).toThrow(/Invalid EnvironmentSimulationConfig/);
    });

    it('rejects an array as a model configuration', () => {
      expect(() =>
        environmentConfigFromJson('{"simulationModelConfiguration": []}'),
      ).toThrow(InputValidationError);
    });
  });

  describe('injected latency bound', () => {
    it('accepts the maximum of 120 seconds', () => {
      const config = createInjectionConfig({
        injectedError: injectedError(),
        injectedLatencySeconds: 120,
      });

      expect(config.injectedLatencySeconds).toBe(120);
    });

    it('rejects a latency above 120 seconds', () => {
      expect(() =>
        createInjectionConfig({
          injectedError: injectedError(),
          injectedLatencySeconds: 120.5,
        }),
      ).toThrow(InputValidationError);
    });
  });

  // adk-python declares no bounds on `injection_probability`, so neither does
  // adk-js. Rejecting these would be a tightening nobody asked for.
  describe('injection probability', () => {
    it('accepts a probability above 1', () => {
      const config = createInjectionConfig({
        injectedError: injectedError(),
        injectionProbability: 1.5,
      });

      expect(config.injectionProbability).toBe(1.5);
    });

    it('accepts a negative probability', () => {
      const config = createInjectionConfig({
        injectedError: injectedError(),
        injectionProbability: -1,
      });

      expect(config.injectionProbability).toBe(-1);
    });
  });

  // adk-python compares `bool(injected_error) == bool(injected_response)`, and
  // an empty dict is falsy in Python.
  describe('empty injected response', () => {
    it('rejects an empty injectedResponse as unset', () => {
      expect(() => createInjectionConfig({injectedResponse: {}})).toThrow(
        /but not both, and not neither/,
      );
    });

    it('accepts an empty injectedResponse alongside an injectedError', () => {
      const config = createInjectionConfig({
        injectedError: injectedError(),
        injectedResponse: {},
      });

      expect(config.injectedResponse).toEqual({});
    });
  });

  describe('freshness', () => {
    it('returns a new object rather than the caller object', () => {
      const params = {simulationModel: 'gemini-2.5-pro'};

      const config = createEnvironmentSimulationConfig(params);
      params.simulationModel = 'changed-afterwards';

      expect(config.simulationModel).toBe('gemini-2.5-pro');
    });

    it('does not share the default model configuration between calls', () => {
      const first = createEnvironmentSimulationConfig();
      const second = createEnvironmentSimulationConfig();

      expect(first.simulationModelConfiguration).not.toBe(
        second.simulationModelConfiguration,
      );
    });

    it('does not share the default tool list between calls', () => {
      const first = createEnvironmentSimulationConfig();
      const second = createEnvironmentSimulationConfig();

      expect(first.toolSimulationConfigs).not.toBe(
        second.toolSimulationConfigs,
      );
    });
  });

  describe('strict keys', () => {
    it('rejects an unknown key on the environment config', () => {
      expect(() => environmentConfigFromJson('{"tracingPath": "x"}')).toThrow(
        InputValidationError,
      );
    });

    it('rejects the snake_case tool_simulation_configs spelling', () => {
      expect(() =>
        environmentConfigFromJson('{"tool_simulation_configs": []}'),
      ).toThrow(/Invalid EnvironmentSimulationConfig/);
    });

    it('rejects an unknown key on an injection rule', () => {
      expect(() =>
        injectionConfigFromJson('{"injectedResponse": {"a": 1}, "seed": 1}'),
      ).toThrow(/Invalid InjectionConfig/);
    });

    it('rejects a non-integer HTTP error code', () => {
      expect(() =>
        createInjectedError(
          JSON.parse('{"injectedHttpErrorCode": 4.5, "errorMessage": "x"}'),
        ),
      ).toThrow(/Invalid InjectedError/);
    });

    it('rejects a tool strategy that does not exist', () => {
      expect(() =>
        createToolSimulationConfig(
          JSON.parse('{"toolName": "t", "mockStrategyType": "NOPE"}'),
        ),
      ).toThrow(/Invalid ToolSimulationConfig/);
    });
  });

  // A nested rule is validated where it is nested, so an invalid rule cannot
  // reach a tool config, and an invalid tool config cannot reach the
  // environment config.
  describe('nested validation', () => {
    it('rejects an invalid injection rule inside a tool config', () => {
      expect(() =>
        createToolSimulationConfig({
          toolName: 'my_tool',
          injectionConfigs: [{injectionProbability: 0.5}],
        }),
      ).toThrow(/but not both, and not neither/);
    });

    it('rejects an unsimulatable tool inside the environment config', () => {
      expect(() =>
        createEnvironmentSimulationConfig({
          toolSimulationConfigs: [{toolName: 'my_tool'}],
        }),
      ).toThrow(/mockStrategyType cannot be MOCK_STRATEGY_UNSPECIFIED/);
    });
  });

  describe('feature gate', () => {
    it('throws from every factory when the feature is overridden off', () => {
      overrideFeatureEnabled(FeatureName.ENVIRONMENT_SIMULATION, false);

      expect(() =>
        createInjectedError({
          injectedHttpErrorCode: 404,
          errorMessage: 'not found',
        }),
      ).toThrow(NOT_ENABLED_MESSAGE);
      expect(() => createInjectionConfig()).toThrow(NOT_ENABLED_MESSAGE);
      expect(() => createToolSimulationConfig({toolName: 't'})).toThrow(
        NOT_ENABLED_MESSAGE,
      );
      expect(() => createEnvironmentSimulationConfig()).toThrow(
        NOT_ENABLED_MESSAGE,
      );
    });

    it('throws when ADK_DISABLE_ENVIRONMENT_SIMULATION disables the feature', () => {
      process.env[DISABLE_ENV_VAR] = 'true';

      expect(() => createEnvironmentSimulationConfig()).toThrow(
        NOT_ENABLED_MESSAGE,
      );
    });

    // The gate runs before validation, so a disabled feature reports itself
    // rather than reporting a key the factory never reads.
    it('reports the disabled feature before it validates the input', () => {
      overrideFeatureEnabled(FeatureName.ENVIRONMENT_SIMULATION, false);

      expect(() => environmentConfigFromJson('{"nope": 1}')).toThrow(
        NOT_ENABLED_MESSAGE,
      );
    });
  });
});
