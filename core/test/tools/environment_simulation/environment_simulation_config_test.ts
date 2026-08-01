/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {MockStrategy} from '@google/adk';
import {describe, expect, it} from 'vitest';

import {
  EnvironmentSimulationConfigSchema,
  InjectionConfigSchema,
  ToolSimulationConfigSchema,
} from '../../../src/tools/environment_simulation/environment_simulation_config.js';

const TOOL_SPEC_ENTRY = {
  toolName: 'create_ticket',
  mockStrategyType: MockStrategy.MOCK_STRATEGY_TOOL_SPEC,
};

describe('EnvironmentSimulationConfigSchema', () => {
  it('applies the documented defaults', () => {
    const config = EnvironmentSimulationConfigSchema.parse({
      toolSimulationConfigs: [
        {
          toolName: 'create_ticket',
          injectionConfigs: [{injectedResponse: {ok: true}}],
        },
      ],
    });

    expect(config.simulationModel).toBe('gemini-2.5-flash');
    expect(config.simulationModelConfiguration.thinkingConfig).toEqual({
      includeThoughts: false,
      thinkingBudget: 10240,
    });

    const [toolConfig] = config.toolSimulationConfigs;
    expect(toolConfig.mockStrategyType).toBe(
      MockStrategy.MOCK_STRATEGY_UNSPECIFIED,
    );
    expect(toolConfig.injectionConfigs[0].injectionProbability).toBe(1.0);
    expect(toolConfig.injectionConfigs[0].injectedLatencySeconds).toBe(0);
  });

  it('defaults injectionConfigs to an empty array', () => {
    const config = EnvironmentSimulationConfigSchema.parse({
      toolSimulationConfigs: [TOOL_SPEC_ENTRY],
    });

    expect(config.toolSimulationConfigs[0].injectionConfigs).toEqual([]);
  });

  it('does not share the default model configuration between parses', () => {
    const first = EnvironmentSimulationConfigSchema.parse({
      toolSimulationConfigs: [TOOL_SPEC_ENTRY],
    });
    const second = EnvironmentSimulationConfigSchema.parse({
      toolSimulationConfigs: [TOOL_SPEC_ENTRY],
    });

    first.simulationModelConfiguration.temperature = 0.5;

    expect(second.simulationModelConfiguration.temperature).toBeUndefined();
  });

  it('rejects an empty toolSimulationConfigs list', () => {
    const result = EnvironmentSimulationConfigSchema.safeParse({
      toolSimulationConfigs: [],
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0].message).toBe(
      'toolSimulationConfigs must be provided.',
    );
  });

  it('rejects a duplicate toolName', () => {
    const result = EnvironmentSimulationConfigSchema.safeParse({
      toolSimulationConfigs: [TOOL_SPEC_ENTRY, TOOL_SPEC_ENTRY],
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0].message).toBe(
      'Duplicate toolName found: create_ticket',
    );
  });

  it('accepts distinct toolNames', () => {
    const config = EnvironmentSimulationConfigSchema.parse({
      toolSimulationConfigs: [
        TOOL_SPEC_ENTRY,
        {...TOOL_SPEC_ENTRY, toolName: 'get_ticket'},
      ],
    });

    expect(config.toolSimulationConfigs).toHaveLength(2);
  });

  it('rejects a non-object simulationModelConfiguration', () => {
    const result = EnvironmentSimulationConfigSchema.safeParse({
      toolSimulationConfigs: [TOOL_SPEC_ENTRY],
      simulationModelConfiguration: 'not-an-object',
    });

    expect(result.success).toBe(false);
  });

  it('rejects a null simulationModelConfiguration', () => {
    const result = EnvironmentSimulationConfigSchema.safeParse({
      toolSimulationConfigs: [TOOL_SPEC_ENTRY],
      simulationModelConfiguration: null,
    });

    expect(result.success).toBe(false);
  });

  it('keeps an explicit simulationModelConfiguration', () => {
    const config = EnvironmentSimulationConfigSchema.parse({
      toolSimulationConfigs: [TOOL_SPEC_ENTRY],
      simulationModelConfiguration: {temperature: 0.1},
    });

    expect(config.simulationModelConfiguration).toEqual({temperature: 0.1});
  });
});

describe('ToolSimulationConfigSchema', () => {
  it('rejects an entry with no injections and an unspecified strategy', () => {
    const result = ToolSimulationConfigSchema.safeParse({
      toolName: 'create_ticket',
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0].message).toBe(
      'If injectionConfigs is empty, mockStrategyType cannot be MOCK_STRATEGY_UNSPECIFIED.',
    );
  });

  it('accepts an entry with injections and an unspecified strategy', () => {
    const config = ToolSimulationConfigSchema.parse({
      toolName: 'create_ticket',
      injectionConfigs: [{injectedResponse: {ok: true}}],
    });

    expect(config.mockStrategyType).toBe(
      MockStrategy.MOCK_STRATEGY_UNSPECIFIED,
    );
  });

  it('rejects an unknown mock strategy', () => {
    const result = ToolSimulationConfigSchema.safeParse({
      toolName: 'create_ticket',
      mockStrategyType: 'MOCK_STRATEGY_TELEPATHY',
    });

    expect(result.success).toBe(false);
  });
});

describe('InjectionConfigSchema', () => {
  it('accepts the maximum injected latency', () => {
    const config = InjectionConfigSchema.parse({
      injectedLatencySeconds: 120,
      injectedResponse: {ok: true},
    });

    expect(config.injectedLatencySeconds).toBe(120);
  });

  it('rejects an injected latency above the maximum', () => {
    const result = InjectionConfigSchema.safeParse({
      injectedLatencySeconds: 120.1,
      injectedResponse: {ok: true},
    });

    expect(result.success).toBe(false);
  });

  it('accepts a negative injected latency, matching adk-python', () => {
    const config = InjectionConfigSchema.parse({
      injectedLatencySeconds: -1,
      injectedResponse: {ok: true},
    });

    expect(config.injectedLatencySeconds).toBe(-1);
  });

  it('accepts an injection probability outside [0, 1], matching adk-python', () => {
    const config = InjectionConfigSchema.parse({
      injectionProbability: 2,
      injectedResponse: {ok: true},
    });

    expect(config.injectionProbability).toBe(2);
  });

  it('rejects an injection setting both an error and a response', () => {
    const result = InjectionConfigSchema.safeParse({
      injectedError: {injectedHttpErrorCode: 503, errorMessage: 'down'},
      injectedResponse: {ok: true},
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues[0].message).toBe(
      'Either injectedError or injectedResponse must be set, but not both, and not neither.',
    );
  });

  it('rejects an injection setting neither an error nor a response', () => {
    const result = InjectionConfigSchema.safeParse({});

    expect(result.success).toBe(false);
    expect(result.error?.issues[0].message).toBe(
      'Either injectedError or injectedResponse must be set, but not both, and not neither.',
    );
  });

  it('accepts an empty injectedResponse object', () => {
    const config = InjectionConfigSchema.parse({injectedResponse: {}});

    expect(config.injectedResponse).toEqual({});
  });

  it('rejects a non-integer randomSeed', () => {
    const result = InjectionConfigSchema.safeParse({
      randomSeed: 1.5,
      injectedResponse: {ok: true},
    });

    expect(result.success).toBe(false);
  });

  it('rejects a non-integer injected HTTP error code', () => {
    const result = InjectionConfigSchema.safeParse({
      injectedError: {injectedHttpErrorCode: 50.3, errorMessage: 'down'},
    });

    expect(result.success).toBe(false);
  });
});
