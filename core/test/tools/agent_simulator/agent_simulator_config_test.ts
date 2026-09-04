/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ports `tests/unittests/tools/agent_simulator/test_agent_simulator_config.py`
 * from google/adk-python (`main`). Every `it` title is the name of the
 * reference test it ports. The own tests live in
 * `agent_simulator_config_own_test.ts`.
 *
 * adk-python raises a `DeprecationWarning`; adk-js logs through `logger.warn`,
 * so the warning assertions read the logger instead of a warning filter.
 *
 * The module under test is deliberately outside the `@google/adk` barrel, so
 * that importing the package does not emit its deprecation warning. That is
 * why it is imported by a relative path here.
 */

import {MockStrategy, ToolSimulationConfigParams} from '@google/adk';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {createAgentSimulatorConfig} from '../../../src/tools/agent_simulator/agent_simulator_config.js';
import {resetDeprecationWarnings} from '../../../src/utils/deprecated.js';
import {logger} from '../../../src/utils/logger.js';

function spyOnLoggerWarn() {
  return vi.spyOn(logger, 'warn').mockImplementation(() => {});
}

function toolConfigs(): ToolSimulationConfigParams[] {
  return [
    {
      toolName: 'my_tool',
      mockStrategyType: MockStrategy.MOCK_STRATEGY_TOOL_SPEC,
    },
  ];
}

function warnedAboutTracingPath(
  warnSpy: ReturnType<typeof spyOnLoggerWarn>,
): boolean {
  return warnSpy.mock.calls.some(([message]) =>
    String(message).includes('tracingPath'),
  );
}

describe('AgentSimulatorConfig', () => {
  let warnSpy: ReturnType<typeof spyOnLoggerWarn>;

  beforeEach(() => {
    // `warnDeprecatedOnce` warns once per process, so without this reset only
    // the first of these cases would ever see a warning.
    resetDeprecationWarnings();
    warnSpy = spyOnLoggerWarn();
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

    expect(warnSpy).toHaveBeenCalledWith(
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
    expect(warnedAboutTracingPath(warnSpy)).toBe(false);
  });
});
