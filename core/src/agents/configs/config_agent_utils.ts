/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as yaml from 'js-yaml';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import {isBaseLlm} from '../../models/base_llm.js';
import {isBaseTool} from '../../tools/base_tool.js';
import {isBaseToolset} from '../../tools/base_toolset.js';
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
  AgentYamlConfig,
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
  parseAgentYamlConfig,
  parseWithSchema,
  sequentialAgentYamlConfigSchema,
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

/** Absolute config paths currently being loaded, used to detect cycles. */
type InFlightPaths = Set<string>;

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

function resolveTools(
  configs: readonly CodeYamlConfig[],
  options: LoadAgentOptions | undefined,
): ToolUnion[] {
  return configs.map((config) => {
    const resolved = resolveReference(config.name, options);
    if (!isBaseTool(resolved) && !isBaseToolset(resolved)) {
      throw new AgentConfigError(
        AgentConfigErrorCode.UNRESOLVED_REFERENCE,
        `Reference '${config.name}' did not resolve to a tool or toolset.`,
      );
    }
    return resolved;
  });
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

async function readConfigDocument(configAbsPath: string): Promise<unknown> {
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

  try {
    return yaml.load(contents);
  } catch (e: unknown) {
    throw new AgentConfigError(
      AgentConfigErrorCode.INVALID_CONFIG,
      `Invalid agent config in ${configAbsPath}: ${String(e)}`,
    );
  }
}

async function createBaseAgentConfig(
  config: CommonAgentYamlConfig,
  configAbsPath: string,
  options: LoadAgentOptions | undefined,
  inFlight: InFlightPaths,
): Promise<BaseAgentConfig> {
  const subAgents: BaseAgent[] = [];
  for (const ref of config.subAgents ?? []) {
    subAgents.push(await resolveRef(ref, configAbsPath, options, inFlight));
  }

  return {
    name: config.name,
    description: config.description,
    subAgents,
    beforeAgentCallback: resolveCallbacks<SingleAgentCallback>(
      config.beforeAgentCallbacks,
      options,
    ),
    afterAgentCallback: resolveCallbacks<SingleAgentCallback>(
      config.afterAgentCallbacks,
      options,
    ),
  };
}

function createLlmAgent(
  parsed: LlmAgentYamlConfig,
  baseConfig: BaseAgentConfig,
  options: LoadAgentOptions | undefined,
): LlmAgent {
  const llmConfig: LlmAgentConfig = {
    ...baseConfig,
    instruction: parsed.instruction,
    disallowTransferToParent: parsed.disallowTransferToParent,
    disallowTransferToPeers: parsed.disallowTransferToPeers,
    includeContents: parsed.includeContents,
    outputKey: parsed.outputKey,
    generateContentConfig: parsed.generateContentConfig,
    beforeModelCallback: resolveCallbacks<SingleBeforeModelCallback>(
      parsed.beforeModelCallbacks,
      options,
    ),
    afterModelCallback: resolveCallbacks<SingleAfterModelCallback>(
      parsed.afterModelCallbacks,
      options,
    ),
    beforeToolCallback: resolveCallbacks<SingleBeforeToolCallback>(
      parsed.beforeToolCallbacks,
      options,
    ),
    afterToolCallback: resolveCallbacks<SingleAfterToolCallback>(
      parsed.afterToolCallbacks,
      options,
    ),
  };

  // The remaining fields gate a resolver call that throws on a missing
  // reference, so they stay conditional.
  if (parsed.modelCode) {
    const model = resolveReference(parsed.modelCode.name, options);
    if (!isBaseLlm(model)) {
      throw new AgentConfigError(
        AgentConfigErrorCode.UNRESOLVED_REFERENCE,
        `Reference '${parsed.modelCode.name}' did not resolve to a model.`,
      );
    }
    llmConfig.model = model;
  } else if (parsed.model) {
    llmConfig.model = parsed.model;
  }
  if (parsed.inputSchema) {
    llmConfig.inputSchema = resolveAgentSchema(parsed.inputSchema, options);
  }
  if (parsed.outputSchema) {
    llmConfig.outputSchema = resolveAgentSchema(parsed.outputSchema, options);
  }
  if (parsed.tools?.length) {
    llmConfig.tools = resolveTools(parsed.tools, options);
  }

  return new LlmAgent(llmConfig);
}

function createLoopAgent(
  parsed: LoopAgentYamlConfig,
  baseConfig: BaseAgentConfig,
): LoopAgent {
  const loopConfig: LoopAgentConfig = {...baseConfig};
  if (parsed.maxIterations) {
    loopConfig.maxIterations = parsed.maxIterations;
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
  const agentClass = parsed.agentClass;
  const extras = Object.fromEntries(
    Object.entries(parsed).filter(
      ([key]) => !COMMON_AGENT_YAML_KEYS.includes(key),
    ),
  );

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

async function buildAgent(
  config: AgentYamlConfig,
  configAbsPath: string,
  options: LoadAgentOptions | undefined,
  inFlight: InFlightPaths,
): Promise<BaseAgent> {
  // An empty agent_class means LlmAgent, matching adk-python's
  // `agent_class or "LlmAgent"`.
  switch (
    BUILT_IN_AGENT_CLASSES.get(config.agentClass || DEFAULT_AGENT_CLASS)
  ) {
    case 'LlmAgent': {
      const parsed = parseWithSchema(llmAgentYamlConfigSchema, config);
      return createLlmAgent(
        parsed,
        await createBaseAgentConfig(parsed, configAbsPath, options, inFlight),
        options,
      );
    }
    case 'LoopAgent': {
      const parsed = parseWithSchema(loopAgentYamlConfigSchema, config);
      return createLoopAgent(
        parsed,
        await createBaseAgentConfig(parsed, configAbsPath, options, inFlight),
      );
    }
    case 'ParallelAgent': {
      const parsed = parseWithSchema(parallelAgentYamlConfigSchema, config);
      return new ParallelAgent(
        await createBaseAgentConfig(parsed, configAbsPath, options, inFlight),
      );
    }
    case 'SequentialAgent': {
      const parsed = parseWithSchema(sequentialAgentYamlConfigSchema, config);
      return new SequentialAgent(
        await createBaseAgentConfig(parsed, configAbsPath, options, inFlight),
      );
    }
    default: {
      const parsed = parseWithSchema(baseAgentYamlConfigSchema, config);
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
    return await buildAgent(
      parseAgentYamlConfig(document),
      configAbsPath,
      options,
      inFlight,
    );
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
  if (ref.configPath) {
    return loadAgent(
      await resolveSubAgentPath(ref.configPath, referencingConfigAbsPath),
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
