/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {z} from 'zod';

import {InputValidationError} from '../errors/input_validation_error.js';
import {resolveFullyQualifiedName} from '../utils/module_utils.js';

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

/** Reported when a code reference does not have the shape of one. */
const CODE_CONFIG_SHAPE_MESSAGE =
  'A code reference must be an object with a `name` and no other key.';

const codeConfigSchema = z.strictObject({name: z.string().min(1)});

/**
 * An agent reference source. An explicit `null` counts as "not provided", the
 * way `Optional[str] = None` does, because a YAML key written with no value
 * parses to `null`.
 */
const agentRefSource = z
  .string()
  .min(1)
  .nullish()
  .transform((value) => value ?? undefined);

/**
 * Accepts the `config_path` spelling adk-python writes. The alias applies only
 * when `configPath` is absent, so a document carrying both spellings keeps
 * `config_path` and fails as an unknown key.
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
  return normalized;
}

const agentRefConfigSchema = z.preprocess(
  normalizeAgentRefKeys,
  z.strictObject({configPath: agentRefSource, code: agentRefSource}),
);

/**
 * Parses one config document. The message summarizes the rule the document
 * broke, and the `ZodError` is kept as the cause, because that is what names
 * the offending key.
 */
function parseConfig<T>(
  schema: z.ZodType<T>,
  raw: unknown,
  message: string,
): T {
  const result = schema.safeParse(raw);
  if (!result.success) {
    throw new InputValidationError(message, {cause: result.error});
  }
  return result.data;
}

/**
 * Validates a {@link CodeConfig} taken from a parsed configuration document.
 * An unknown key is rejected, and so is a missing or empty `name`.
 *
 * @experimental (Experimental, subject to change.)
 *
 * @param raw The value read from the configuration document.
 * @return The validated config, holding only the declared property.
 * @throws {InputValidationError} When the value is not a valid `CodeConfig`.
 */
export function parseCodeConfig(raw: unknown): CodeConfig {
  return parseConfig(codeConfigSchema, raw, CODE_CONFIG_SHAPE_MESSAGE);
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
  const ref = parseConfig(
    agentRefConfigSchema,
    raw,
    'An agent reference must be an object with `code` or `configPath` and ' +
      'no other key.',
  );
  if (ref.code !== undefined && ref.configPath !== undefined) {
    throw new InputValidationError(
      'An agent reference sets both `code` and `configPath`; exactly one of ' +
        '`code` and `configPath` must be set.',
    );
  }
  if (ref.code === undefined && ref.configPath === undefined) {
    throw new InputValidationError(
      'An agent reference sets neither `code` nor `configPath`; exactly one ' +
        'of `code` and `configPath` must be set.',
    );
  }
  return ref;
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
 * @throws {InputValidationError} When the `name` is empty, or does not
 *   resolve.
 */
export async function resolveCodeReference(
  config: CodeConfig,
  baseFilePath?: string,
): Promise<unknown> {
  if (!config.name) {
    throw new InputValidationError(CODE_CONFIG_SHAPE_MESSAGE);
  }
  return resolveFullyQualifiedName(config.name, baseFilePath);
}
