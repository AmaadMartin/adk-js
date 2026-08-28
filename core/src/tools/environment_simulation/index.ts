/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

export {
  MockStrategyType,
  resolveEnvironmentSimulationConfig,
} from './environment_simulation_config.js';
export type {
  EnvironmentSimulationConfig,
  InjectedError,
  InjectionConfig,
  ResolvedEnvironmentSimulationConfig,
  ResolvedInjectionConfig,
  ResolvedToolSimulationConfig,
  ToolSimulationConfig,
} from './environment_simulation_config.js';
export {EnvironmentSimulationEngine} from './environment_simulation_engine.js';
export {EnvironmentSimulationFactory} from './environment_simulation_factory.js';
export {EnvironmentSimulationPlugin} from './environment_simulation_plugin.js';
export {MockStrategy, TracingMockStrategy} from './strategies/base.js';
export type {MockRequest, StateStore} from './strategies/base.js';
export {ToolSpecMockStrategy} from './strategies/tool_spec_mock_strategy.js';
export {ToolConnectionAnalyzer} from './tool_connection_analyzer.js';
export type {
  StatefulParameter,
  ToolConnectionMap,
} from './tool_connection_map.js';
