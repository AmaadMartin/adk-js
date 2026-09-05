/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {getBooleanEnvVar} from '../utils/env_aware_utils.js';
import {logger} from '../utils/logger.js';

/**
 * Feature names.
 *
 * A member's string value names the flag in the environment:
 * `ADK_ENABLE_<value>` and `ADK_DISABLE_<value>`.
 */
export enum FeatureName {
  /** The declarative YAML agent-config document surface. */
  AGENT_CONFIG = 'AGENT_CONFIG',
  /** Typed agent state carried across an agent's invocations. */
  AGENT_STATE = 'AGENT_STATE',
  /** A function tool that receives a resolved credential. */
  AUTHENTICATED_FUNCTION_TOOL = 'AUTHENTICATED_FUNCTION_TOOL',
  /** The base class for tools that resolve a credential before they run. */
  BASE_AUTHENTICATED_TOOL = 'BASE_AUTHENTICATED_TOOL',
  /** The BigQuery toolset. */
  BIG_QUERY_TOOLSET = 'BIG_QUERY_TOOLSET',
  /** Configuration surface for the BigQuery tools. */
  BIG_QUERY_TOOL_CONFIG = 'BIG_QUERY_TOOL_CONFIG',
  /** Configuration surface for the Bigtable tools. */
  BIGTABLE_TOOL_SETTINGS = 'BIGTABLE_TOOL_SETTINGS',
  /** The Bigtable toolset. */
  BIGTABLE_TOOLSET = 'BIGTABLE_TOOLSET',
  /** The computer-use toolset and the computers it drives. */
  COMPUTER_USE = 'COMPUTER_USE',
  /** Configuration surface for the data-agent tools. */
  DATA_AGENT_TOOL_CONFIG = 'DATA_AGENT_TOOL_CONFIG',
  /** The data-agent toolset. */
  DATA_AGENT_TOOLSET = 'DATA_AGENT_TOOLSET',
  /**
   * Routes dynamic instructions into the user content instead of the system
   * instruction.
   */
  DYNAMIC_INSTRUCTION_ROUTING = 'DYNAMIC_INSTRUCTION_ROUTING',
  /** The Daytona code execution environment. */
  DAYTONA_ENVIRONMENT = 'DAYTONA_ENVIRONMENT',
  /** The E2B code execution environment. */
  E2B_ENVIRONMENT = 'E2B_ENVIRONMENT',
  /** The simulated environment tools and their configuration. */
  ENVIRONMENT_SIMULATION = 'ENVIRONMENT_SIMULATION',
  /** Configuration surface for the Eventarc tools. */
  EVENTARC_TOOL_CONFIG = 'EVENTARC_TOOL_CONFIG',
  /** The Eventarc toolset. */
  EVENTARC_TOOLSET = 'EVENTARC_TOOLSET',
  /** A model that falls back to backup models when a call fails. */
  FALLBACK_MODEL = 'FALLBACK_MODEL',
  /** The Cloud Storage admin toolset. */
  GCS_ADMIN_TOOLSET = 'GCS_ADMIN_TOOLSET',
  /** Configuration surface for the Cloud Storage tools. */
  GCS_TOOL_SETTINGS = 'GCS_TOOL_SETTINGS',
  /** The Cloud Storage toolset. */
  GCS_TOOLSET = 'GCS_TOOLSET',
  /** The shared credentials configuration for the Google Cloud toolsets. */
  GOOGLE_CREDENTIALS_CONFIG = 'GOOGLE_CREDENTIALS_CONFIG',
  /** The base class for the Google Cloud tools. */
  GOOGLE_TOOL = 'GOOGLE_TOOL',
  /**
   * Declares a function tool's parameters as a raw JSON schema
   * (`parametersJsonSchema`) instead of a genai `Schema` (`parameters`).
   */
  JSON_SCHEMA_FOR_FUNC_DECL = 'JSON_SCHEMA_FOR_FUNC_DECL',
  /** Serves an ADK agent over the Model Context Protocol. */
  MCP_AGENT_SERVER = 'MCP_AGENT_SERVER',
  /**
   * Reports a failed MCP tool call as an `{error}` result instead of a thrown
   * exception, so one failed call cannot end the agent turn. Set
   * `ADK_DISABLE_MCP_GRACEFUL_ERROR_HANDLING=1` to restore the throwing
   * behaviour.
   *
   * @internal A temporary kill-switch, not supported API. Do not read it by
   * name from outside this package.
   */
  MCP_GRACEFUL_ERROR_HANDLING = 'MCP_GRACEFUL_ERROR_HANDLING',
  /**
   * Flushes streamed parts as they arrive instead of aggregating them into one
   * response.
   */
  PROGRESSIVE_SSE_STREAMING = 'PROGRESSIVE_SSE_STREAMING',
  /** Configuration surface for the Pub/Sub tools. */
  PUBSUB_TOOL_CONFIG = 'PUBSUB_TOOL_CONFIG',
  /** The Pub/Sub toolset. */
  PUBSUB_TOOLSET = 'PUBSUB_TOOLSET',
  /** The skill toolset. */
  SKILL_TOOLSET = 'SKILL_TOOLSET',
  /** The Spanner toolset. */
  SPANNER_TOOLSET = 'SPANNER_TOOLSET',
  /** The Spanner admin toolset. */
  SPANNER_ADMIN_TOOLSET = 'SPANNER_ADMIN_TOOLSET',
  /** Configuration surface for the Spanner tools. */
  SPANNER_TOOL_SETTINGS = 'SPANNER_TOOL_SETTINGS',
  /** The Spanner vector store helpers. */
  SPANNER_VECTOR_STORE = 'SPANNER_VECTOR_STORE',
  /** The declarative tool-config document surface. */
  TOOL_CONFIG = 'TOOL_CONFIG',
  /** Asks the user to confirm a tool call before the tool runs. */
  TOOL_CONFIRMATION = 'TOOL_CONFIRMATION',
  /** Pluggable authentication providers and their registry. */
  PLUGGABLE_AUTH = 'PLUGGABLE_AUTH',
  /** Accepts a snake_case skill name as well as a kebab-case one. */
  SNAKE_CASE_SKILL_NAME = 'SNAKE_CASE_SKILL_NAME',
  /**
   * Copies a session shallowly instead of deeply in the in-memory session
   * service.
   */
  IN_MEMORY_SESSION_SERVICE_LIGHT_COPY = 'IN_MEMORY_SESSION_SERVICE_LIGHT_COPY',
}

