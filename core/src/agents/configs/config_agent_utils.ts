/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {GenerateContentConfig} from '@google/genai';
import * as yaml from 'js-yaml';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {z} from 'zod';

import {isBaseLlm} from '../../models/base_llm.js';
import {AgentTool} from '../../tools/agent_tool.js';
import {isBaseTool} from '../../tools/base_tool.js';
import {isBaseToolset} from '../../tools/base_toolset.js';
import {ENTERPRISE_WEB_SEARCH} from '../../tools/enterprise_web_search_tool.js';
import {EXIT_LOOP} from '../../tools/exit_loop_tool.js';
import {getUserChoiceTool} from '../../tools/get_user_choice_tool.js';
import {GOOGLE_MAPS_GROUNDING} from '../../tools/google_maps_grounding_tool.js';
import {GOOGLE_SEARCH} from '../../tools/google_search_tool.js';
import {LOAD_ARTIFACTS} from '../../tools/load_artifacts_tool.js';
import {LOAD_MEMORY} from '../../tools/load_memory_tool.js';
import {PRELOAD_MEMORY} from '../../tools/preload_memory_tool.js';
import {requestInputTool} from '../../tools/request_input_tool.js';
import {URL_CONTEXT} from '../../tools/url_context_tool.js';
import {camelCaseKeys} from '../../utils/case_utils.js';
import {isPathContained} from '../../utils/path_utils.js';
import {
  BaseAgent,
  BaseAgentConfig,
  isBaseAgent,
  SingleAgentCallback,
} from '../base_agent.js';
import {
  LlmAgent,
  LlmAgentConfig,
  LlmAgentSchema,
  SingleAfterModelCallback,
  SingleAfterToolCallback,
  SingleBeforeModelCallback,
  SingleBeforeToolCallback,
  ToolUnion,
} from '../llm_agent.js';
import {LoopAgent, LoopAgentConfig} from '../loop_agent.js';
import {ParallelAgent} from '../parallel_agent.js';
import {SequentialAgent} from '../sequential_agent.js';
import {
  AdkAgentClass,
  AgentConfigError,
  AgentConfigErrorCode,
  AgentRefYamlConfig,
  agentRefYamlConfigSchema,
  BaseAgentYamlConfig,
  baseAgentYamlConfigSchema,
  CodeYamlConfig,
  COMMON_AGENT_YAML_KEYS,
  CommonAgentYamlConfig,
  DEFAULT_AGENT_CLASS,
  LlmAgentYamlConfig,
  llmAgentYamlConfigSchema,
  LoopAgentYamlConfig,
  loopAgentYamlConfigSchema,
  parallelAgentYamlConfigSchema,
  parseWithSchema,
  sequentialAgentYamlConfigSchema,
  ToolYamlConfig,
} from './agent_config.js';

/** Options controlling how a declarative agent config is loaded. */
export interface LoadAgentOptions {
  /**
   * Resolves a symbolic reference in a config — a `code` sub-agent, a callback,
   * a `model_code`, an input/output schema, a tool, or a user-defined
   * `agent_class` — to the live object it names.
   *
   * References come from a config file and are resolved by the caller, so the
   * caller is the trust boundary: a `resolveReference` that resolves arbitrary
   * attacker-supplied names is executing attacker-supplied code.
   *
   * @param name The reference as written in the config document.
   * @returns The referenced object, or `undefined` if the name is unknown.
   */
  resolveReference?: (name: string) => unknown;
}

/** A callback of any of the shapes an agent accepts. */
type AnyCallback = (...args: never[]) => unknown;

/** A constructor taking a single agent-config argument. */
type AgentConstructor = new (
  config: BaseAgentConfig & Record<string, unknown>,
) => unknown;

/** A function that builds a tool from the `args` written in a config. */
type ToolFactory = (args: Record<string, unknown>) => unknown;

/** Absolute config paths currently being loaded, used to detect cycles. */
type InFlightPaths = Set<string>;

/** The tool name whose `args` name an agent to wrap. */
const AGENT_TOOL_NAME = 'AgentTool';

