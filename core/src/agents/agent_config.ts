/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {ContentUnion, GenerateContentConfig} from '@google/genai';
import {z} from 'zod';
import {InputValidationError} from '../errors/input_validation_error.js';
import {toolConfigSchema} from '../tools/tool_configs.js';
import {camelCaseKeys} from '../utils/case_utils.js';
import {warnDeprecatedOnce} from '../utils/deprecated.js';
import {agentRefConfigSchema, codeConfigSchema} from './common_configs.js';

const AGENT_CONFIG_DEPRECATION =
  'AgentConfig is deprecated and will be removed in future versions. Config ' +
  'is now loaded via reflection so the separate config class is no longer ' +
  'needed.';

/** Names the config shape a document is validated against. */
export type AgentConfigTag =
  | 'LlmAgent'
  | 'LoopAgent'
  | 'ParallelAgent'
  | 'SequentialAgent'
  | 'BaseAgent';

/** The bare name of an agent class ADK owns. */
export type AdkAgentClass = Exclude<AgentConfigTag, 'BaseAgent'>;

const ADK_AGENT_CLASSES: readonly AdkAgentClass[] = [
  'LlmAgent',
  'LoopAgent',
  'ParallelAgent',
  'SequentialAgent',
];

const DEFAULT_AGENT_CLASS: AdkAgentClass = 'LlmAgent';