/**
 * Feature lifecycle stages.
 */
export enum FeatureStage {
  WIP = 'wip',
  EXPERIMENTAL = 'experimental',
  STABLE = 'stable',
}

/**
 * Feature configuration.
 */
export interface FeatureConfig {
  stage: FeatureStage;
  /** Whether the feature is enabled by default. Defaults to false. */
  defaultOn?: boolean;
}

// Central registry: FeatureName -> FeatureConfig. Every stored config carries
// a concrete `defaultOn`; `registerFeature` fills it in when a caller omits it.
const FEATURE_REGISTRY: Record<FeatureName, Required<FeatureConfig>> = {
  [FeatureName.AGENT_CONFIG]: {
    stage: FeatureStage.EXPERIMENTAL,
    defaultOn: true,
  },
  [FeatureName.AGENT_STATE]: {
    stage: FeatureStage.EXPERIMENTAL,
    defaultOn: true,
  },
  [FeatureName.AUTHENTICATED_FUNCTION_TOOL]: {
    stage: FeatureStage.EXPERIMENTAL,
    defaultOn: true,
  },
  [FeatureName.BASE_AUTHENTICATED_TOOL]: {
    stage: FeatureStage.EXPERIMENTAL,
    defaultOn: true,
  },
  [FeatureName.BIG_QUERY_TOOLSET]: {
    stage: FeatureStage.STABLE,
    defaultOn: true,
  },
  [FeatureName.BIG_QUERY_TOOL_CONFIG]: {
    stage: FeatureStage.STABLE,
    defaultOn: true,
  },
  [FeatureName.BIGTABLE_TOOL_SETTINGS]: {
    stage: FeatureStage.EXPERIMENTAL,
    defaultOn: true,
  },
  [FeatureName.BIGTABLE_TOOLSET]: {
    stage: FeatureStage.EXPERIMENTAL,
    defaultOn: true,
  },
  [FeatureName.COMPUTER_USE]: {
    stage: FeatureStage.EXPERIMENTAL,
    defaultOn: true,
  },
  [FeatureName.DATA_AGENT_TOOL_CONFIG]: {
    stage: FeatureStage.STABLE,
    defaultOn: true,
  },
  [FeatureName.DATA_AGENT_TOOLSET]: {
    stage: FeatureStage.STABLE,
    defaultOn: true,
  },
  [FeatureName.DYNAMIC_INSTRUCTION_ROUTING]: {
    stage: FeatureStage.EXPERIMENTAL,
    defaultOn: false,
  },
  [FeatureName.DAYTONA_ENVIRONMENT]: {
    stage: FeatureStage.EXPERIMENTAL,
    defaultOn: true,
  },
  [FeatureName.E2B_ENVIRONMENT]: {
    stage: FeatureStage.EXPERIMENTAL,
    defaultOn: true,
  },
  [FeatureName.ENVIRONMENT_SIMULATION]: {
    stage: FeatureStage.EXPERIMENTAL,
    defaultOn: true,
  },
  [FeatureName.EVENTARC_TOOL_CONFIG]: {
    stage: FeatureStage.EXPERIMENTAL,
    defaultOn: true,
  },
  [FeatureName.EVENTARC_TOOLSET]: {
    stage: FeatureStage.EXPERIMENTAL,
    defaultOn: true,
  },
  [FeatureName.FALLBACK_MODEL]: {
    stage: FeatureStage.EXPERIMENTAL,
    defaultOn: true,
  },
  [FeatureName.GCS_ADMIN_TOOLSET]: {
    stage: FeatureStage.EXPERIMENTAL,
    defaultOn: true,
  },
  [FeatureName.GCS_TOOL_SETTINGS]: {
    stage: FeatureStage.EXPERIMENTAL,
    defaultOn: true,
  },
  [FeatureName.GCS_TOOLSET]: {
    stage: FeatureStage.EXPERIMENTAL,
    defaultOn: true,
  },
  [FeatureName.GOOGLE_CREDENTIALS_CONFIG]: {
    stage: FeatureStage.EXPERIMENTAL,
    defaultOn: true,
  },
  [FeatureName.GOOGLE_TOOL]: {
    stage: FeatureStage.EXPERIMENTAL,
    defaultOn: true,
  },
  [FeatureName.JSON_SCHEMA_FOR_FUNC_DECL]: {
    stage: FeatureStage.EXPERIMENTAL,
    defaultOn: true,
  },
  [FeatureName.MCP_AGENT_SERVER]: {
    stage: FeatureStage.EXPERIMENTAL,
    defaultOn: true,
  },
  [FeatureName.MCP_GRACEFUL_ERROR_HANDLING]: {
    stage: FeatureStage.EXPERIMENTAL,
    defaultOn: true,
  },
  [FeatureName.PROGRESSIVE_SSE_STREAMING]: {
    stage: FeatureStage.EXPERIMENTAL,
    defaultOn: true,
  },
  [FeatureName.PUBSUB_TOOL_CONFIG]: {
    stage: FeatureStage.EXPERIMENTAL,
    defaultOn: true,
  },
  [FeatureName.PUBSUB_TOOLSET]: {
    stage: FeatureStage.EXPERIMENTAL,
    defaultOn: true,
  },
  [FeatureName.SKILL_TOOLSET]: {
    stage: FeatureStage.STABLE,
    defaultOn: true,
  },
  [FeatureName.SPANNER_ADMIN_TOOLSET]: {
    stage: FeatureStage.EXPERIMENTAL,
    defaultOn: true,
  },
  [FeatureName.SPANNER_TOOLSET]: {
    stage: FeatureStage.EXPERIMENTAL,
    defaultOn: true,
  },
  [FeatureName.SPANNER_TOOL_SETTINGS]: {
    stage: FeatureStage.EXPERIMENTAL,
    defaultOn: true,
  },
  [FeatureName.SPANNER_VECTOR_STORE]: {
    stage: FeatureStage.EXPERIMENTAL,
    defaultOn: true,
  },
  [FeatureName.TOOL_CONFIG]: {
    stage: FeatureStage.EXPERIMENTAL,
    defaultOn: true,
  },
  [FeatureName.TOOL_CONFIRMATION]: {
    stage: FeatureStage.EXPERIMENTAL,
    defaultOn: true,
  },
  [FeatureName.PLUGGABLE_AUTH]: {
    stage: FeatureStage.EXPERIMENTAL,
    defaultOn: true,
  },
  [FeatureName.SNAKE_CASE_SKILL_NAME]: {
    stage: FeatureStage.EXPERIMENTAL,
    defaultOn: false,
  },
  [FeatureName.IN_MEMORY_SESSION_SERVICE_LIGHT_COPY]: {
    stage: FeatureStage.WIP,
    defaultOn: false,
  },
};

