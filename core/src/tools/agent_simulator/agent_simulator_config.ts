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
  EnvironmentSimulationConfig,
  EnvironmentSimulationConfigParams,
  createEnvironmentSimulationConfig,
} from '../environment_simulation/environment_simulation_config.js';

const MODULE_DEPRECATION_KEY =
  '@google/adk/tools/agent_simulator/agent_simulator_config';

// This module is a deprecation shim, so it warns as soon as it is evaluated,
// the way adk-python warns on import. That is also why it stays out of the
// `@google/adk` barrel: only a caller who imports this path deliberately
// should see the warning.
warnDeprecatedOnce(
  MODULE_DEPRECATION_KEY,
  `${MODULE_DEPRECATION_KEY} is moved to the environment_simulation_config` +
    ' module, which @google/adk exports directly.',
);

export {
  MockStrategy,
  createInjectedError,
  createInjectionConfig,
  createToolSimulationConfig,
} from '../environment_simulation/environment_simulation_config.js';
export type {
  InjectedError,
  InjectionConfig,
  ToolSimulationConfig,
} from '../environment_simulation/environment_simulation_config.js';

/**
 * The old name of {@link EnvironmentSimulationConfig}.
 *
 * adk-python declares a subclass that adds nothing but the `tracing_path`
 * forwarding. TypeScript types structurally, so the two names describe one
 * shape.
 *
 * @deprecated Use `EnvironmentSimulationConfig` from `@google/adk`.
 */
export type AgentSimulatorConfig = EnvironmentSimulationConfig;

/**
 * The fields {@link createAgentSimulatorConfig} accepts: everything
 * {@link EnvironmentSimulationConfigParams} carries, plus the old
 * `tracingPath` spelling.
 *
 * @deprecated Use `EnvironmentSimulationConfigParams` from `@google/adk`.
 */
export interface AgentSimulatorConfigParams extends EnvironmentSimulationConfigParams {
  /** @deprecated Use `tracing` instead. */
  tracingPath?: string;
}

/**
 * Creates an {@link EnvironmentSimulationConfig} from the old field names.
 *
 * `tracingPath` is forwarded to `tracing` and never survives into the returned
 * config. Supplying it logs one deprecation warning, even when `tracing` is
 * also set and wins.
 *
 * @param params Optional configuration fields. The object is read, never
 *     mutated.
 * @returns A validated, freshly built {@link EnvironmentSimulationConfig}.
 * @throws {Error} When the `ENVIRONMENT_SIMULATION` feature is disabled.
 * @throws {InputValidationError} On the same input that
 *     {@link createEnvironmentSimulationConfig} rejects.
 *
 * @deprecated Use `createEnvironmentSimulationConfig` from `@google/adk`.
 */
export function createAgentSimulatorConfig(
  params: AgentSimulatorConfigParams = {},
): EnvironmentSimulationConfig {
  const {tracingPath, ...rest} = params;
  if (tracingPath === undefined) {
    return createEnvironmentSimulationConfig(rest);
  }
  warnDeprecatedOnce(
    `${MODULE_DEPRECATION_KEY}#tracingPath`,
    '`tracingPath` is deprecated. Use `tracing` instead.',
  );
  if (rest.tracing !== undefined) {
    return createEnvironmentSimulationConfig(rest);
  }
  return createEnvironmentSimulationConfig({...rest, tracing: tracingPath});
}
