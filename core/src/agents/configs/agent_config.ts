/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {GenerateContentConfig} from '@google/genai';
import {z} from 'zod';

/** Error codes reported by {@link AgentConfigError}. */
export enum AgentConfigErrorCode {
  CONFIG_FILE_NOT_FOUND = 'CONFIG_FILE_NOT_FOUND',
  INVALID_CONFIG = 'INVALID_CONFIG',
  UNSUPPORTED_AGENT_CLASS = 'UNSUPPORTED_AGENT_CLASS',
  UNRESOLVED_REFERENCE = 'UNRESOLVED_REFERENCE',
  INVALID_AGENT_REFERENCE = 'INVALID_AGENT_REFERENCE',
  ABSOLUTE_SUB_AGENT_PATH = 'ABSOLUTE_SUB_AGENT_PATH',
  PATH_TRAVERSAL = 'PATH_TRAVERSAL',
  CIRCULAR_SUB_AGENT_REFERENCE = 'CIRCULAR_SUB_AGENT_REFERENCE',
  UNSUPPORTED_TOOL_ARGS = 'UNSUPPORTED_TOOL_ARGS',
}

/** An error raised while parsing or loading a declarative agent config. */
export class AgentConfigError extends Error {
  constructor(
    readonly code: AgentConfigErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AgentConfigError';
  }
}

/**
 * A reference to a variable, function, or class defined in code, named so the
 * host application can resolve it to the live object.
 */
export const codeYamlConfigSchema = z
  .object({name: z.string()})
  .strict()
  .meta({id: 'CodeConfig'});

/** A reference to a variable, function, or class defined in code. */
export type CodeYamlConfig = z.infer<typeof codeYamlConfigSchema>;

/**
 * A tool entry: the tool's name, plus the arguments used to build it.
 *
 * `args` is free-form, mirroring adk-python's `ToolArgsConfig`. Which shapes
 * the loader knows how to build is a loader concern, not a schema one.
 */