const WARNED_FEATURES = new Set<FeatureName>();
const FEATURE_OVERRIDES: Partial<Record<FeatureName, boolean>> = {};

/**
 * Get the configuration of a feature from the registry.
 *
 * @param featureName The feature name.
 * @returns The feature config from the registry, or undefined if not found.
 */
export function getFeatureConfig(
  featureName: FeatureName,
): FeatureConfig | undefined {
  return FEATURE_REGISTRY[featureName];
}

/**
 * Register a feature with a specific config.
 *
 * @param featureName The feature name.
 * @param config The feature config to register.
 */
export function registerFeature(
  featureName: FeatureName,
  config: FeatureConfig,
): void {
  FEATURE_REGISTRY[featureName] = {
    stage: config.stage,
    defaultOn: config.defaultOn ?? false,
  };
}

/**
 * Programmatically override a feature's enabled state.
 *
 * This override takes highest priority, superseding environment variables
 * and registry defaults.
 *
 * @param featureName The feature name to override.
 * @param enabled Whether the feature should be enabled.
 */
export function overrideFeatureEnabled(
  featureName: FeatureName,
  enabled: boolean | undefined,
): void {
  const config = getFeatureConfig(featureName);
  if (!config) {
    throw new Error(`Feature ${featureName} is not registered.`);
  }
  if (enabled === undefined) {
    delete FEATURE_OVERRIDES[featureName];
  } else {
    FEATURE_OVERRIDES[featureName] = enabled;
  }
}

