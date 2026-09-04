/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ports
 * `tests/unittests/tools/environment_simulation/test_environment_simulation_config.py`
 * from google/adk-python (`main`). Every `it` title is the name of the
 * reference test it ports. The own tests live in
 * `environment_simulation_config_own_test.ts`.
 *
 * adk-python raises `ValidationError`; adk-js raises `InputValidationError`.
 * The messages name the adk-js camelCase fields, so the matched substrings
 * differ from the Python ones wherever they name a field.
 */

import {
  InjectedError,
  InputValidationError,
  MockStrategy,
  createEnvironmentSimulationConfig,
  createInjectedError,
  createInjectionConfig,
  createToolSimulationConfig,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

function injectedError(): InjectedError {
  return createInjectedError({
    injectedHttpErrorCode: 404,
    errorMessage: 'not found',
  });
}

describe('InjectionConfig', () => {
  it('test_neither_error_nor_response_raises', () => {
    expect(() => createInjectionConfig()).toThrow(InputValidationError);
    expect(() => createInjectionConfig()).toThrow(
      /but not both, and not neither/,
    );
  });

  it('test_both_error_and_response_raises', () => {
    const params = {
      injectedError: injectedError(),
      injectedResponse: {status: 'ok'},
    };

    expect(() => createInjectionConfig(params)).toThrow(InputValidationError);
    expect(() => createInjectionConfig(params)).toThrow(
      /but not both, and not neither/,
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

describe('ToolSimulationConfig', () => {
  it('test_no_injections_and_unspecified_strategy_raises', () => {
    expect(() => createToolSimulationConfig({toolName: 'my_tool'})).toThrow(
      InputValidationError,
    );
    expect(() => createToolSimulationConfig({toolName: 'my_tool'})).toThrow(
      /mockStrategyType cannot be MOCK_STRATEGY_UNSPECIFIED/,
    );
  });

  it('test_injections_alone_are_enough', () => {
    const config = createToolSimulationConfig({
      toolName: 'my_tool',
      injectionConfigs: [{injectedError: injectedError()}],
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

describe('EnvironmentSimulationConfig', () => {
  it('test_explicitly_empty_tool_simulation_configs_raises', () => {
    expect(() =>
      createEnvironmentSimulationConfig({toolSimulationConfigs: []}),
    ).toThrow(InputValidationError);
    expect(() =>
      createEnvironmentSimulationConfig({toolSimulationConfigs: []}),
    ).toThrow(/toolSimulationConfigs must be provided/);
  });

  it('test_duplicate_tool_names_raise_and_name_the_duplicate', () => {
    const toolConfig = createToolSimulationConfig({
      toolName: 'dup_tool',
      mockStrategyType: MockStrategy.MOCK_STRATEGY_TOOL_SPEC,
    });

    expect(() =>
      createEnvironmentSimulationConfig({
        toolSimulationConfigs: [toolConfig, {...toolConfig}],
      }),
    ).toThrow(/Duplicate tool_name found: dup_tool/);
  });

  it('test_distinct_tool_names_are_kept_in_order', () => {
    const config = createEnvironmentSimulationConfig({
      toolSimulationConfigs: [
        {
          toolName: 'first',
          mockStrategyType: MockStrategy.MOCK_STRATEGY_TOOL_SPEC,
        },
        {
          toolName: 'second',
          mockStrategyType: MockStrategy.MOCK_STRATEGY_TRACING,
        },
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
