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

const DEPRECATION_REASON =
  'BaseAgentYamlConfig is deprecated and will be removed in future versions. ' +
  'Config is now loaded via reflection so the separate config class is no ' +
  'longer needed.';

/**
 * Schema of the config document of a base agent.
 *
 * This is the open shape: a key the schema does not know survives validation,
 * so a custom agent class reads its own fields off the parsed config. Keys are
 * camelCased at every depth before validation, so a document written in the
 * snake_case spelling adk-python uses and one written in camelCase produce the
 * same config.
 *
 * @experimental
 * @deprecated Config is now loaded via reflection, not via a config class.
 */
export const baseAgentYamlConfigSchema = z.preprocess(
  camelCaseKeys,
  z.looseObject({
    /**
     * The class of the agent. The value tells one agent class from another; a
     * value ADK does not own names a custom agent class.
     */
    agentClass: z.string().default('BaseAgent'),
    /** The name of the agent. */
    name: z.string().min(1),
    /** The description of the agent. */
    description: z.string().default(''),
    /** The sub-agents of the agent. */
    subAgents: z.array(agentRefConfigSchema).optional(),
    /**
     * The callbacks run before the agent, in document order.
     *
     * Example:
     *
     * ```yaml
     * before_agent_callbacks:
     *   - name: my_library.security_callbacks.before_agent_callback
     * ```
     */
    beforeAgentCallbacks: z.array(codeConfigSchema).optional(),
    /** The callbacks run after the agent, in document order. */
    afterAgentCallbacks: z.array(codeConfigSchema).optional(),
  }),
);

/**
 * The config document of a base agent.
 *
 * @experimental
 * @deprecated Config is now loaded via reflection, not via a config class.
 */
export type BaseAgentYamlConfig = z.infer<typeof baseAgentYamlConfigSchema>;

/**
 * Validates a config document and returns the config it declares.
 *
 * `raw` is the parsed content of a config file, such as whatever `yaml.load()`
 * returned. Reading the file is the caller's job, and so is resolving a
 * `code` reference into a value.
 *
 * @param raw A config document, already parsed from its file.
 * @throws Error if the `AGENT_CONFIG` feature is disabled.
 * @throws InputValidationError if the document does not match the schema.
 *
 * @experimental
 * @deprecated Config is now loaded via reflection, not via a config class.
 */
export function parseBaseAgentYamlConfig(raw: unknown): BaseAgentYamlConfig {
  if (!isFeatureEnabled(FeatureName.AGENT_CONFIG)) {
    throw new Error(`Feature ${FeatureName.AGENT_CONFIG} is not enabled.`);
  }
  warnDeprecatedOnce('BaseAgentYamlConfig', DEPRECATION_REASON);
  const result = baseAgentYamlConfigSchema.safeParse(raw);
  if (!result.success) {
    throw new InputValidationError(
      `Invalid agent config: ${z.prettifyError(result.error)}`,
      {cause: result.error},
    );
  }
  return result.data;
}
