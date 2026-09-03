/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The YAML document schema of a `ParallelAgent`.
 *
 * Ports adk-python `ParallelAgentConfig`
 * (`src/google/adk/agents/parallel_agent_config.py`) together with the
 * inherited fields of `base_agent_config.py` and the element types of
 * `common_configs.py`. A document adk-python accepts here validates, and one it
 * rejects is rejected.
 *
 * The `*YamlConfig` infix separates this document type from `LoopAgentConfig`
 * and the other `*AgentConfig` types in this package, which are constructor
 * options holding live agent instances rather than file references.
 */

import {z} from 'zod';
import {InputValidationError} from '../errors/input_validation_error.js';
import {FeatureName, isFeatureEnabled} from '../features/feature_registry.js';
import {camelCaseKeys} from '../utils/case_utils.js';
import {warnDeprecatedOnce} from '../utils/deprecated.js';

/** Ports `CodeConfig`: a variable, function or class named by its fully qualified name. */
const codeRefSchema = z.strictObject({name: z.string()});

/** Ports `AgentRefConfig`: a sub-agent named by config file or by code, never both. */
const agentRefSchema = z
  .strictObject({
    configPath: z.string().optional(),
    code: z.string().optional(),
  })
  .check((ctx) => {
    const {code, configPath} = ctx.value;
    if ((code === undefined) !== (configPath === undefined)) {
      return;
    }
    ctx.issues.push({
      code: 'custom',
      input: ctx.value,
      // The adk-python wording, kept verbatim so both SDKs report the same
      // thing for the same document.
      message:
        code === undefined
          ? 'Exactly one of `code` or `config_path` must be provided'
          : 'Only one of `code` or `config_path` should be provided',
    });
  });

/**
 * The schema of a `ParallelAgent` configuration document.
 *
 * Unknown keys are rejected at every level, matching adk-python's
 * `extra="forbid"`. Keys are camelCase; use
 * {@link parseParallelAgentYamlConfig} to accept the snake_case spelling a
 * document written for adk-python uses.
 *
 * @deprecated Ports a type adk-python has deprecated.
 */
export const parallelAgentYamlConfigSchema = z.strictObject({
  /** Identifies the agent class. */
  agentClass: z.string().default('ParallelAgent'),
  /** The name of the agent. */
  name: z.string(),
  /** The description of the agent. */
  description: z.string().default(''),
  /** The sub-agents the agent runs, each named by config file or by code. */
  subAgents: z.array(agentRefSchema).optional(),
  /** Callbacks to run before the agent, each named by its fully qualified name. */
  beforeAgentCallbacks: z.array(codeRefSchema).optional(),
  /** Callbacks to run after the agent, each named by its fully qualified name. */
  afterAgentCallbacks: z.array(codeRefSchema).optional(),
});

/**
 * A validated `ParallelAgent` configuration document.
 *
 * @deprecated Ports a type adk-python has deprecated.
 */
export type ParallelAgentYamlConfig = z.infer<
  typeof parallelAgentYamlConfigSchema
>;

/**
 * Validates a `ParallelAgent` configuration document, the counterpart of
 * adk-python's `ParallelAgentConfig.model_validate`.
 *
 * `document` is already parsed — the result of a YAML or JSON load, not a file
 * path. Its keys may be snake_case, as written on disk, or camelCase; both
 * produce the same camelCase result.
 *
 * @param document The parsed configuration document.
 * @returns The validated document, with `agentClass` and `description`
 *     defaulted.
 * @throws Error if the `AGENT_CONFIG` feature is disabled.
 * @throws InputValidationError if the document does not validate.
 *
 * @deprecated Ports a function adk-python has deprecated.
 */
export function parseParallelAgentYamlConfig(
  document: unknown,
): ParallelAgentYamlConfig {
  warnDeprecatedOnce(
    'ParallelAgentYamlConfig',
    'ParallelAgentYamlConfig is deprecated and will be removed in a future ' +
      'version. It ports adk-python ParallelAgentConfig, which is deprecated ' +
      'there.',
  );
  if (!isFeatureEnabled(FeatureName.AGENT_CONFIG)) {
    throw new Error(`Feature ${FeatureName.AGENT_CONFIG} is not enabled.`);
  }
  const result = parallelAgentYamlConfigSchema.safeParse(
    camelCaseKeys(document),
  );
  if (!result.success) {
    throw new InputValidationError(
      `Invalid ParallelAgent config: ${z.prettifyError(result.error)}`,
    );
  }
  return result.data;
}
