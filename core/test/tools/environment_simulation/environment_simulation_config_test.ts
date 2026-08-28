/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {InjectedError, InjectionConfig, MockStrategyType} from '@google/adk';
import {describe, expect, it} from 'vitest';

import {
  ResolvedInjectionConfig,
  resolveEnvironmentSimulationConfig,
} from '../../../src/tools/environment_simulation/environment_simulation_config.js';

const INJECTED_ERROR: InjectedError = {
  injectedHttpErrorCode: 404,
  errorMessage: 'not found',
};

function resolveOneInjection(
  injectionConfig: InjectionConfig,
): ResolvedInjectionConfig {
  return resolveEnvironmentSimulationConfig({
    toolSimulationConfigs: [
      {toolName: 'my_tool', injectionConfigs: [injectionConfig]},
    ],
  }).toolSimulationConfigs[0].injectionConfigs[0];
}

describe('resolveEnvironmentSimulationConfig injection rules', () => {
  it('rejects an injection that injects nothing', () => {
    expect(() => resolveOneInjection({})).toThrowError(
      'Either injectedError or injectedResponse must be set, but not both,' +
        ' and not neither.',
    );
  });

  it('rejects an injection that injects both an error and a response', () => {
    expect(() =>
      resolveOneInjection({
        injectedError: INJECTED_ERROR,
        injectedResponse: {status: 'ok'},
      }),
    ).toThrowError('but not both, and not neither.');
  });

  it('accepts an error-only injection and leaves the response unset', () => {
    const resolved = resolveOneInjection({injectedError: INJECTED_ERROR});

    expect(resolved.injectedError?.injectedHttpErrorCode).toBe(404);
    expect(resolved.injectedResponse).toBeUndefined();
  });

  it('accepts a response-only injection and leaves the error unset', () => {
    const resolved = resolveOneInjection({injectedResponse: {status: 'ok'}});

    expect(resolved.injectedResponse).toEqual({status: 'ok'});
    expect(resolved.injectedError).toBeUndefined();
  });

  it('fills in the probability and latency defaults', () => {
    const resolved = resolveOneInjection({injectedResponse: {status: 'ok'}});

    expect(resolved.injectionProbability).toBe(1);
    expect(resolved.injectedLatencySeconds).toBe(0);
  });

  it('keeps an explicit probability and latency', () => {
    const resolved = resolveOneInjection({
      injectionProbability: 0.25,
      injectedLatencySeconds: 2,
      injectedResponse: {status: 'ok'},
    });

    expect(resolved.injectionProbability).toBe(0.25);
    expect(resolved.injectedLatencySeconds).toBe(2);
  });

  it('accepts a latency at the cap', () => {
    const resolved = resolveOneInjection({
      injectedLatencySeconds: 120,
      injectedResponse: {status: 'ok'},
    });

    expect(resolved.injectedLatencySeconds).toBe(120);
  });

  it('rejects a latency above the cap', () => {
    expect(() =>
      resolveOneInjection({
        injectedLatencySeconds: 120.5,
        injectedResponse: {status: 'ok'},
      }),
    ).toThrowError('injectedLatencySeconds must be at most 120.');
  });
});

