/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * adk-js-only cases for the deprecated `agent_simulator_config` shim. None of
 * these has a counterpart in google/adk-python; the ported reference tests live
 * in `agent_simulator_config_test.ts`.
 */

import {
  MockStrategy,
  ToolSimulationConfig,
  createToolSimulationConfig,
} from '@google/adk';
import {
  AgentSimulatorConfig,
  InjectedError,
  MockStrategy as ShimMockStrategy,
  createAgentSimulatorConfig,
} from '@google/adk/tools/agent_simulator/agent_simulator_config.js';
import {resetDeprecationWarnings} from '@google/adk/utils/deprecated.js';
import {logger} from '@google/adk/utils/logger.js';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const MOVED_WARNING = 'is moved to';

function toolConfigs(): ToolSimulationConfig[] {
  return [
    createToolSimulationConfig({
      toolName: 'my_tool',
      mockStrategyType: MockStrategy.MOCK_STRATEGY_TOOL_SPEC,
    }),
  ];
}

describe('the shim warns that the module moved', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('warns when the module is evaluated', async () => {
    // ESM evaluates a module once per process, so the warning the static
    // imports above already triggered cannot be observed. A fresh registry can.
    vi.resetModules();
    const {logger: freshLogger} = await import('@google/adk/utils/logger.js');
    const warn = vi.spyOn(freshLogger, 'warn').mockImplementation(() => {});

    await import('@google/adk/tools/agent_simulator/agent_simulator_config.js');

    expect(warn).toHaveBeenCalledWith(expect.stringContaining(MOVED_WARNING));
  });

  it('stays out of the package barrel, so `@google/adk` does not warn', async () => {
    vi.resetModules();
    const {logger: freshLogger} = await import('@google/adk/utils/logger.js');
    const warn = vi.spyOn(freshLogger, 'warn').mockImplementation(() => {});

    await import('@google/adk');

    expect(warn).not.toHaveBeenCalledWith(
      expect.stringContaining(MOVED_WARNING),
    );
  });
});

describe('createAgentSimulatorConfig', () => {
  beforeEach(() => {
    resetDeprecationWarnings();
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetDeprecationWarnings();
  });

  it('warns once for tracingPath, not once per call', () => {
    for (let i = 0; i < 3; i++) {
      createAgentSimulatorConfig({
        toolSimulationConfigs: toolConfigs(),
        tracingPath: 'prior_run_trace',
      });
    }

    const tracingPathWarnings = vi
      .mocked(logger.warn)
      .mock.calls.filter(([message]) =>
        String(message).includes('tracingPath'),
      );
    expect(tracingPathWarnings).toHaveLength(1);
  });

  it('consumes tracingPath, so it never reaches the returned config', () => {
    const config: AgentSimulatorConfig = createAgentSimulatorConfig({
      toolSimulationConfigs: toolConfigs(),
      tracingPath: 'prior_run_trace',
    });

    expect(config).not.toHaveProperty('tracingPath');
  });

  it('builds a config with no arguments at all', () => {
    const config = createAgentSimulatorConfig();

    expect(config.toolSimulationConfigs).toEqual([]);
    expect(config.tracing).toBeUndefined();
  });

  it('rejects the same input the base factory rejects', () => {
    expect(() =>
      createAgentSimulatorConfig({toolSimulationConfigs: []}),
    ).toThrow('toolSimulationConfigs must be provided.');
  });
});

describe('the shim re-exports the base module', () => {
  it('re-exports MockStrategy as the very same enum', () => {
    expect(ShimMockStrategy).toBe(MockStrategy);
  });

  it('re-exports the types the base module declares', () => {
    const injectedError: InjectedError = {
      injectedHttpErrorCode: 404,
      errorMessage: 'not found',
    };

    expect(injectedError.injectedHttpErrorCode).toBe(404);
  });
});
