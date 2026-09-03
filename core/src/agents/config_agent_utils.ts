/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {Schema} from '@google/genai';

import {InputValidationError} from '../errors/input_validation_error.js';
import {isBaseLlm} from '../models/base_llm.js';
import {isBaseTool} from '../tools/base_tool.js';
import {isBaseToolset} from '../tools/base_toolset.js';
import type {ToolArgsConfig, ToolConfig} from '../tools/tool_configs.js';
import {resolveFullyQualifiedName} from '../utils/module_utils.js';
import {isZodObject} from '../utils/simple_zod_to_json.js';
import type {BaseAgent, SingleAgentCallback} from './base_agent.js';
import {isBaseAgent} from './base_agent.js';
import type {AgentRefConfig, CodeConfig} from './common_configs.js';
import {requireExactlyOneSource} from './common_configs.js';
import type {
  LlmAgentConfig,
  LlmAgentSchema,
  SingleAfterModelCallback,
  SingleAfterToolCallback,
  SingleBeforeModelCallback,
  SingleBeforeToolCallback,
  ToolUnion,
} from './llm_agent.js';
import {LlmAgent} from './llm_agent.js';
import type {LlmAgentYamlConfig} from './llm_agent_config.js';

/**
 * The loosest shape every callback kind fits. Parameters are contravariant, so
 * a callback taking any argument list is assignable to this type.
 */
export type CallbackFunction = (...args: never[]) => unknown;

/** A function a configuration document names to build a tool. */
type ToolFactory = (args: ToolArgsConfig) => unknown;

function isToolFactory(value: unknown): value is ToolFactory {
  return typeof value === 'function';
}

/**
 * A `@google/genai` `Schema` is a plain data object, so a class instance — a
 * Zod schema of some other kind, for instance — is not one.
 */
function isGenaiSchema(value: unknown): value is Schema {
  return (
    typeof value === 'object' && value !== null && value.constructor === Object
  );
}

/**
 * Resolves a list of callback references to the functions they name, in the
 * order the document lists them, which is the order they run in.
 *
 * The resolver checks that each reference names a function and nothing more: a
 * function's parameter types are not observable at run time. `T` is therefore
 * the caller's claim about the callback kind the document declared.
 *
 * @experimental (Experimental, subject to change.)
 *
 * @param configs The references to resolve. `undefined` resolves to `[]`.
 * @param baseFilePath Absolute path of the configuration file the references
 *   came from.
 * @return The named functions, in config order.
 * @throws {InputValidationError} When a name does not resolve, or names
 *   something other than a function.
 */
export async function resolveCallbacks<
  T extends CallbackFunction = CallbackFunction,
>(configs: CodeConfig[] | undefined, baseFilePath?: string): Promise<T[]> {
  const callbacks: T[] = [];
  for (const config of configs ?? []) {
    const resolved = await resolveFullyQualifiedName(config.name, baseFilePath);
    if (typeof resolved !== 'function') {
      throw new InputValidationError(
        `The callback \`${config.name}\` is not a function.`,
      );
    }
    // The run-time check above is all a function's identity offers; its
    // parameter types are erased, so the declared kind cannot be verified.
    callbacks.push(resolved as T);
  }
  return callbacks;
}

/**
 * Resolves a list of tool references to the tools they name.
 *
 * A reference may name a tool instance, a toolset, or a factory that builds
 * one from the declared `args`.
 *
 * @experimental (Experimental, subject to change.)
 *
 * @param configs The references to resolve. `undefined` resolves to `[]`.
 * @param baseFilePath Absolute path of the configuration file the references
 *   came from.
 * @return The tools, in config order.
 * @throws {InputValidationError} When a name does not resolve, names something
 *   that is not a tool, or carries `args` that nothing would read.
 */
export async function resolveTools(
  configs: ToolConfig[] | undefined,
  baseFilePath?: string,
): Promise<ToolUnion[]> {
  const tools: ToolUnion[] = [];
  for (const config of configs ?? []) {
    tools.push(await resolveTool(config, baseFilePath));
  }
  return tools;
}

async function resolveTool(
  config: ToolConfig,
  baseFilePath?: string,
): Promise<ToolUnion> {
  const resolved = await resolveFullyQualifiedName(config.name, baseFilePath);
  if (isBaseTool(resolved) || isBaseToolset(resolved)) {
    if (config.args !== undefined) {
      throw new InputValidationError(
        `The tool \`${config.name}\` names a tool that already exists, so ` +
          `its \`args\` would not be read. Name a factory instead, or drop ` +
          `the \`args\`.`,
      );
    }
    return resolved;
  }
  if (!isToolFactory(resolved)) {
    throw new InputValidationError(
      `The tool \`${config.name}\` names neither a tool, a toolset, nor a ` +
        `factory that builds one.`,
    );
  }
  return buildTool(config, resolved);
}

async function buildTool(
  config: ToolConfig,
  factory: ToolFactory,
): Promise<ToolUnion> {
  let built: unknown;
  try {
    built = await factory(config.args ?? {});
  } catch (cause: unknown) {
    // Calling a class without `new` raises a TypeError, which is the mistake
    // this path is most likely to see.
    throw new InputValidationError(
      `The tool factory \`${config.name}\` failed.`,
      {cause},
    );
  }
  if (!isBaseTool(built) && !isBaseToolset(built)) {
    throw new InputValidationError(
      `The tool factory \`${config.name}\` returned neither a tool nor a ` +
        `toolset.`,
    );
  }
  return built;
}

