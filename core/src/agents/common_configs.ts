/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {z} from 'zod';

import {InputValidationError} from '../errors/input_validation_error.js';
import {resolveFullyQualifiedName} from '../utils/module_utils.js';

import {BaseAgent, isBaseAgent} from './base_agent.js';

/**
 * A reference to a variable, function, or class defined in code.
 *
 * A configuration file can only name an object; it cannot pass constructor
 * arguments. To use a configured object, build it in code and name its export
 * here.
 *
 * @experimental (Experimental, subject to change.)
 */
export interface CodeConfig {
  /**
   * The fully-qualified name of the value, as `<module specifier>#<export>`.
   * The `default` export is read when the name carries no `#`.
   *
   * Example: `./my_tools.js#searchTool`.
   */
  name: string;
}

/**
 * A reference to another agent. Exactly one of the two fields is set.
 *
 * @experimental (Experimental, subject to change.)
 */
export interface AgentRefConfig {
  /**
   * The config file of the sub-agent, relative to the file that refers to it.
   * A configuration document may spell this key `config_path`, the name
   * adk-python writes.
   */
  configPath?: string;

  /**
   * The fully-qualified name of an agent instance defined in code, in the form
   * {@link CodeConfig.name} uses.
   *
   * Example: `./custom_agents.js#myCustomAgent`.
   */
  code?: string;
}

/** Reported when an agent reference names both of its two sources. */
const BOTH_SOURCES_MESSAGE =
  'Only one of `code` or `configPath` should be provided';

/** Reported when an agent reference names neither of its two sources. */
const NO_SOURCE_MESSAGE =
  'Exactly one of `code` or `configPath` must be provided';

/** Reported for the agent config files adk-js cannot load. */
const CONFIG_PATH_UNSUPPORTED_MESSAGE =
  'An agent reference by `configPath` is not supported: adk-js has no agent ' +
  'config loader. Name the agent with `code` instead.';

const codeConfigSchema = z.strictObject({name: z.string()});

/**
 * Accepts the `config_path` spelling adk-python writes, and treats an explicit
 * `null` as "not provided" the way `Optional[str] = None` does. The alias
 * applies only when `configPath` is absent, so a document carrying both
 * spellings keeps `config_path` and fails as an unknown key.
 */
function normalizeAgentRefKeys(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return raw;
  }
  const normalized: Record<string, unknown> = {...raw};
  if ('config_path' in normalized && !('configPath' in normalized)) {
    normalized['configPath'] = normalized['config_path'];
    delete normalized['config_path'];
  }
  for (const field of ['code', 'configPath']) {
    if (normalized[field] === null) {
      delete normalized[field];
    }
  }
  return normalized;
}

/**
 * Returns the message for an agent reference that does not name exactly one
 * source, or `undefined` when it names one. Both the parser and
 * {@link resolveAgentReference} read this, so a hand-built object is held to
 * the rule a parsed document is held to.
 */
function exactlyOneSourceError(ref: AgentRefConfig): string | undefined {
  const hasCode = ref.code !== undefined;
  const hasConfigPath = ref.configPath !== undefined;
  if (hasCode && hasConfigPath) {
    return BOTH_SOURCES_MESSAGE;
  }
  if (!hasCode && !hasConfigPath) {
    return NO_SOURCE_MESSAGE;
  }
  return undefined;
}

const agentRefConfigSchema = z
  .preprocess(
    normalizeAgentRefKeys,
    z.strictObject({
      configPath: z.string().optional(),
      code: z.string().optional(),
    }),
  )
  .superRefine((ref, ctx) => {
    const message = exactlyOneSourceError(ref);
    if (message !== undefined) {
      ctx.addIssue({code: 'custom', message});
    }
  });

/** Joins the issues of a failed parse into one message. */
function describeIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.join('.');
      return path ? `${path}: ${issue.message}` : issue.message;
    })
    .join('; ');
}

/** Parses one config document, reporting every failure the same way. */
function parseConfig<T>(
  schema: z.ZodType<T>,
  raw: unknown,
  configName: string,
): T {
  const result = schema.safeParse(raw);
  if (!result.success) {
    throw new InputValidationError(
      `Invalid ${configName}: ${describeIssues(result.error)}`,
      {cause: result.error},
    );
  }
  return result.data;
}

/**
 * Validates a {@link CodeConfig} taken from a parsed configuration document.
 * An unknown key is rejected. An empty `name` is a valid document and fails
 * later, at {@link resolveCodeReference}.
 *
 * @experimental (Experimental, subject to change.)
 *
 * @param raw The value read from the configuration document.
 * @return The validated config.
 * @throws {InputValidationError} When the value is not a valid `CodeConfig`.
 */
export function parseCodeConfig(raw: unknown): CodeConfig {
  return parseConfig(codeConfigSchema, raw, 'CodeConfig');
}

/**
 * Validates an {@link AgentRefConfig} taken from a parsed configuration
 * document. An unknown key is rejected, `config_path` is accepted as an alias
 * of `configPath`, and exactly one of `code` and `configPath` must be set.
 *
 * @experimental (Experimental, subject to change.)
 *
 * @param raw The value read from the configuration document.
 * @return The validated config, holding only the declared properties.
 * @throws {InputValidationError} When the value is not a valid
 *   `AgentRefConfig`.
 */
export function parseAgentRefConfig(raw: unknown): AgentRefConfig {
  return parseConfig(agentRefConfigSchema, raw, 'AgentRefConfig');
}

/**
 * Resolves a {@link CodeConfig} to the value it names.
 *
 * The import runs the named module's top-level code, so a caller trusts the
 * config exactly as far as it trusts the configuration file it came from.
 *
 * @experimental (Experimental, subject to change.)
 *
 * @param config The reference to resolve.
 * @param baseFilePath Absolute path of the configuration file the reference
 *   came from. A `./`-relative name needs it; a bare or absolute name does
 *   not.
 * @return The named value, for the caller to narrow.
 * @throws {InputValidationError} When the config is empty, or the name does
 *   not resolve.
 */
export async function resolveCodeReference(
  config: CodeConfig,
  baseFilePath?: string,
): Promise<unknown> {
  if (!config || !config.name) {
    throw new InputValidationError('Invalid CodeConfig.');
  }
  return resolveFullyQualifiedName(config.name, baseFilePath);
}

/**
 * Resolves an {@link AgentRefConfig} to the agent it names.
 *
 * @experimental (Experimental, subject to change.)
 *
 * @param ref The reference to resolve.
 * @param referencingConfigPath Absolute path of the configuration file the
 *   reference came from.
 * @return The referenced agent.
 * @throws {InputValidationError} When the reference does not name exactly one
 *   source, names a config file, or does not resolve to an agent.
 */
export async function resolveAgentReference(
  ref: AgentRefConfig,
  referencingConfigPath: string,
): Promise<BaseAgent> {
  const sourceError = exactlyOneSourceError(ref);
  if (sourceError !== undefined) {
    throw new InputValidationError(sourceError);
  }
  const code = ref.code;
  if (code === undefined) {
    throw new InputValidationError(CONFIG_PATH_UNSUPPORTED_MESSAGE);
  }
  const resolved = await resolveFullyQualifiedName(code, referencingConfigPath);
  if (!isBaseAgent(resolved)) {
    throw new InputValidationError(
      `Agent reference \`${code}\` does not resolve to an agent.`,
    );
  }
  return resolved;
}
