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

/** Identifies the deprecation, so it warns at most once per process. */
const DEPRECATION_KEY = 'ParallelAgentConfig';

/** Wording taken from the `@deprecated` decorator on the Python class. */
const DEPRECATION_MESSAGE =
  'ParallelAgentConfig is deprecated and will be removed in future versions. ' +
  'Config is now loaded via reflection so the separate config class is no ' +
  'longer needed.';

/**
 * Ports `CodeConfig`: a variable, function or class referenced by its fully
 * qualified name.
 */
const codeRefSchema = z.strictObject({name: z.string()});

/**
 * Ports `AgentRefConfig`: a sub-agent named either by config file or by code
 * reference, never both.
 */
const agentRefSchema = z
  .strictObject({
    configPath: z.string().optional(),
    code: z.string().optional(),
  })
  .check((ctx) => {
    const hasCode = ctx.value.code !== undefined;
    const hasConfigPath = ctx.value.configPath !== undefined;
    if (hasCode && hasConfigPath) {
      ctx.issues.push({
        code: 'custom',
        input: ctx.value,
        message: 'Only one of `code` or `config_path` should be provided',
      });
    } else if (!hasCode && !hasConfigPath) {
      ctx.issues.push({
        code: 'custom',
        input: ctx.value,
        message: 'Exactly one of `code` or `config_path` must be provided',
      });
    }
  });

/**
 * Validates a `ParallelAgent` config document.
 *
 * Ports adk-python `ParallelAgentConfig`
 * (`google/adk/agents/parallel_agent_config.py`). The `Yaml` infix keeps these
 * symbols apart from adk-js `BaseAgentConfig` and `LoopAgentConfig`, which are
 * constructor options rather than a document schema.
 *
 * A document may spell its keys in the on-disk snake_case form or in
 * camelCase; both validate to the same camelCase config. Unknown keys are
 * rejected, which is what adk-python's `extra="forbid"` does.
 *
 * Use this directly for `safeParse` semantics;
 * {@link parseParallelAgentYamlConfig} is the throwing entry point.
 *
 * @experimental
 * @deprecated Config is now loaded via reflection, so the separate config
 *   schema is no longer needed.
 */
export const parallelAgentYamlConfigSchema = z.preprocess(
  camelCaseKeys,
  z.strictObject({
    agentClass: z.string().default('ParallelAgent'),
    name: z.string(),
    description: z.string().default(''),
    subAgents: z.array(agentRefSchema).optional(),
    beforeAgentCallbacks: z.array(codeRefSchema).optional(),
    afterAgentCallbacks: z.array(codeRefSchema).optional(),
  }),
);

/**
 * A validated `ParallelAgent` config document.
 *
 * @experimental
 * @deprecated Config is now loaded via reflection, so the separate config
 *   schema is no longer needed.
 */
export type ParallelAgentYamlConfig = z.infer<
  typeof parallelAgentYamlConfigSchema
>;

/**
 * Validates an already-parsed `ParallelAgent` config document.
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
export function parseParallelAgentYamlConfig(
  document: unknown,
): ParallelAgentYamlConfig {
  warnDeprecatedOnce(DEPRECATION_KEY, DEPRECATION_MESSAGE);

  if (!isFeatureEnabled(FeatureName.AGENT_CONFIG)) {
    throw new Error(`Feature ${FeatureName.AGENT_CONFIG} is not enabled.`);
  }

  const result = parallelAgentYamlConfigSchema.safeParse(document);
  if (!result.success) {
    throw new InputValidationError(
      `Invalid ParallelAgent config: ${z.prettifyError(result.error)}`,
    );
  }
  return result.data;
}
