/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {GenerateContentConfig} from '@google/genai';
import {z} from 'zod';

import {camelCaseKeys} from '../../utils/case_utils.js';

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
 * Accepts the `snake_case` keys used in agent config documents by converting
 * the whole document to camelCase before validation.
 *
 * `camelCaseKeys` is idempotent on already-camelCase input, so a document
 * written either way parses to the same object. `snake_case` is the canonical
 * spelling: it is what adk-python's config files and the shared cross-language
 * fixtures use.
 */
function acceptWireKeys<T extends z.ZodType>(schema: T) {
  return z.preprocess(camelCaseKeys, schema);
}

/**
 * A reference to a variable, function, or class defined in code, named so the
 * host application can resolve it to the live object.
 *
 * Strict by design: constructing an object from arguments written in the config
 * is out of scope here, so an entry carrying anything beyond `name` — notably
 * adk-python's tool `args` — is rejected rather than silently ignored.
 */
export const codeYamlConfigSchema = z.object({name: z.string()}).strict();

/** A reference to a variable, function, or class defined in code. */
export type CodeYamlConfig = z.infer<typeof codeYamlConfigSchema>;

/** A reference to another agent, by config file path or by code reference. */
export const agentRefYamlConfigSchema = acceptWireKeys(
  z
    .object({
      configPath: z.string().optional(),
      code: z.string().optional(),
    })
    .strict()
    .refine(
      (ref) => (ref.configPath === undefined) !== (ref.code === undefined),
      {message: 'Exactly one of `config_path` or `code` must be provided.'},
    ),
);

/** A reference to another agent, by config file path or by code reference. */
export type AgentRefYamlConfig = z.infer<typeof agentRefYamlConfigSchema>;

/**
 * The interior structure of a `GenerateContentConfig` is owned by
 * `@google/genai`; only its object-ness is checked here so the SDK stays the
 * single source of truth for the field list.
 *
 * Note that the wire-key conversion recurses into this value, because the SDK
 * type is camelCase throughout. A key nested inside it that is data rather
 * than an SDK field — a `response_schema` property name, say — is converted
 * too, while string values naming it are not; keep embedded JSON schemas in
 * camelCase.
 */
const generateContentConfigSchema = z.custom<GenerateContentConfig>(
  (value) => typeof value === 'object' && value !== null,
  {message: 'Expected an object.'},
);

/** The fields shared by every declarative agent config. */
const commonAgentYamlObject = z.object({
  agentClass: z.string(),
  name: z.string(),
  description: z.string().default(''),
  subAgents: z.array(agentRefYamlConfigSchema).optional(),
  beforeAgentCallbacks: z.array(codeYamlConfigSchema).optional(),
  afterAgentCallbacks: z.array(codeYamlConfigSchema).optional(),
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
export const baseAgentYamlConfigSchema = acceptWireKeys(
  commonAgentYamlObject
    .extend({agentClass: z.string().default('BaseAgent')})
    .loose(),
);

/** The config of a user-defined or otherwise unrecognised agent class. */
export type BaseAgentYamlConfig = z.infer<typeof baseAgentYamlConfigSchema>;

/** The config of an `LlmAgent`. */
export const llmAgentYamlConfigSchema = acceptWireKeys(
  commonAgentYamlObject
    .extend({
      agentClass: z.string().default('LlmAgent'),
      model: z.string().optional(),
      modelCode: codeYamlConfigSchema.optional(),
      instruction: z.string(),
      disallowTransferToParent: z.boolean().optional(),
      disallowTransferToPeers: z.boolean().optional(),
      inputSchema: codeYamlConfigSchema.optional(),
      outputSchema: codeYamlConfigSchema.optional(),
      outputKey: z.string().optional(),
      includeContents: z.enum(['default', 'none']).default('default'),
      tools: z.array(codeYamlConfigSchema).optional(),
      beforeModelCallbacks: z.array(codeYamlConfigSchema).optional(),
      afterModelCallbacks: z.array(codeYamlConfigSchema).optional(),
      beforeToolCallbacks: z.array(codeYamlConfigSchema).optional(),
      afterToolCallbacks: z.array(codeYamlConfigSchema).optional(),
      generateContentConfig: generateContentConfigSchema.optional(),
    })
    .strict()
    .refine(
      (config) => config.model === undefined || config.modelCode === undefined,
      {
        message: 'Only one of `model` or `model_code` should be set.',
      },
    ),
);

/** The config of an `LlmAgent`. */
export type LlmAgentYamlConfig = z.infer<typeof llmAgentYamlConfigSchema>;

/** The config of a `LoopAgent`. */
export const loopAgentYamlConfigSchema = acceptWireKeys(
  commonAgentYamlObject
    .extend({
      agentClass: z.string().default('LoopAgent'),
      maxIterations: z.number().int().optional(),
    })
    .strict(),
);

/** The config of a `LoopAgent`. */
export type LoopAgentYamlConfig = z.infer<typeof loopAgentYamlConfigSchema>;

/** The config of a `ParallelAgent`. */
export const parallelAgentYamlConfigSchema = acceptWireKeys(
  commonAgentYamlObject
    .extend({agentClass: z.string().default('ParallelAgent')})
    .strict(),
);

/** The config of a `ParallelAgent`. */
export type ParallelAgentYamlConfig = z.infer<
  typeof parallelAgentYamlConfigSchema
>;

/** The config of a `SequentialAgent`. */
export const sequentialAgentYamlConfigSchema = acceptWireKeys(
  commonAgentYamlObject
    .extend({agentClass: z.string().default('SequentialAgent')})
    .strict(),
);

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

const AGENT_YAML_CONFIG_SCHEMAS = {
  LlmAgent: llmAgentYamlConfigSchema,
  LoopAgent: loopAgentYamlConfigSchema,
  ParallelAgent: parallelAgentYamlConfigSchema,
  SequentialAgent: sequentialAgentYamlConfigSchema,
  BaseAgent: baseAgentYamlConfigSchema,
} as const satisfies Record<AgentYamlConfigTag, z.ZodType>;

function isAdkAgentClass(value: unknown): value is AdkAgentClass {
  return ADK_AGENT_CLASSES.some((agentClass) => agentClass === value);
}

function readAgentClass(document: object): unknown {
  if ('agentClass' in document) {
    return document.agentClass;
  }
  if ('agent_class' in document) {
    return document.agent_class;
  }
  return DEFAULT_AGENT_CLASS;
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
 * @param document The raw config document, in either key casing.
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

  const agentClass = readAgentClass(document);
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
 * Accepts the `snake_case` keys used on the wire and returns an object with
 * camelCase properties.
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