/** The `args` an `AgentTool` entry accepts. */
const agentToolArgsSchema = z
  .object({
    agent: agentRefYamlConfigSchema,
    skip_summarization: z.boolean().optional(),
  })
  .strict();

/**
 * The tools a config may name without supplying a resolver, keyed by the bare
 * export names of `google.adk.tools` so a config authored for either language
 * resolves to the same tool.
 *
 * `transfer_to_agent` is absent deliberately: adk-js performs agent transfer in
 * the agent-transfer request processor rather than through a standalone tool.
 */
const BUILT_IN_TOOLS: ReadonlyMap<string, ToolUnion> = new Map<
  string,
  ToolUnion
>([
  ['enterprise_web_search', ENTERPRISE_WEB_SEARCH],
  ['exit_loop', EXIT_LOOP],
  ['get_user_choice', getUserChoiceTool],
  ['google_maps_grounding', GOOGLE_MAPS_GROUNDING],
  ['google_search', GOOGLE_SEARCH],
  ['load_artifacts', LOAD_ARTIFACTS],
  ['load_memory', LOAD_MEMORY],
  ['preload_memory', PRELOAD_MEMORY],
  ['request_input', requestInputTool],
  ['url_context', URL_CONTEXT],
]);

/**
 * Every `agent_class` spelling that selects a built-in agent, keyed to the
 * module adk-python declares it in.
 *
 * adk-python resolves `agent_class` through `importlib`, which makes the bare
 * name, the package path and the module path interchangeable. The three
 * spellings are enumerated here so a config authored against either language
 * loads identically.
 */
const BUILT_IN_AGENT_CLASSES: ReadonlyMap<string, AdkAgentClass> = new Map(
  Object.entries({
    LlmAgent: 'llm_agent',
    LoopAgent: 'loop_agent',
    ParallelAgent: 'parallel_agent',
    SequentialAgent: 'sequential_agent',
  }).flatMap(([name, module]) => {
    const agentClass = name as AdkAgentClass;
    return [
      [name, agentClass],
      [`google.adk.agents.${name}`, agentClass],
      [`google.adk.agents.${module}.${name}`, agentClass],
    ] as Array<[string, AdkAgentClass]>;
  }),
);

function isFileNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ENOENT'
  );
}

/**
 * Resolves symlinks in `target`, mirroring adk-python's `os.path.realpath`.
 *
 * A path that cannot be canonicalised is returned unchanged: it cannot be read
 * through that spelling either, so the caller's read reports the real reason
 * rather than this function guessing at one.
 */
async function canonicalPath(target: string): Promise<string> {
  try {
    return await fs.realpath(target);
  } catch {
    return target;
  }
}

function resolveReference(
  name: string,
  options: LoadAgentOptions | undefined,
): unknown {
  const resolved = options?.resolveReference?.(name);
  if (resolved === undefined) {
    throw new AgentConfigError(
      AgentConfigErrorCode.UNRESOLVED_REFERENCE,
      `Cannot resolve reference '${name}': LoadAgentOptions.resolveReference was not provided or returned undefined.`,
    );
  }
  return resolved;
}

function resolveCallbacks<T extends AnyCallback>(
  configs: readonly CodeYamlConfig[] | undefined,
  options: LoadAgentOptions | undefined,
): T[] | undefined {
  if (!configs?.length) {
    return undefined;
  }
  return configs.map((config) => {
    const resolved = resolveReference(config.name, options);
    if (typeof resolved !== 'function') {
      throw new AgentConfigError(
        AgentConfigErrorCode.UNRESOLVED_REFERENCE,
        `Reference '${config.name}' did not resolve to a function.`,
      );
    }
    // JavaScript cannot introspect a function's signature, so "is a function"
    // is the whole of what is checkable; `T` is the caller's contract, exactly
    // as it is for a callback handed straight to the agent constructor.
    return resolved as T;
  });
}

/**
 * `@google/genai` names the fields of a `GenerateContentConfig` in camelCase,
 * while adk-python's `types.GenerateContentConfig` takes the snake_case
 * spellings a config document otherwise uses. Converting the subtree keeps a
 * document written for either language loadable.
 */