async function resolveSchema(
  config: CodeConfig,
  baseFilePath?: string,
): Promise<LlmAgentSchema> {
  const resolved = await resolveFullyQualifiedName(config.name, baseFilePath);
  if (isZodObject(resolved) || isGenaiSchema(resolved)) {
    return resolved;
  }
  throw new InputValidationError(
    `The schema \`${config.name}\` is neither a Zod object nor a schema ` +
      `object.`,
  );
}

async function resolveModel(config: CodeConfig, baseFilePath?: string) {
  const resolved = await resolveFullyQualifiedName(config.name, baseFilePath);
  if (!isBaseLlm(resolved)) {
    throw new InputValidationError(
      `The model \`${config.name}\` is not a BaseLlm.`,
    );
  }
  return resolved;
}

async function resolveSubAgents(
  refs: AgentRefConfig[] | undefined,
  baseFilePath?: string,
): Promise<BaseAgent[]> {
  const subAgents: BaseAgent[] = [];
  for (const ref of refs ?? []) {
    subAgents.push(
      await resolveSubAgent(requireExactlyOneSource(ref), baseFilePath),
    );
  }
  return subAgents;
}

async function resolveSubAgent(
  ref: AgentRefConfig,
  baseFilePath?: string,
): Promise<BaseAgent> {
  if (ref.code === undefined) {
    throw new InputValidationError(
      `Loading the sub-agent declared by \`${ref.configPath}\` from its own ` +
        `config file is not supported yet. Name the agent with \`code\` ` +
        `instead.`,
    );
  }
  const resolved = await resolveFullyQualifiedName(ref.code, baseFilePath);
  if (!isBaseAgent(resolved)) {
    throw new InputValidationError(
      `The sub-agent \`${ref.code}\` is not an agent.`,
    );
  }
  return resolved;
}

/**
 * Builds an {@link LlmAgent} from a validated configuration document.
 *
 * Every reference the document names is imported, which runs that module's
 * top-level code. A caller trusts the document exactly as far as it trusts the
 * code the document can name.
 *
 * @experimental (Experimental, subject to change.)
 *
 * @param config The validated config, from `parseLlmAgentConfig`.
 * @param baseFilePath Absolute path of the configuration file. A
 *   `./`-relative reference in the document resolves against its directory and
 *   needs it.
 * @return The agent the document describes.
 * @throws {InputValidationError} When a reference does not resolve, or
 *   resolves to the wrong kind of value.
 */
export async function llmAgentFromConfig(
  config: LlmAgentYamlConfig,
  baseFilePath?: string,
): Promise<LlmAgent> {
  const options: LlmAgentConfig = {
    name: config.name,
    description: config.description,
    instruction: config.instruction,
    includeContents: config.includeContents,
    tools: await resolveTools(config.tools, baseFilePath),
    subAgents: await resolveSubAgents(config.subAgents, baseFilePath),
    model: config.modelCode
      ? await resolveModel(config.modelCode, baseFilePath)
      : config.model,
    inputSchema: config.inputSchema
      ? await resolveSchema(config.inputSchema, baseFilePath)
      : undefined,
    outputSchema: config.outputSchema
      ? await resolveSchema(config.outputSchema, baseFilePath)
      : undefined,
    outputKey: config.outputKey,
    disallowTransferToParent: config.disallowTransferToParent,
    disallowTransferToPeers: config.disallowTransferToPeers,
    generateContentConfig: config.generateContentConfig,
    // A resolved callback list is `[]` when the document declares none, which
    // is not what an absent option means, so these stay conditional.
    ...(config.beforeAgentCallbacks !== undefined && {
      beforeAgentCallback: await resolveCallbacks<SingleAgentCallback>(
        config.beforeAgentCallbacks,
        baseFilePath,
      ),
    }),
    ...(config.afterAgentCallbacks !== undefined && {
      afterAgentCallback: await resolveCallbacks<SingleAgentCallback>(
        config.afterAgentCallbacks,
        baseFilePath,
      ),
    }),
    ...(config.beforeModelCallbacks !== undefined && {
      beforeModelCallback: await resolveCallbacks<SingleBeforeModelCallback>(
        config.beforeModelCallbacks,
        baseFilePath,
      ),
    }),
    ...(config.afterModelCallbacks !== undefined && {
      afterModelCallback: await resolveCallbacks<SingleAfterModelCallback>(
        config.afterModelCallbacks,
        baseFilePath,
      ),
    }),
    ...(config.beforeToolCallbacks !== undefined && {
      beforeToolCallback: await resolveCallbacks<SingleBeforeToolCallback>(
        config.beforeToolCallbacks,
        baseFilePath,
      ),
    }),
    ...(config.afterToolCallbacks !== undefined && {
      afterToolCallback: await resolveCallbacks<SingleAfterToolCallback>(
        config.afterToolCallbacks,
        baseFilePath,
      ),
    }),
  };
  return new LlmAgent(options);
}
