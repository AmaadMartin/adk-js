/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @deprecated Import from
 * `tools/environment_simulation/environment_simulation_config.js` instead.
 * This module forwards to it and will be removed.
 *
 * @module
 */

import {warnDeprecatedOnce} from '../../utils/deprecated.js';
import {
  createEnvironmentSimulationConfig,
  EnvironmentSimulationConfig,
  EnvironmentSimulationConfigParams,
} from '../environment_simulation/environment_simulation_config.js';

export {MockStrategy} from '../environment_simulation/environment_simulation_config.js';
export type {
  InjectedError,
  InjectionConfig,
  ToolSimulationConfig,
} from '../environment_simulation/environment_simulation_config.js';

const MOVED_WARNING_KEY = 'tools/agent_simulator/agent_simulator_config';

const TRACING_PATH_WARNING_KEY = 'AgentSimulatorConfigParams.tracingPath';

warnDeprecatedOnce(
  MOVED_WARNING_KEY,
  'tools/agent_simulator/agent_simulator_config is moved to ' +
    'tools/environment_simulation/environment_simulation_config',
);

/**
 * @deprecated Use {@link EnvironmentSimulationConfig} instead.
 *
 * adk-python declares a pydantic subclass here so that it can carry the
 * `tracing_path` validator. TypeScript types structurally and the subclass adds
 * no fields, so the two names describe one shape, and the forwarding lives in
 * {@link createAgentSimulatorConfig}.
 */
export type AgentSimulatorConfig = EnvironmentSimulationConfig;

/** What a caller may pass to {@link createAgentSimulatorConfig}. */
export interface AgentSimulatorConfigParams extends EnvironmentSimulationConfigParams {
  /**
   * @deprecated Use `tracing` instead. It is forwarded to `tracing`, and an
   * explicit `tracing` wins.
   */
  tracingPath?: string;
}

/**
 * Builds an {@link EnvironmentSimulationConfig}, forwarding `tracingPath` to
 * `tracing`.
 *
 * @deprecated Use `createEnvironmentSimulationConfig` from
 * `tools/environment_simulation/environment_simulation_config.js` instead.
 */
export function createAgentSimulatorConfig(
  params: AgentSimulatorConfigParams = {},
): AgentSimulatorConfig {
  const {tracingPath, ...rest} = params;
  if (tracingPath === undefined) {
    return createEnvironmentSimulationConfig(rest);
  }
  warnDeprecatedOnce(
    TRACING_PATH_WARNING_KEY,
    '`tracingPath` is deprecated. Use `tracing` instead.',
  );
  return createEnvironmentSimulationConfig({
    ...rest,
    tracing: rest.tracing ?? tracingPath,
  });
}