function toGenerateContentConfig(
  value: GenerateContentConfig | undefined,
): GenerateContentConfig | undefined {
  return value && (camelCaseKeys(value) as GenerateContentConfig);
}

function asTool(name: string, resolved: unknown): ToolUnion {
  if (!isBaseTool(resolved) && !isBaseToolset(resolved)) {
    throw new AgentConfigError(
      AgentConfigErrorCode.UNRESOLVED_REFERENCE,
      `Reference '${name}' did not resolve to a tool or toolset.`,
    );
  }
  return resolved;
}

/**
 * Builds the `AgentTool` an entry names, loading the agent it wraps exactly as
 * a sub-agent reference is loaded.
 */
async function createAgentTool(
  args: Record<string, unknown>,
  configAbsPath: string,
  options: LoadAgentOptions | undefined,
  inFlight: InFlightPaths,
): Promise<AgentTool> {
  const parsed = parseWithSchema(agentToolArgsSchema, args, configAbsPath);
  return new AgentTool({
    agent: await resolveRef(parsed.agent, configAbsPath, options, inFlight),
    skipSummarization: parsed.skip_summarization,
  });
}

/**
 * Builds a tool from the `args` written against it.
 *
 * adk-js has no `BaseTool.fromConfig` protocol, so the two shapes adk-python
 * documents are supported and anything else is rejected: an `AgentTool`, and a
 * reference naming a function that returns a tool.
 */
async function createToolFromArgs(
  config: ToolYamlConfig,
  args: Record<string, unknown>,
  configAbsPath: string,
  options: LoadAgentOptions | undefined,
  inFlight: InFlightPaths,
): Promise<ToolUnion> {
  if (config.name === AGENT_TOOL_NAME) {
    return createAgentTool(args, configAbsPath, options, inFlight);
  }

  const resolved = resolveReference(config.name, options);
  if (typeof resolved !== 'function') {
    throw new AgentConfigError(
      AgentConfigErrorCode.UNSUPPORTED_TOOL_ARGS,
      `Tool '${config.name}' does not accept args: only '${AGENT_TOOL_NAME}' and a reference naming a tool-building function do.`,
    );
  }
  // JavaScript cannot introspect a function's parameters, so "is a function"
  // is the whole of what is checkable before the call; the result is checked.
  return asTool(config.name, (resolved as ToolFactory)(args));
}

async function resolveTools(
  configs: readonly ToolYamlConfig[],
  configAbsPath: string,
  options: LoadAgentOptions | undefined,
  inFlight: InFlightPaths,
): Promise<ToolUnion[]> {
  const tools: ToolUnion[] = [];
  for (const config of configs) {
    if (config.args) {
      tools.push(
        await createToolFromArgs(
          config,
          config.args,
          configAbsPath,
          options,
          inFlight,
        ),
      );
      continue;
    }
    const builtIn = BUILT_IN_TOOLS.get(config.name);
    tools.push(
      builtIn ?? asTool(config.name, resolveReference(config.name, options)),
    );
  }
  return tools;
}

function resolveAgentSchema(
  config: CodeYamlConfig,
  options: LoadAgentOptions | undefined,
): LlmAgentSchema {
  const resolved = resolveReference(config.name, options);
  if (typeof resolved !== 'object' || resolved === null) {
    throw new AgentConfigError(
      AgentConfigErrorCode.UNRESOLVED_REFERENCE,
      `Reference '${config.name}' did not resolve to a schema.`,
    );
  }
  // Both members of LlmAgentSchema are plain objects at runtime and neither
  // carries a marker to test for, so object-ness is all that is checkable.
  return resolved as LlmAgentSchema;
}

/**
 * Resolves a sub-agent `config_path` against the directory of the config that
 * references it.
 *
 * `config_path` is normalised to forward slashes first so a config authored on
 * Windows resolves identically on POSIX. Both the referencing directory and
 * the joined path are then canonicalised with `fs.realpath` before the
 * containment check, mirroring adk-python, so a symlink inside the config
 * directory cannot point outside it. The check is still not a sandbox: it says
 * nothing about a path swapped between this check and the read (TOCTOU), or
 * about hard links.
 */