/**
 * Check if a feature is enabled at runtime.
 *
 * Priority order (highest to lowest):
 * 1. Programmatic overrides
 * 2. Environment variables (ADK_ENABLE_* / ADK_DISABLE_*)
 * 3. Registry defaults
 *
 * @param featureName The feature name.
 * @returns True if the feature is enabled, false otherwise.
 */
export function isFeatureEnabled(featureName: FeatureName): boolean {
  const config = FEATURE_REGISTRY[featureName];
  if (!config) {
    throw new Error(`Feature ${featureName} is not registered.`);
  }

  // Check programmatic overrides first
  if (featureName in FEATURE_OVERRIDES) {
    const enabled = FEATURE_OVERRIDES[featureName]!;
    if (enabled && config.stage !== FeatureStage.STABLE) {
      emitNonStableWarningOnce(featureName, config.stage);
    }
    return enabled;
  }

  // Check environment variables
  const enableVar = `ADK_ENABLE_${featureName}`;
  const disableVar = `ADK_DISABLE_${featureName}`;

  if (getBooleanEnvVar(enableVar)) {
    if (config.stage !== FeatureStage.STABLE) {
      emitNonStableWarningOnce(featureName, config.stage);
    }
    return true;
  }

  if (getBooleanEnvVar(disableVar)) {
    return false;
  }

  // Fall back to registry config
  if (config.stage !== FeatureStage.STABLE && config.defaultOn) {
    emitNonStableWarningOnce(featureName, config.stage);
  }
  return config.defaultOn;
}

function emitNonStableWarningOnce(
  featureName: FeatureName,
  featureStage: FeatureStage,
): void {
  if (!WARNED_FEATURES.has(featureName)) {
    WARNED_FEATURES.add(featureName);
    logger.warn(
      `[${featureStage.toUpperCase()}] feature ${featureName} is enabled.`,
    );
  }
}

/**
 * Temporarily overrides a feature for the duration of a callback.
 */
export async function withTemporaryFeatureOverride<T>(
  featureName: FeatureName,
  enabled: boolean,
  callback: () => Promise<T> | T,
): Promise<T> {
  const config = getFeatureConfig(featureName);
  if (!config) {
    throw new Error(`Feature ${featureName} is not registered.`);
  }

  const hadOverride = featureName in FEATURE_OVERRIDES;
  const originalValue = FEATURE_OVERRIDES[featureName];

  FEATURE_OVERRIDES[featureName] = enabled;

  try {
    return await callback();
  } finally {
    if (hadOverride) {
      FEATURE_OVERRIDES[featureName] = originalValue;
    } else {
      delete FEATURE_OVERRIDES[featureName];
    }
  }
}