/** Reports whether `value` is the bare name of an agent class ADK owns. */
export function isAdkAgentClass(value: unknown): value is AdkAgentClass {
  return ADK_AGENT_CLASSES.some((name) => name === value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const staticInstructionSchema = z.custom<ContentUnion>(
  (value) =>
    typeof value === 'string' || Array.isArray(value) || isRecord(value),
  {error: 'staticInstruction must be a string, a Part, or a Content'},
);

const generateContentConfigSchema = z.custom<GenerateContentConfig>(isRecord, {
  error: 'generateContentConfig must be an object',
});

const baseAgentFields = {
  /** The name of the agent. */
  name: z.string(),
  /** The description of the agent. */
  description: z.string().default(''),
  /** The sub-agents of the agent. */
  subAgents: z.array(agentRefConfigSchema).optional(),
  /** Callbacks run before the agent, in config order. */
  beforeAgentCallbacks: z.array(codeConfigSchema).optional(),
  /** Callbacks run after the agent, in config order. */
  afterAgentCallbacks: z.array(codeConfigSchema).optional(),
};

/**
 * Schema of the config of an agent class ADK does not own.
 *
 * This is the open shape: it keeps the keys it does not know, so a custom agent
 * class can read its own fields off the parsed config.
 *
 * @experimental
 * @deprecated Config is now loaded via reflection, not via a config class.
 */
export const baseAgentYamlConfigSchema = z.preprocess(
  camelCaseKeys,
  z.looseObject({
    ...baseAgentFields,
    agentClass: z.string().default('BaseAgent'),
  }),
);

/**
 * The config of an agent class ADK does not own.
 *
 * @experimental
 * @deprecated Config is now loaded via reflection, not via a config class.
 */
export type BaseAgentYamlConfig = z.infer<typeof baseAgentYamlConfigSchema>;

/**
 * Schema of an `LlmAgent` config.
 *
 * @experimental
 * @deprecated Config is now loaded via reflection, not via a config class.
 */
export const llmAgentYamlConfigSchema = z.preprocess(
  camelCaseKeys,
  z
    .strictObject({
      ...baseAgentFields,
      agentClass: z.string().default('LlmAgent'),
      /** The name of the model, such as `gemini-2.5-flash`. */
      model: z.string().optional(),
      /** A code reference that builds the model. Excludes `model`. */
      modelCode: codeConfigSchema.optional(),
      /** The instruction of the agent, with placeholder support. */
      instruction: z.string(),
      /** Static content sent literally, without placeholder processing. */
      staticInstruction: staticInstructionSchema.optional(),
      disallowTransferToParent: z.boolean().optional(),
      disallowTransferToPeers: z.boolean().optional(),
      /** A code reference to the input schema, not a schema document. */
      inputSchema: codeConfigSchema.optional(),
      /** A code reference to the output schema, not a schema document. */
      outputSchema: codeConfigSchema.optional(),
      outputKey: z.string().optional(),
      includeContents: z.enum(['default', 'none']).default('default'),
      /** The tools of the agent. */
      tools: z.array(toolConfigSchema).optional(),
      beforeModelCallbacks: z.array(codeConfigSchema).optional(),
      afterModelCallbacks: z.array(codeConfigSchema).optional(),
      beforeToolCallbacks: z.array(codeConfigSchema).optional(),
      afterToolCallbacks: z.array(codeConfigSchema).optional(),
      generateContentConfig: generateContentConfigSchema.optional(),
    })
    .check((ctx) => {
      const {model, modelCode} = ctx.value;
      if (model !== undefined && modelCode !== undefined) {
        ctx.issues.push({
          code: 'custom',
          input: ctx.value,
          message:
            'Only one of `model` or `model_code` should be set, but both ' +
            `were provided. Got model=${JSON.stringify(model)} and ` +
            `model_code=${JSON.stringify(modelCode)}.`,
        });
      }
    }),
);

/**
 * The config of an `LlmAgent`.
 *
 * @experimental
 * @deprecated Config is now loaded via reflection, not via a config class.
 */
export type LlmAgentYamlConfig = z.infer<typeof llmAgentYamlConfigSchema>;

/**
 * Schema of a `LoopAgent` config.
 *
 * @experimental
 * @deprecated Config is now loaded via reflection, not via a config class.
 */
export const loopAgentYamlConfigSchema = z.preprocess(
  camelCaseKeys,
  z.strictObject({
    ...baseAgentFields,
    agentClass: z.string().default('LoopAgent'),
    /** The number of times the agent runs its sub-agents. */
    maxIterations: z.int().optional(),
  }),
);

/**
 * The config of a `LoopAgent`.
 *
 * @experimental
 * @deprecated Config is now loaded via reflection, not via a config class.
 */
export type LoopAgentYamlConfig = z.infer<typeof loopAgentYamlConfigSchema>;

/**
 * Schema of a `ParallelAgent` config.
 *
 * @experimental
 * @deprecated Config is now loaded via reflection, not via a config class.
 */
export const parallelAgentYamlConfigSchema = z.preprocess(
  camelCaseKeys,
  z.strictObject({
    ...baseAgentFields,
    agentClass: z.string().default('ParallelAgent'),
  }),
);

/**
 * The config of a `ParallelAgent`.
 *
 * @experimental
 * @deprecated Config is now loaded via reflection, not via a config class.
 */
export type ParallelAgentYamlConfig = z.infer<
  typeof parallelAgentYamlConfigSchema
>;

/**
 * Schema of a `SequentialAgent` config.
 *
 * @experimental
 * @deprecated Config is now loaded via reflection, not via a config class.
 */
export const sequentialAgentYamlConfigSchema = z.preprocess(
  camelCaseKeys,
  z.strictObject({
    ...baseAgentFields,
    agentClass: z.string().default('SequentialAgent'),
  }),
);

/**
 * The config of a `SequentialAgent`.
 *
 * @experimental
 * @deprecated Config is now loaded via reflection, not via a config class.
 */
export type SequentialAgentYamlConfig = z.infer<
  typeof sequentialAgentYamlConfigSchema
>;

/**
 * The config of an agent, as declared in a config document.
 *
 * @experimental
 * @deprecated Config is now loaded via reflection, not via a config class.
 */
export type AgentConfig =
  | LlmAgentYamlConfig
  | LoopAgentYamlConfig
  | ParallelAgentYamlConfig
  | SequentialAgentYamlConfig
  | BaseAgentYamlConfig;

const SCHEMA_BY_TAG: Record<AgentConfigTag, z.ZodType<AgentConfig>> = {
  LlmAgent: llmAgentYamlConfigSchema,
  LoopAgent: loopAgentYamlConfigSchema,
  ParallelAgent: parallelAgentYamlConfigSchema,
  SequentialAgent: sequentialAgentYamlConfigSchema,
  BaseAgent: baseAgentYamlConfigSchema,
};

/**
 * Returns the tag naming the config shape `document` is validated against.
 *
 * The tag comes from the `agent_class` key. A document without that key is an
 * `LlmAgent`, and an agent class ADK does not own is a `BaseAgent`.
 *
 * @param document A config document, already parsed from its file.
 * @throws InputValidationError if `document` is not a plain object.
 *
 * @experimental
 */
export function agentConfigDiscriminator(document: unknown): AgentConfigTag {
  if (!isRecord(document)) {
    throw new InputValidationError(
      `Invalid agent config: ${JSON.stringify(document) ?? String(document)}`,
    );
  }
  const agentClass =
    document['agentClass'] ?? document['agent_class'] ?? DEFAULT_AGENT_CLASS;
  return isAdkAgentClass(agentClass) ? agentClass : 'BaseAgent';
}

/**
 * Validates a config document and returns the config it declares.
 *
 * The document is the parsed content of an agent config file, not a path.
 * Reading the file is the caller's job. Keys are camelCased at every depth
 * before validation, so a document written in the on-disk snake_case spelling
 * and one written in camelCase produce the same config. The conversion reaches
 * inside the free-form `args` bag of a {@link ToolConfig} too.
 *
 * @param document A config document, already parsed from its file.
 * @throws InputValidationError if the document does not match its config shape.
 *
 * @experimental
 * @deprecated Config is now loaded via reflection, not via a config class.
 */
export function parseAgentConfig(document: unknown): AgentConfig {
  warnDeprecatedOnce('AgentConfig', AGENT_CONFIG_DEPRECATION);
  const tag = agentConfigDiscriminator(document);
  const result = SCHEMA_BY_TAG[tag].safeParse(document);
  if (!result.success) {
    throw new InputValidationError(
      `Invalid agent config: ${z.prettifyError(result.error)}`,
    );
  }
  return result.data;
}
