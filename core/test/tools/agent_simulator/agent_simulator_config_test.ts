/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ported from google/adk-python at 44e0b2a8b121,
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

import {
  MockStrategy,
  ToolSimulationConfig,
  createToolSimulationConfig,
} from '@google/adk';
import {createAgentSimulatorConfig} from '@google/adk/tools/agent_simulator/agent_simulator_config.js';
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
