/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ported from google/adk-python at 44e0b2a8b121,
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

function expectInputValidationError(
  call: () => unknown,
  messageFragment: string,
): void {
  expect(call).toThrow(InputValidationError);
  expect(call).toThrow(messageFragment);
}

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