async function resolveSubAgentPath(
  configPath: string,
  referencingConfigAbsPath: string,
): Promise<string> {
  const normalized = configPath.replaceAll('\\', '/');
  if (path.isAbsolute(normalized)) {
    throw new AgentConfigError(
      AgentConfigErrorCode.ABSOLUTE_SUB_AGENT_PATH,
      `Absolute paths are not allowed in a sub-agent config_path: '${configPath}'.`,
    );
  }

  const referencingDir = await canonicalPath(
    path.dirname(referencingConfigAbsPath),
  );
  const resolved = await canonicalPath(
    path.resolve(referencingDir, normalized),
  );
  if (!isPathContained(referencingDir, resolved)) {
    throw new AgentConfigError(
      AgentConfigErrorCode.PATH_TRAVERSAL,
      `Path traversal detected: config_path '${configPath}' resolves outside '${referencingDir}'.`,
    );
  }
  return resolved;
}

/**
 * Reads a config file and returns its document.
 *
 * An empty file, a list and a bare scalar are all rejected here, so the rest
 * of the loader can treat a document as a mapping.
 */
async function readConfigDocument(
  configAbsPath: string,
): Promise<Record<string, unknown>> {
  let contents: string;
  try {
    contents = await fs.readFile(configAbsPath, 'utf-8');
  } catch (e: unknown) {
    if (isFileNotFound(e)) {
      throw new AgentConfigError(
        AgentConfigErrorCode.CONFIG_FILE_NOT_FOUND,
        `Config file not found: ${configAbsPath}`,
      );
    }
    throw e;
  }

  let document: unknown;
  try {
    document = yaml.load(contents);
  } catch (e: unknown) {
    throw new AgentConfigError(
      AgentConfigErrorCode.INVALID_CONFIG,
      `Invalid agent config in ${configAbsPath}: ${String(e)}`,
    );
  }

  if (
    typeof document !== 'object' ||
    document === null ||
    Array.isArray(document)
  ) {
    throw new AgentConfigError(
      AgentConfigErrorCode.INVALID_CONFIG,
      `Invalid agent config in ${configAbsPath}: expected an object, got ${JSON.stringify(document) ?? typeof document}.`,
    );
  }
  return document as Record<string, unknown>;
}

async function createBaseAgentConfig(
  config: CommonAgentYamlConfig,
  configAbsPath: string,
  options: LoadAgentOptions | undefined,
  inFlight: InFlightPaths,
): Promise<BaseAgentConfig> {
  const subAgents: BaseAgent[] = [];
  for (const ref of config.sub_agents ?? []) {
    subAgents.push(await resolveRef(ref, configAbsPath, options, inFlight));
  }

  return {
    name: config.name,
    description: config.description,
    subAgents,
    beforeAgentCallback: resolveCallbacks<SingleAgentCallback>(
      config.before_agent_callbacks,
      options,
    ),
    afterAgentCallback: resolveCallbacks<SingleAgentCallback>(
      config.after_agent_callbacks,
      options,
    ),
  };
}

