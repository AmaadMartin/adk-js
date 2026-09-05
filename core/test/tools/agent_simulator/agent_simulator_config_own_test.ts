/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Cases adk-python does not test: the warning the module emits when it is
 * evaluated, the identity of its re-exports, the feature gate, and the fact
 * that `tracingPath` never survives into the returned config. The ported
 * reference tests live in `agent_simulator_config_test.ts`.
 */

import {
  FeatureName,
  MockStrategy,
  ToolSimulationConfigParams,
  createEnvironmentSimulationConfig,
  overrideFeatureEnabled,
} from '@google/adk';
import {
  AgentSimulatorConfig,
  MockStrategy as ReExportedMockStrategy,
  createAgentSimulatorConfig,
  createInjectedError as reExportedCreateInjectedError,
  createInjectionConfig as reExportedCreateInjectionConfig,
  createToolSimulationConfig as reExportedCreateToolSimulationConfig,
} from '@google/adk/tools/agent_simulator/agent_simulator_config.js';
import {resetDeprecationWarnings} from '@google/adk/utils/deprecated.js';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const NOT_ENABLED_MESSAGE = 'Feature ENVIRONMENT_SIMULATION is not enabled.';

function toolConfigs(): ToolSimulationConfigParams[] {
  return [
    {
      toolName: 'my_tool',
      mockStrategyType: MockStrategy.MOCK_STRATEGY_TOOL_SPEC,
    },
  ];
}

describe('agent_simulator_config module', () => {
  beforeEach(() => {
    resetDeprecationWarnings();
  });

  afterEach(() => {
    overrideFeatureEnabled(FeatureName.ENVIRONMENT_SIMULATION, undefined);
    vi.restoreAllMocks();
  });

  // ESM evaluates a module once per process, so the warning the module emits
  // at its top level cannot be observed by importing it again. Resetting the
  // module registry first, and taking the spy on the freshly imported logger,
  // is what makes the second evaluation visible.
  it('warns that the module has moved when it is evaluated', async () => {
    vi.resetModules();
    const {logger: freshLogger} = await import('@google/adk/utils/logger.js');
    const warnSpy = vi.spyOn(freshLogger, 'warn').mockImplementation(() => {});

    await import('@google/adk/tools/agent_simulator/agent_simulator_config.js');

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('agent_simulator_config'),
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('environment_simulation_config'),
    );
  });

  describe('re-exports', () => {
    it('re-exports the live MockStrategy rather than a copy of it', () => {
      expect(ReExportedMockStrategy).toBe(MockStrategy);
    });

    it('re-exports the live factories', () => {
      const error = reExportedCreateInjectedError({
        injectedHttpErrorCode: 404,
        errorMessage: 'not found',
      });
      const injection = reExportedCreateInjectionConfig({
        injectedError: error,
      });
      const tool = reExportedCreateToolSimulationConfig({
        toolName: 'my_tool',
        injectionConfigs: [injection],
      });

      expect(tool.injectionConfigs[0].injectedError?.errorMessage).toBe(
        'not found',
      );
    });
  });

  describe('createAgentSimulatorConfig', () => {
    it('never carries tracingPath into the returned config', () => {
      const config = createAgentSimulatorConfig({
        toolSimulationConfigs: toolConfigs(),
        tracing: 'explicit_trace',
        tracingPath: 'legacy_trace',
      });

      expect(Object.keys(config)).not.toContain('tracingPath');
    });

    it('builds the same config as createEnvironmentSimulationConfig', () => {
      const params = {toolSimulationConfigs: toolConfigs()};

      expect(createAgentSimulatorConfig(params)).toEqual(
        createEnvironmentSimulationConfig(params),
      );
    });

    it('applies the same defaults when it is given nothing', () => {
      const config: AgentSimulatorConfig = createAgentSimulatorConfig();

      expect(config.simulationModel).toBe('gemini-2.5-flash');
      expect(config.toolSimulationConfigs).toEqual([]);
    });

    it('still rejects an explicitly empty tool list', () => {
      expect(() =>
        createAgentSimulatorConfig({toolSimulationConfigs: []}),
      ).toThrow(/toolSimulationConfigs must be provided/);
    });

    it('throws when the feature is disabled', () => {
      overrideFeatureEnabled(FeatureName.ENVIRONMENT_SIMULATION, false);

      expect(() =>
        createAgentSimulatorConfig({tracingPath: 'legacy_trace'}),
      ).toThrow(NOT_ENABLED_MESSAGE);
    });
  });
});
