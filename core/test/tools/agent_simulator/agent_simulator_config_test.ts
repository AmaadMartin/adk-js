/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
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
} from '@google/adk/tools/agent_simulator/agent_simulator_config';
import {resetDeprecationWarnings} from '@google/adk/utils/deprecated.js';
import {logger} from '@google/adk/utils/logger.js';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

function toolConfigs(): ToolSimulationConfig[] {
  return [
    createToolSimulationConfig({
      toolName: 'my_tool',
      mockStrategyType: MockStrategy.MOCK_STRATEGY_TOOL_SPEC,
    }),
  ];
}

/*
 * The describe block below is ported from google/adk-python at 44e0b2a8b121,
 * `tests/unittests/tools/agent_simulator/test_agent_simulator_config.py`.
 * All 4 reference tests are here, and each keeps its Python name.
 *
 * One translation note: adk-python raises a `DeprecationWarning` and the
 * reference tests use `pytest.warns` and `warnings.catch_warnings`. adk-js logs
 * through `logger.warn`, so these tests spy on the logger instead.
 * `warnDeprecatedOnce` fires once per process, so `beforeEach` calls
 * `resetDeprecationWarnings()`; without it only the first case would see a
 * warning.
 */

describe('the deprecated AgentSimulatorConfig alias', () => {
  beforeEach(() => {
    resetDeprecationWarnings();
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetDeprecationWarnings();
  });

  it('test_tracing_path_is_forwarded_to_tracing', () => {
    const config = createAgentSimulatorConfig({
      toolSimulationConfigs: toolConfigs(),
      tracingPath: 'prior_run_trace',
    });

    expect(config.tracing).toBe('prior_run_trace');
  });

  it('test_tracing_path_emits_deprecation_warning', () => {
    createAgentSimulatorConfig({
      toolSimulationConfigs: toolConfigs(),
      tracingPath: 'prior_run_trace',
    });

    expect(logger.warn).toHaveBeenCalledWith(
      '`tracingPath` is deprecated. Use `tracing` instead.',
    );
  });

  it('test_explicit_tracing_wins_over_tracing_path', () => {
    const config = createAgentSimulatorConfig({
      toolSimulationConfigs: toolConfigs(),
      tracing: 'explicit_trace',
      tracingPath: 'legacy_trace',
    });

    expect(config.tracing).toBe('explicit_trace');
  });

  it('test_tracing_alone_does_not_warn', () => {
    const config = createAgentSimulatorConfig({
      toolSimulationConfigs: toolConfigs(),
      tracing: 'explicit_trace',
    });

    expect(config.tracing).toBe('explicit_trace');
    expect(logger.warn).not.toHaveBeenCalledWith(
      expect.stringContaining('tracingPath'),
    );
  });
});

const MOVED_WARNING = 'is moved to';

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

    await import('@google/adk/tools/agent_simulator/agent_simulator_config');

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