async function createLlmAgent(
  parsed: LlmAgentYamlConfig,
  baseConfig: BaseAgentConfig,
  configAbsPath: string,
  options: LoadAgentOptions | undefined,
  inFlight: InFlightPaths,
): Promise<LlmAgent> {
  const llmConfig: LlmAgentConfig = {
    ...baseConfig,
    instruction: parsed.instruction,
    disallowTransferToParent: parsed.disallow_transfer_to_parent,
    disallowTransferToPeers: parsed.disallow_transfer_to_peers,
    includeContents: parsed.include_contents,
    outputKey: parsed.output_key,
    generateContentConfig: toGenerateContentConfig(
      parsed.generate_content_config,
    ),
    beforeModelCallback: resolveCallbacks<SingleBeforeModelCallback>(
      parsed.before_model_callbacks,
      options,
    ),
    afterModelCallback: resolveCallbacks<SingleAfterModelCallback>(
      parsed.after_model_callbacks,
      options,
    ),
    beforeToolCallback: resolveCallbacks<SingleBeforeToolCallback>(
      parsed.before_tool_callbacks,
      options,
    ),
    afterToolCallback: resolveCallbacks<SingleAfterToolCallback>(
      parsed.after_tool_callbacks,
      options,
    ),
  };

  // The remaining fields gate a resolver call that throws on a missing
  // reference, so they stay conditional.
  if (parsed.model_code) {
    const model = resolveReference(parsed.model_code.name, options);
    if (!isBaseLlm(model)) {
      throw new AgentConfigError(
        AgentConfigErrorCode.UNRESOLVED_REFERENCE,
        `Reference '${parsed.model_code.name}' did not resolve to a model.`,
      );
    }
    llmConfig.model = model;
  } else if (parsed.model) {
    llmConfig.model = parsed.model;
  }
  if (parsed.input_schema) {
    llmConfig.inputSchema = resolveAgentSchema(parsed.input_schema, options);
  }
  if (parsed.output_schema) {
    llmConfig.outputSchema = resolveAgentSchema(parsed.output_schema, options);
  }
  if (parsed.tools?.length) {
    llmConfig.tools = await resolveTools(
      parsed.tools,
      configAbsPath,
      options,
      inFlight,
    );
  }

  return new LlmAgent(llmConfig);
}

function createLoopAgent(
  parsed: LoopAgentYamlConfig,
  baseConfig: BaseAgentConfig,
): LoopAgent {
  const loopConfig: LoopAgentConfig = {...baseConfig};
  if (parsed.max_iterations) {
    loopConfig.maxIterations = parsed.max_iterations;
  }
  return new LoopAgent(loopConfig);
}

/**
 * Builds an agent of a class that is not one of the built-ins.
 *
 * The class is resolved through {@link LoadAgentOptions.resolveReference} and
 * receives the base agent fields plus every extra key in the document, in
 * camelCase — the passthrough adk-python performs for fields that match the
 * target constructor. A TypeScript constructor's parameters are not
 * introspectable, so the extras cannot be filtered ahead of the call; a
 * constructor simply ignores the keys it does not read.
 */
function createCustomAgent(
  parsed: BaseAgentYamlConfig,
  baseConfig: BaseAgentConfig,
  options: LoadAgentOptions | undefined,
): BaseAgent {
  const agentClass = parsed.agent_class;
  // The document is snake_case and a TypeScript constructor takes camelCase,
  // so the extras are the one part of a config that needs converting.
  const extras = camelCaseKeys(
    Object.fromEntries(
      Object.entries(parsed).filter(
        ([key]) => !COMMON_AGENT_YAML_KEYS.includes(key),
      ),
    ),
  ) as Record<string, unknown>;

  const resolved = options?.resolveReference?.(agentClass);
  if (typeof resolved !== 'function') {
    throw new AgentConfigError(
      AgentConfigErrorCode.UNSUPPORTED_AGENT_CLASS,
      `Unsupported agent class '${agentClass}': it is not a built-in ADK agent class, and LoadAgentOptions.resolveReference did not resolve it to a constructor.`,
    );
  }

  // Whether the resolved function is a constructor at all, and whether it
  // yields an agent, is only observable by calling it — hence the isBaseAgent
  // check on the result rather than on the class.
  const agent = new (resolved as AgentConstructor)({...extras, ...baseConfig});
  if (!isBaseAgent(agent)) {
    throw new AgentConfigError(
      AgentConfigErrorCode.UNSUPPORTED_AGENT_CLASS,
      `Unsupported agent class '${agentClass}': it did not construct a BaseAgent.`,
    );
  }
  return agent;
}

/**
 * Builds the agent a document describes.
 *
 * The document is validated once, against the schema its `agent_class`
 * selects. A missing or empty `agent_class` means `LlmAgent`, matching
 * adk-python's `agent_class or "LlmAgent"`, and an unrecognised one falls back
 * to the permissive base config rather than raising.
 */
