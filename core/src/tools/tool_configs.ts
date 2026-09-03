/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {z} from 'zod';
import {InputValidationError} from '../errors/input_validation_error.js';

/**
 * The base a custom tool's own config extends.
 *
 * The schema declares no key and rejects every key it was not extended with,
 * so a config built from it treats a misspelled key as an error rather than
 * as an extension point. A custom tool adds its keys with `.extend()`:
 *
 * ```ts
 * const myToolConfigSchema = baseToolConfigSchema.extend({
 *   threshold: z.number(),
 * });
 * myToolConfigSchema.parse({threshold: 1, thresold: 2}); // rejects the typo
 * ```
 *
 * This is the adk-python `BaseToolConfig` extension point, which carries
 * pydantic's `extra="forbid"` to a subclass.
 *
 * @experimental (Experimental, subject to change)
 */
export const baseToolConfigSchema = z.strictObject({});

/**
 * The config a custom tool declares by extending
 * {@link baseToolConfigSchema}.
 *
 * @experimental (Experimental, subject to change)
 */
export type BaseToolConfig = z.infer<typeof baseToolConfigSchema>;

/**
 * The declared args of one tool in a configuration file.
 *
 * The args are free key-value pairs. Their shape is whatever the tool's own
 * constructor accepts, so no key is rejected and no key is renamed; only the
 * container is checked.
 *
 * Structural (`object`) rather than an index signature on purpose: a tool that
 * narrows its own config to a TypeScript interface must stay assignable to
 * this type, and an interface is not assignable to an index-signature type.
 *
 * @experimental (Experimental, subject to change)
 */
export type ToolArgsConfig = object;

/**
 * The configuration for a tool, as declared in a configuration file.
 *
 * `name` addresses the tool and `args` carries its settings.
 * {@link createToolConfig} rejects any other key. The five supported ways to
 * reference a tool, with examples, are in
 * `docs/guides/tools/tool_config/index.md`.
 *
 * adk-js has no configuration-file loader yet, so `name` is carried verbatim
 * and the consuming loader resolves it.
 *
 * @experimental (Experimental, subject to change)
 */
export interface ToolConfig {
  /**
   * The name of the tool.
   *
   * For an ADK built-in tool this is the name of the tool, for example
   * `google_search` or `AgentTool`. For a user-defined tool this is the fully
   * qualified path to the tool, for example `my_package.my_module.myTool`.
   */
  name: string;

  /** The args for the tool. */
  args?: ToolArgsConfig;
}

const toolConfigSchema = baseToolConfigSchema.extend({
  name: z.string(),
  args: z.looseObject({}).nullish(),
});

/**
 * Validates a parsed tool declaration and returns it as a {@link ToolConfig}.
 *
 * The input is whatever a YAML or JSON parse produced, so it is typed
 * `unknown` and every field is checked. A declaration comes from outside the
 * type system, so an undeclared key is a typo rather than an extension point,
 * and it is rejected instead of dropped in silence. `args` is copied, so the
 * returned config never aliases the caller's object.
 *
 * The error names the offending key and the expected type. It never echoes
 * the offending value, because a tool's args can carry credentials.
 *
 * @param value - The parsed tool declaration.
 * @returns A validated {@link ToolConfig}.
 * @throws {InputValidationError} When the declaration is not an object, when
 *   it carries a key {@link ToolConfig} does not declare, when `name` is
 *   missing or is not a string, or when `args` is not an object.
 *
 * @experimental (Experimental, subject to change)
 */
export function createToolConfig(value: unknown): ToolConfig {
  const result = toolConfigSchema.safeParse(value);
  if (!result.success) {
    throw new InputValidationError(
      result.error.issues
        .map(
          (issue) =>
            `${issue.path.join('.') || 'ToolConfig'}: ${issue.message}`,
        )
        .join('; '),
    );
  }
  const {name, args} = result.data;
  return args == null ? {name} : {name, args};
}
