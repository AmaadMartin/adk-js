/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {z} from 'zod';
import {InputValidationError} from '../errors/input_validation_error.js';
import {FeatureName, isFeatureEnabled} from '../features/feature_registry.js';
import {camelCaseKeys} from '../utils/case_utils.js';
import {warnDeprecatedOnce} from '../utils/deprecated.js';
import {agentRefConfigSchema, codeConfigSchema} from './common_configs.js';

/** Wording taken from the `@deprecated` decorator on the Python class. */
const DEPRECATION_MESSAGE =
  'LoopAgentConfig is deprecated and will be removed in future versions. ' +
  'Config is now loaded via reflection so the separate config class is no ' +
  'longer needed.';

/**
 * Validates a `LoopAgent` config document.
 *
 * Ports adk-python `LoopAgentConfig`
 * (`google/adk/agents/loop_agent_config.py`). The `Yaml` infix keeps these
 * symbols apart from adk-js `LoopAgentConfig`, which is the constructor
 * options of a `LoopAgent` rather than a document schema.
 *
 * A document may spell its keys in the on-disk snake_case form or in
 * camelCase; both validate to the same camelCase config. Unknown keys are
 * rejected, which is what adk-python's `extra="forbid"` does.
 *
 * The schema validates and nothing else. {@link parseLoopAgentYamlConfig} is
 * the entry point that also warns the deprecation and checks the
 * `AGENT_CONFIG` feature.
 *
 * @experimental
 * @deprecated Config is now loaded via reflection, so the separate config
 *   schema is no longer needed.
 */
export const loopAgentYamlConfigSchema = z.preprocess(
  camelCaseKeys,
  z.strictObject({
    agentClass: z.string().default('LoopAgent'),
    name: z.string(),
    description: z.string().default(''),
    maxIterations: z.int().optional(),
    subAgents: z.array(agentRefConfigSchema).optional(),
    beforeAgentCallbacks: z.array(codeConfigSchema).optional(),
    afterAgentCallbacks: z.array(codeConfigSchema).optional(),
  }),
);

/**
 * A validated `LoopAgent` config document.
 *
 * `agentClass` and `description` always carry a value, because the schema
 * defaults them. Every other optional key is absent when the document omits
 * it.
 *
 * @experimental
 * @deprecated Config is now loaded via reflection, so the separate config
 *   schema is no longer needed.
 */
export type LoopAgentYamlConfig = z.infer<typeof loopAgentYamlConfigSchema>;

/**
 * Validates an already-parsed `LoopAgent` config document.
 *
 * Reading the file and parsing its YAML is the caller's job, matching
 * adk-python, where `model_validate` takes the loaded mapping.
 *
 * @param document The parsed content of a config document.
 * @returns The validated config, with defaults applied.
 * @throws InputValidationError If the document does not satisfy the schema.
 * @throws Error If the `AGENT_CONFIG` feature is disabled.
 *
 * @experimental
 * @deprecated Config is now loaded via reflection, so the separate config
 *   schema is no longer needed.
 */
export function parseLoopAgentYamlConfig(
  document: unknown,
): LoopAgentYamlConfig {
  warnDeprecatedOnce('LoopAgentConfig', DEPRECATION_MESSAGE);

  if (!isFeatureEnabled(FeatureName.AGENT_CONFIG)) {
    throw new Error(`Feature ${FeatureName.AGENT_CONFIG} is not enabled.`);
  }

  const result = loopAgentYamlConfigSchema.safeParse(document);
  if (!result.success) {
    throw new InputValidationError(
      `Invalid LoopAgent config: ${z.prettifyError(result.error)}`,
    );
  }
  return result.data;
}