export const toolYamlConfigSchema = z
  .object({
    name: z.string(),
    args: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()
  .meta({id: 'ToolConfig'});

/** A tool entry in an agent config. */
export type ToolYamlConfig = z.infer<typeof toolYamlConfigSchema>;

/** A reference to another agent, by config file path or by code reference. */
export const agentRefYamlConfigSchema = z
  .object({
    config_path: z.string().optional(),
    code: z.string().optional(),
  })
  .strict()
  .refine(
    (ref) => (ref.config_path === undefined) !== (ref.code === undefined),
    {message: 'Exactly one of `config_path` or `code` must be provided.'},
  )
  .meta({id: 'AgentRefConfig'});

/** A reference to another agent, by config file path or by code reference. */
export type AgentRefYamlConfig = z.infer<typeof agentRefYamlConfigSchema>;

/**
 * The interior structure of a `GenerateContentConfig` is owned by
 * `@google/genai`; only its object-ness is checked here so the SDK stays the
 * single source of truth for the field list. Its keys are camelCase, unlike
 * the rest of the document.
 */
const generateContentConfigSchema = z.custom<GenerateContentConfig>(
  (value) => typeof value === 'object' && value !== null,
  {message: 'Expected an object.'},
);

/** The fields shared by every declarative agent config. */
const commonAgentYamlObject = z.object({
  agent_class: z.string(),
  name: z.string(),
  description: z.string().default(''),
  sub_agents: z.array(agentRefYamlConfigSchema).optional(),
  before_agent_callbacks: z.array(codeYamlConfigSchema).optional(),
  after_agent_callbacks: z.array(codeYamlConfigSchema).optional(),
});

/** The fields shared by every declarative agent config. */
export type CommonAgentYamlConfig = z.infer<typeof commonAgentYamlObject>;

/** The names of the fields shared by every declarative agent config. */
export const COMMON_AGENT_YAML_KEYS: readonly string[] = Object.keys(
  commonAgentYamlObject.shape,
);

/**
 * The permissive config every non-built-in `agent_class` lands on.
 *
 * Extra keys are preserved and forwarded to the resolved agent constructor,
 * mirroring adk-python's `extra='allow'` on `BaseAgentConfig`.
 */
export const baseAgentYamlConfigSchema = commonAgentYamlObject
  .extend({agent_class: z.string().default('BaseAgent')})
  .loose()
  .meta({id: 'BaseAgentConfig'});

/** The config of a user-defined or otherwise unrecognised agent class. */
export type BaseAgentYamlConfig = z.infer<typeof baseAgentYamlConfigSchema>;

/** The config of an `LlmAgent`. */
export const llmAgentYamlConfigSchema = commonAgentYamlObject
  .extend({
    agent_class: z.string().default('LlmAgent'),
    model: z.string().optional(),
    model_code: codeYamlConfigSchema.optional(),
    instruction: z.string(),
    disallow_transfer_to_parent: z.boolean().optional(),
    disallow_transfer_to_peers: z.boolean().optional(),
    input_schema: codeYamlConfigSchema.optional(),
    output_schema: codeYamlConfigSchema.optional(),
    output_key: z.string().optional(),
    include_contents: z.enum(['default', 'none']).default('default'),
    tools: z.array(toolYamlConfigSchema).optional(),
    before_model_callbacks: z.array(codeYamlConfigSchema).optional(),
    after_model_callbacks: z.array(codeYamlConfigSchema).optional(),
    before_tool_callbacks: z.array(codeYamlConfigSchema).optional(),
    after_tool_callbacks: z.array(codeYamlConfigSchema).optional(),
    generate_content_config: generateContentConfigSchema.optional(),
  })
  .strict()
  .refine(
    (config) => config.model === undefined || config.model_code === undefined,
    {message: 'Only one of `model` or `model_code` should be set.'},
  )
  .meta({id: 'LlmAgentConfig'});

/** The config of an `LlmAgent`. */
export type LlmAgentYamlConfig = z.infer<typeof llmAgentYamlConfigSchema>;

/** The config of a `LoopAgent`. */
export const loopAgentYamlConfigSchema = commonAgentYamlObject
  .extend({
    agent_class: z.string().default('LoopAgent'),
    max_iterations: z.number().int().positive().optional(),
  })
  .strict()
  .meta({id: 'LoopAgentConfig'});

/** The config of a `LoopAgent`. */
export type LoopAgentYamlConfig = z.infer<typeof loopAgentYamlConfigSchema>;

/** The config of a `ParallelAgent`. */
export const parallelAgentYamlConfigSchema = commonAgentYamlObject
  .extend({agent_class: z.string().default('ParallelAgent')})
  .strict()
  .meta({id: 'ParallelAgentConfig'});

/** The config of a `ParallelAgent`. */
export type ParallelAgentYamlConfig = z.infer<
  typeof parallelAgentYamlConfigSchema
>;

/** The config of a `SequentialAgent`. */
export const sequentialAgentYamlConfigSchema = commonAgentYamlObject
  .extend({agent_class: z.string().default('SequentialAgent')})
  .strict()
  .meta({id: 'SequentialAgentConfig'});

/** The config of a `SequentialAgent`. */
export type SequentialAgentYamlConfig = z.infer<
  typeof sequentialAgentYamlConfigSchema
>;

/** Any declarative agent config document. */
export type AgentYamlConfig =
  | LlmAgentYamlConfig
  | LoopAgentYamlConfig
  | ParallelAgentYamlConfig
  | SequentialAgentYamlConfig
  | BaseAgentYamlConfig;

/** The `agent_class` values that select a built-in ADK config shape. */
export const ADK_AGENT_CLASSES = [
  'LlmAgent',
  'LoopAgent',
  'ParallelAgent',
  'SequentialAgent',
] as const;

/** An `agent_class` value that selects a built-in ADK config shape. */
export type AdkAgentClass = (typeof ADK_AGENT_CLASSES)[number];

/** The config shape a document is validated against. */
export type AgentYamlConfigTag = AdkAgentClass | 'BaseAgent';

/** The `agent_class` a document with no explicit one — or an empty one — uses. */
export const DEFAULT_AGENT_CLASS: AdkAgentClass = 'LlmAgent';

/** Every config shape, keyed by the tag that selects it. */
export const AGENT_YAML_CONFIG_SCHEMAS = {
  LlmAgent: llmAgentYamlConfigSchema,
  LoopAgent: loopAgentYamlConfigSchema,
  ParallelAgent: parallelAgentYamlConfigSchema,
  SequentialAgent: sequentialAgentYamlConfigSchema,
  BaseAgent: baseAgentYamlConfigSchema,
} as const satisfies Record<AgentYamlConfigTag, z.ZodType>;

function isAdkAgentClass(value: unknown): value is AdkAgentClass {
  return ADK_AGENT_CLASSES.some((agentClass) => agentClass === value);
}

/**
 * Selects the config shape a document is validated against.
 *
 * Reproduces adk-python's two documented edge cases: a missing `agent_class`
 * defaults to `LlmAgent`, and an unrecognised `agent_class` falls back to the
 * permissive base config instead of raising. Only bare class names are
 * recognised here — a fully qualified name such as
 * `google.adk.agents.LlmAgent` is tagged `BaseAgent` and re-typed at load time.
 *
 * @param document The raw config document.
 * @returns The tag naming the config shape to validate against.
 * @throws {AgentConfigError} With code `INVALID_CONFIG` if the document is not
 *     an object.
 */
export function agentClassDiscriminator(document: unknown): AgentYamlConfigTag {
  if (
    typeof document !== 'object' ||
    document === null ||
    Array.isArray(document)
  ) {
    throw new AgentConfigError(
      AgentConfigErrorCode.INVALID_CONFIG,
      `Invalid agent config: expected an object, got ${JSON.stringify(document) ?? typeof document}.`,
    );
  }

  const agentClass =
    'agent_class' in document ? document.agent_class : DEFAULT_AGENT_CLASS;
  return isAdkAgentClass(agentClass) ? agentClass : 'BaseAgent';
}

/**
 * Validates `data` against `schema`, reporting failures as an
 * {@link AgentConfigError} that keeps the underlying validation detail.
 */
export function parseWithSchema<T extends z.ZodType>(
  schema: T,
  data: unknown,
): z.infer<T> {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new AgentConfigError(
      AgentConfigErrorCode.INVALID_CONFIG,
      `Invalid agent config: ${z.prettifyError(result.error)}`,
    );
  }
  return result.data;
}

/**
 * Validates a declarative agent config document.
 *
 * Keys are the `snake_case` names adk-python writes; the loader maps them to
 * the camelCase agent constructor options.
 *
 * @param data The raw config document.
 * @returns The validated config.
 * @throws {AgentConfigError} With code `INVALID_CONFIG` if the document does
 *     not satisfy the schema selected by {@link agentClassDiscriminator}.
 */
export function parseAgentYamlConfig(data: unknown): AgentYamlConfig {
  return parseWithSchema(
    AGENT_YAML_CONFIG_SCHEMAS[agentClassDiscriminator(data)],
    data,
  );
}