describe('resolveEnvironmentSimulationConfig tool rules', () => {
  it('rejects a tool with neither injections nor a strategy', () => {
    expect(() =>
      resolveEnvironmentSimulationConfig({
        toolSimulationConfigs: [{toolName: 'my_tool'}],
      }),
    ).toThrowError(
      'If injectionConfigs is empty, mockStrategyType cannot be' +
        ' MOCK_STRATEGY_UNSPECIFIED.',
    );
  });

  it('accepts injections alone and leaves the strategy unspecified', () => {
    const resolved = resolveEnvironmentSimulationConfig({
      toolSimulationConfigs: [
        {
          toolName: 'my_tool',
          injectionConfigs: [{injectedError: INJECTED_ERROR}],
        },
      ],
    }).toolSimulationConfigs[0];

    expect(resolved.mockStrategyType).toBe(
      MockStrategyType.MOCK_STRATEGY_UNSPECIFIED,
    );
    expect(resolved.injectionConfigs).toHaveLength(1);
    expect(resolved.injectionConfigs[0].injectedError?.errorMessage).toBe(
      'not found',
    );
  });

  it('accepts a strategy alone and resolves the injections to an empty list', () => {
    const resolved = resolveEnvironmentSimulationConfig({
      toolSimulationConfigs: [
        {
          toolName: 'my_tool',
          mockStrategyType: MockStrategyType.MOCK_STRATEGY_TOOL_SPEC,
        },
      ],
    }).toolSimulationConfigs[0];

    expect(resolved.injectionConfigs).toEqual([]);
  });
});

describe('resolveEnvironmentSimulationConfig tool list rules', () => {
  it('rejects an empty tool list', () => {
    expect(() =>
      resolveEnvironmentSimulationConfig({toolSimulationConfigs: []}),
    ).toThrowError('toolSimulationConfigs must be provided.');
  });

  it('rejects a duplicate tool name and names the duplicate', () => {
    const toolConfig = {
      toolName: 'dup_tool',
      mockStrategyType: MockStrategyType.MOCK_STRATEGY_TOOL_SPEC,
    };

    expect(() =>
      resolveEnvironmentSimulationConfig({
        toolSimulationConfigs: [toolConfig, {...toolConfig}],
      }),
    ).toThrowError('Duplicate toolName found: dup_tool');
  });

  it('rejects a strategy type that does not exist', () => {
    expect(() =>
      resolveEnvironmentSimulationConfig({
        toolSimulationConfigs: [
          {
            toolName: 'my_tool',
            mockStrategyType: 'MOCK_STRATEGY_TELEPATHY' as MockStrategyType,
          },
        ],
      }),
    ).toThrowError('Unknown mock strategy type: MOCK_STRATEGY_TELEPATHY');
  });

  it('keeps distinct tool names in order with their own strategies', () => {
    const resolved = resolveEnvironmentSimulationConfig({
      toolSimulationConfigs: [
        {
          toolName: 'first',
          mockStrategyType: MockStrategyType.MOCK_STRATEGY_TOOL_SPEC,
        },
        {
          toolName: 'second',
          mockStrategyType: MockStrategyType.MOCK_STRATEGY_TRACING,
        },
      ],
    });

    expect(resolved.toolSimulationConfigs.map((c) => c.toolName)).toEqual([
      'first',
      'second',
    ]);
    expect(resolved.toolSimulationConfigs[1].mockStrategyType).toBe(
      MockStrategyType.MOCK_STRATEGY_TRACING,
    );
  });
});

describe('resolveEnvironmentSimulationConfig defaults', () => {
  it('defaults the simulation model and its thinking config', () => {
    const resolved = resolveEnvironmentSimulationConfig({
      toolSimulationConfigs: [
        {
          toolName: 'my_tool',
          mockStrategyType: MockStrategyType.MOCK_STRATEGY_TOOL_SPEC,
        },
      ],
    });

    expect(resolved.simulationModel).toBe('gemini-2.5-flash');
    expect(resolved.simulationModelConfiguration).toEqual({
      thinkingConfig: {includeThoughts: false, thinkingBudget: 10240},
    });
  });

  it('keeps an explicit simulation model and configuration', () => {
    const resolved = resolveEnvironmentSimulationConfig({
      toolSimulationConfigs: [
        {
          toolName: 'my_tool',
          mockStrategyType: MockStrategyType.MOCK_STRATEGY_TOOL_SPEC,
        },
      ],
      simulationModel: 'my-model',
      simulationModelConfiguration: {temperature: 0.1},
    });

    expect(resolved.simulationModel).toBe('my-model');
    expect(resolved.simulationModelConfiguration).toEqual({temperature: 0.1});
  });
});
