/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {GenerateContentConfig} from '@google/genai';
import {z} from 'zod';

import {toolConfigSchema} from '../tools/tool_configs.js';
import {camelCaseKeys, camelCaseTopLevelKeys} from '../utils/case_utils.js';
import {
  agentRefConfigSchema,
  codeConfigSchema,
  parseConfig,
} from './common_configs.js';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The interior of a `GenerateContentConfig` belongs to `@google/genai`, so
 * only its object-ness is checked here and the SDK stays the single source of
 * truth for the field list.
 */
const generateContentConfigSchema = z.custom<GenerateContentConfig>(
  isPlainObject,
  {error: 'Expected an object.'},
);

/** Keys whose values hold a nested config this schema also owns. */
const NESTED_CONFIG_KEYS = [
  'modelCode',
  'inputSchema',
  'outputSchema',
  'subAgents',
  'tools',
  'beforeAgentCallbacks',
  'afterAgentCallbacks',
  'beforeModelCallbacks',
  'afterModelCallbacks',
  'beforeToolCallbacks',
  'afterToolCallbacks',
] as const;

/**
 * Renames the snake_case keys a Python-authored document writes, one level at
 * a time, so that only the keys this schema owns are renamed.
 *
 * A tool's `args` are the tool's own, so they survive verbatim: a blanket deep
 * rename would turn a `corpus_id` arg into `corpusId` and break the tool. A
 * `generateContentConfig` is renamed all the way down, because it is a
 * `@google/genai` value whose JS spelling is camelCase throughout.
 */
function normalizeConfigKeys(raw: unknown): unknown {
  if (!isPlainObject(raw)) {
    return raw;
  }
  const config = camelCaseTopLevelKeys(raw) as Record<string, unknown>;
  for (const key of NESTED_CONFIG_KEYS) {
    const value = config[key];
    if (value === undefined) {
      continue;
    }
    config[key] = Array.isArray(value)
      ? value.map(camelCaseTopLevelKeys)
      : camelCaseTopLevelKeys(value);
  }
  if (config['generateContentConfig'] !== undefined) {
    config['generateContentConfig'] = camelCaseKeys(
      config['generateContentConfig'],
    );
  }
  return config;
}

/** Wording taken from adk-python, so both SDKs report the same rule. */
function bothModelSourcesMessage(model: string, modelCode: unknown): string {
  return (
    'Only one of `model` or `model_code` should be set, but both were ' +
    `provided. Got model=${JSON.stringify(model)} and ` +
    `model_code=${JSON.stringify(modelCode)}.`
  );
}

/**
 * Schema of a declarative `LlmAgent` configuration document.
 *
 * Unknown keys are rejected rather than ignored, so a misspelled key is
 * reported instead of silently doing nothing.
 *
 * @experimental (Experimental, subject to change.)
 * @deprecated adk-python loads config by reflection, so a separate config
 *   shape is on its way out. It is ported here for parity with the documents
 *   adk-python accepts today.
 */
export const llmAgentYamlConfigSchema = z.preprocess(
  normalizeConfigKeys,
  z
    .strictObject({
      /** Identifies the agent class the document describes. */
      agentClass: z.string().default('LlmAgent'),
      /** The name of the agent. */
      name: z.string(),
      /** The description of the agent. */
      description: z.string().default(''),
      /** The instruction of the agent, with placeholder support. */
      instruction: z.string(),
      /** The name of the model, such as `gemini-2.5-flash`. */
      model: z.string().optional(),
      /** A code reference that names a `BaseLlm`. Excludes `model`. */
      modelCode: codeConfigSchema.optional(),
      disallowTransferToParent: z.boolean().optional(),
      disallowTransferToPeers: z.boolean().optional(),
      /** A code reference to the input schema, not a schema document. */
      inputSchema: codeConfigSchema.optional(),
      /** A code reference to the output schema, not a schema document. */
      outputSchema: codeConfigSchema.optional(),
      /** The key in session state that holds the agent's reply. */
      outputKey: z.string().optional(),
      includeContents: z.enum(['default', 'none']).default('default'),
      /** The tools of the agent. */
      tools: z.array(toolConfigSchema).optional(),
      /** The sub-agents of the agent. */
      subAgents: z.array(agentRefConfigSchema).optional(),
      /** Callbacks run before the agent, in config order. */
      beforeAgentCallbacks: z.array(codeConfigSchema).optional(),
      /** Callbacks run after the agent, in config order. */
      afterAgentCallbacks: z.array(codeConfigSchema).optional(),
      /** Callbacks run before the model call, in config order. */
      beforeModelCallbacks: z.array(codeConfigSchema).optional(),
      /** Callbacks run after the model call, in config order. */
      afterModelCallbacks: z.array(codeConfigSchema).optional(),
      /** Callbacks run before a tool call, in config order. */
      beforeToolCallbacks: z.array(codeConfigSchema).optional(),
      /** Callbacks run after a tool call, in config order. */
      afterToolCallbacks: z.array(codeConfigSchema).optional(),
      generateContentConfig: generateContentConfigSchema.optional(),
    })
    .check((ctx) => {
      const {model, modelCode} = ctx.value;
      if (model !== undefined && modelCode !== undefined) {
        ctx.issues.push({
          code: 'custom',
          input: ctx.value,
          message: bothModelSourcesMessage(model, modelCode),
        });
      }
    }),
);

/**
 * A validated declarative `LlmAgent` configuration document.
 *
 * @experimental (Experimental, subject to change.)
 * @deprecated adk-python loads config by reflection, so a separate config
 *   shape is on its way out. It is ported here for parity with the documents
 *   adk-python accepts today.
 */
export type LlmAgentYamlConfig = z.infer<typeof llmAgentYamlConfigSchema>;

/**
 * Validates a parsed `LlmAgent` configuration document, such as the result of
 * `yaml.load`. Both the snake_case spelling adk-python writes and the
 * camelCase spelling TypeScript writes are accepted.
 *
 * @experimental (Experimental, subject to change.)
 *
 * @param raw The parsed document.
 * @return The validated config, with every default filled in.
 * @throws {InputValidationError} When the document breaks the schema. The
 *   `ZodError` naming the offending key rides on the error's `cause`.
 */
export function parseLlmAgentConfig(raw: unknown): LlmAgentYamlConfig {
  return parseConfig(
    llmAgentYamlConfigSchema,
    raw,
    'The agent config document is not a valid LlmAgent config.',
  );
}
