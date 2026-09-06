/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {GenerateContentConfig} from '@google/genai';
import {z} from 'zod';

import {InputValidationError} from '../errors/input_validation_error.js';
import {toolConfigSchema} from '../tools/tool_configs.js';
import {toCamelCase} from '../utils/object_notation_utils.js';
import {isPlainObject} from '../utils/object_utils.js';
import {agentRefConfigSchema, codeConfigSchema} from './common_configs.js';

/**
 * The interior of a `GenerateContentConfig` belongs to `@google/genai`, so
 * only its object-ness is checked here and the SDK stays the single source of
 * truth for the field list.
 */
const generateContentConfigSchema = z.custom<GenerateContentConfig>(
  isPlainObject,
  {error: 'Expected an object.'},
);

/**
 * The one path whose keys the rename must not touch. A tool's `args` are the
 * tool's own, so a blanket rename would turn a `corpus_id` arg into `corpusId`
 * and break the tool.
 */
const PRESERVED_KEY_PATHS = ['tools.args'];

/** Renames the snake_case keys a Python-authored document writes. */
function normalizeConfigKeys(raw: unknown): unknown {
  return toCamelCase(raw, PRESERVED_KEY_PATHS);
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
  const result = llmAgentYamlConfigSchema.safeParse(raw);
  if (!result.success) {
    throw new InputValidationError(
      'The agent config document is not a valid LlmAgent config.',
      {cause: result.error},
    );
  }
  return result.data;
}