async function buildAgent(
  config: Record<string, unknown>,
  configAbsPath: string,
  options: LoadAgentOptions | undefined,
  inFlight: InFlightPaths,
): Promise<BaseAgent> {
  const agentClass =
    typeof config.agent_class === 'string' && config.agent_class
      ? config.agent_class
      : DEFAULT_AGENT_CLASS;

  switch (BUILT_IN_AGENT_CLASSES.get(agentClass)) {
    case 'LlmAgent': {
      const parsed = parseWithSchema(
        llmAgentYamlConfigSchema,
        config,
        configAbsPath,
      );
      return createLlmAgent(
        parsed,
        await createBaseAgentConfig(parsed, configAbsPath, options, inFlight),
        configAbsPath,
        options,
        inFlight,
      );
    }
    case 'LoopAgent': {
      const parsed = parseWithSchema(
        loopAgentYamlConfigSchema,
        config,
        configAbsPath,
      );
      return createLoopAgent(
        parsed,
        await createBaseAgentConfig(parsed, configAbsPath, options, inFlight),
      );
    }
    case 'ParallelAgent': {
      const parsed = parseWithSchema(
        parallelAgentYamlConfigSchema,
        config,
        configAbsPath,
      );
      return new ParallelAgent(
        await createBaseAgentConfig(parsed, configAbsPath, options, inFlight),
      );
    }
    case 'SequentialAgent': {
      const parsed = parseWithSchema(
        sequentialAgentYamlConfigSchema,
        config,
        configAbsPath,
      );
      return new SequentialAgent(
        await createBaseAgentConfig(parsed, configAbsPath, options, inFlight),
      );
    }
    default: {
      const parsed = parseWithSchema(
        baseAgentYamlConfigSchema,
        config,
        configAbsPath,
      );
      return createCustomAgent(
        parsed,
        await createBaseAgentConfig(parsed, configAbsPath, options, inFlight),
        options,
      );
    }
  }
}

async function loadAgent(
  configAbsPath: string,
  options: LoadAgentOptions | undefined,
  inFlight: InFlightPaths,
): Promise<BaseAgent> {
  if (inFlight.has(configAbsPath)) {
    throw new AgentConfigError(
      AgentConfigErrorCode.CIRCULAR_SUB_AGENT_REFERENCE,
      `Circular sub-agent reference detected: ${configAbsPath} is already being loaded.`,
    );
  }

  const document = await readConfigDocument(configAbsPath);
  inFlight.add(configAbsPath);
  try {
    return await buildAgent(document, configAbsPath, options, inFlight);
  } finally {
    inFlight.delete(configAbsPath);
  }
}

async function resolveRef(
  ref: AgentRefYamlConfig,
  referencingConfigAbsPath: string,
  options: LoadAgentOptions | undefined,
  inFlight: InFlightPaths,
): Promise<BaseAgent> {
  // Empty strings fall through to the `code` branch, matching adk-python's
  // truthiness check on `config_path`.
  if (ref.config_path) {
    return loadAgent(
      await resolveSubAgentPath(ref.config_path, referencingConfigAbsPath),
      options,
      inFlight,
    );
  }

  if (!ref.code) {
    throw new AgentConfigError(
      AgentConfigErrorCode.INVALID_AGENT_REFERENCE,
      'An agent reference must set exactly one of `config_path` or `code`.',
    );
  }

  const resolved = resolveReference(ref.code, options);
  if (!isBaseAgent(resolved)) {
    throw new AgentConfigError(
      AgentConfigErrorCode.INVALID_AGENT_REFERENCE,
      `Reference '${ref.code}' did not resolve to an agent.`,
    );
  }
  return resolved;
}

/**
 * Builds an agent tree from a YAML or JSON config file.
 *
 * Sub-agents referenced by `config_path` are loaded recursively, relative to
 * the directory of the config that references them.
 *
 * @param configPath The config file path; a relative path is resolved against
 *     the current working directory.
 * @param options Options controlling reference resolution.
 * @returns The created agent.
 * @throws {AgentConfigError} If the file is missing, the document is invalid,
 *     the agent class is unsupported, or a reference cannot be resolved.
 */
export async function loadAgentFromConfigFile(
  configPath: string,
  options?: LoadAgentOptions,
): Promise<BaseAgent> {
  return loadAgent(
    await canonicalPath(path.resolve(configPath)),
    options,
    new Set<string>(),
  );
}
