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

/** Wording taken from the `@deprecated` decorator on the Python class. */
const DEPRECATION_MESSAGE =
  'LoopAgentConfig is deprecated and will be removed in future versions. ' +
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
    subAgents: z.array(agentRefSchema).optional(),
    beforeAgentCallbacks: z.array(codeRefSchema).optional(),
    afterAgentCallbacks: z.array(codeRefSchema).optional(),
  }),
);

/**
 * A validated `LoopAgent` config document.
 *
 * Declared rather than inferred, so the package surface does not depend on the
 * schema. {@link parseLoopAgentYamlConfig} returns what the schema produced as
 * this type, so a field the schema drops or retypes fails to compile.
 *
 * @experimental
 * @deprecated Config is now loaded via reflection, so the separate config
 *   schema is no longer needed.
 */
export interface LoopAgentYamlConfig {
  /** Identifies the class. `'LoopAgent'` when the document omits it. */
  agentClass: string;
  /** The name of the agent. */
  name: string;
  /** The description of the agent. `''` when the document omits it. */
  description: string;
  /** How many times the agent repeats its sub-agents. */
  maxIterations?: number;
  /** The sub-agents, each named by config file or by code reference. */
  subAgents?: Array<{configPath?: string; code?: string}>;
  /** Callbacks to run before the agent, each by fully qualified name. */
  beforeAgentCallbacks?: Array<{name: string}>;
  /** Callbacks to run after the agent, each by fully qualified name. */
  afterAgentCallbacks?: Array<{name: string}>;
}

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
