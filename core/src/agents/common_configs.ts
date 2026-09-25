/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {z} from 'zod';
import {InputValidationError} from '../errors/input_validation_error.js';
import {camelCaseKeys} from '../utils/case_utils.js';
import {resolveFullyQualifiedName} from '../utils/module_utils.js';

/** Reported when a code reference does not have the shape of one. */
const CODE_CONFIG_SHAPE_MESSAGE =
  'A code reference must be an object with a `name` and no other key.';

/**
 * Schema of a code reference to a variable, a function, or a class.
 *
 * The schema accepts either key casing: keys are camelCased before validation,
 * so a document written in the snake_case spelling adk-python uses also
 * validates. An unknown key is an error.
 *
 * @experimental
 */
export const codeConfigSchema = z.preprocess(
  camelCaseKeys,
  z.strictObject({
    /**
     * The fully qualified name of the variable, function, or class, such as
     * `google_search` for a built-in tool or `my_library.my_tools.my_tool` for
     * a user-defined one. A callback names a function, such as
     * `my_library.my_callbacks.my_callback`. The declarative loader reads the
     * `<module specifier>#<export>` form instead, such as
     * `./my_tools.js#searchTool`; see `utils/module_utils.ts`.
     */
    name: z.string().min(1),
  }),
);

/**
 * A code reference to a variable, a function, or a class.
 *
 * The reference names an object; it cannot pass constructor arguments. To use a
 * configured object, build it in code and reference it by name here.
 *
 * @experimental
 */
export type CodeConfig = z.infer<typeof codeConfigSchema>;

/**
 * One source of an agent reference. An explicit `null` counts as "not
 * provided", the way `Optional[str] = None` does, because a key written in a
 * YAML document with no value parses to `null`.
 */
const agentRefSource = z
  .string()
  .min(1)
  .nullish()
  .transform((value) => value ?? undefined);

/**
 * camelCases the keys of an agent reference, so the `config_path` spelling
 * adk-python writes validates.
 *
 * A document that writes both spellings keeps them both: the rename would drop
 * one of the two values in silence, so the raw keys go through instead and
 * `strictObject` reports `config_path` as an unknown key.
 */
function normalizeAgentRefKeys(raw: unknown): unknown {
  if (
    typeof raw === 'object' &&
    raw !== null &&
    !Array.isArray(raw) &&
    'config_path' in raw &&
    'configPath' in raw
  ) {
    return raw;
  }
  return camelCaseKeys(raw);
}

const agentRefFields = z.strictObject({
  /**
   * The config file of the sub-agent, such as `search_agent.yaml`, or
   * `my_library/my_custom_agent.yaml`.
   */
  configPath: agentRefSource,
  /**
   * The fully qualified name of an agent instance defined in code, such as
   * `my_library.custom_agents.my_custom_agent`.
   */
  code: agentRefSource,
});

/**
 * The field shape of an agent reference, without the exactly-one rule.
 *
 * The declarative loader validates that rule with
 * {@link requireExactlyOneSource} once the whole document has parsed, so that
 * its own message reaches the caller rather than a schema error.
 * {@link agentRefConfigSchema} applies both at once.
 */
export const agentRefFieldsSchema = z.preprocess(
  normalizeAgentRefKeys,
  agentRefFields,
);

/**
 * Schema of a reference to another agent.
 *
 * Exactly one of `code` or `configPath` is required. The schema accepts either
 * key casing, so `config_path` and `configPath` both validate. An unknown key
 * is an error.
 *
 * @experimental
 */
export const agentRefConfigSchema = z.preprocess(
  normalizeAgentRefKeys,
  agentRefFields
    .refine((ref) => ref.code === undefined || ref.configPath === undefined, {
      error: 'Only one of `code` or `configPath` should be provided',
    })
    .refine((ref) => ref.code !== undefined || ref.configPath !== undefined, {
      error: 'Exactly one of `code` or `configPath` must be provided',
    }),
);

/**
 * A reference to another agent, by config file path or by code reference.
 *
 * Both fields are optional: exactly one of them is set, and the parsed
 * reference omits the key the document left out.
 *
 * @experimental
 */
export type AgentRefConfig = Partial<z.infer<typeof agentRefConfigSchema>>;

/**
 * Enforces `AgentRefConfig.validate_exactly_one_field` on a reference that did
 * not come from {@link agentRefConfigSchema}, which checks the same rule as it
 * parses. Both set and neither set are different mistakes, so they get
 * different messages.
 */
export function requireExactlyOneSource(ref: AgentRefConfig): AgentRefConfig {
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
 * The schema behind this is {@link codeConfigSchema}, so a caller that already
 * parses a whole document with a schema does not need this function.
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
 * The field shape comes from {@link agentRefFieldsSchema} and the exactly-one
 * rule from {@link requireExactlyOneSource}, so that both set and neither set
 * report the message that names the mistake.
 *
 * @experimental (Experimental, subject to change.)
 *
 * @param raw The value read from the configuration document.
 * @return The validated config, holding only the declared properties.
 * @throws {InputValidationError} When the value is not a valid
 *   `AgentRefConfig`.
 */
export function parseAgentRefConfig(raw: unknown): AgentRefConfig {
  return requireExactlyOneSource(
    parseConfig(
      agentRefFieldsSchema,
      raw,
      'An agent reference must be an object with `code` or `configPath` and ' +
        'no other key.',
    ),
  );
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
