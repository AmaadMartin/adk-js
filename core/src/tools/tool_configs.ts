/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {z} from 'zod';
import {InputValidationError} from '../errors/input_validation_error.js';
import {camelCaseKeys} from '../utils/case_utils.js';

/**
 * Schema of the free key-value bag that holds a tool's constructor arguments.
 *
 * The accepted keys belong to the tool, not to ADK, so every key is kept. Keys
 * are camelCased before validation, at every depth.
 *
 * @experimental
 */
export const toolArgsConfigSchema = z.preprocess(
  camelCaseKeys,
  z.looseObject({}),
);

/**
 * The declared args of one tool in a configuration file.
 *
 * A config comes from outside the type system, so the shape is whatever the
 * tool's own constructor accepts. `BaseTool.fromConfig` checks the entries it
 * reads and passes the rest through. {@link toolArgsConfigSchema} validates a
 * declaration and returns a value of this type.
 *
 * Structural (`object`) rather than an index signature on purpose: a subclass
 * that narrows {@link BaseTool.fromConfig} to its own config interface must
 * stay assignable to this type, and a TypeScript interface is not assignable
 * to an index-signature type.
 */
export type ToolArgsConfig = object;

/**
 * Schema of one tool entry in a config document.
 *
 * `name` addresses the tool: a bare name for an ADK built-in tool such as
 * `google_search`, or a fully qualified name such as
 * `my_package.my_module.my_tool` for a user-defined one. `args` carries the
 * arguments for a tool that is built from a class or a factory function.
 *
 * @experimental
 */
export const toolConfigSchema = z.preprocess(
  camelCaseKeys,
  z.strictObject({
    name: z.string(),
    args: toolArgsConfigSchema.optional(),
  }),
);

/**
 * One tool entry in a config document.
 *
 * `name` addresses the tool and `args` carries its settings. The five
 * supported ways to reference a tool, with examples, are in
 * `docs/guides/tools/tool_config/index.md`.
 *
 * adk-js has no configuration-file loader yet, so `name` is carried verbatim
 * and the consuming loader resolves it.
 *
 * @experimental
 */
export type ToolConfig = z.infer<typeof toolConfigSchema>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validates a parsed tool declaration and returns it as a {@link ToolConfig}.
 *
 * The input is whatever a YAML or JSON parse produced, so it is typed
 * `unknown` and every field is checked. A declaration comes from outside the
 * type system, so an undeclared key is a typo rather than an extension point,
 * and it is rejected instead of dropped in silence. `args` is shallow-copied,
 * so the returned config never aliases the caller's object.
 *
 * This checks one standalone declaration and keeps every `args` key verbatim.
 * {@link toolConfigSchema} checks the same entry inside an agent config
 * document, where {@link toolArgsConfigSchema} camelCases the keys first.
 *
 * @param value - The parsed tool declaration.
 * @returns A validated {@link ToolConfig}.
 * @throws {InputValidationError} When the declaration is not an object, when
 *   it carries a key {@link ToolConfig} does not declare, when `name` is
 *   missing or is not a string, or when `args` is not an object.
 *
 * @experimental
 */
export function createToolConfig(value: unknown): ToolConfig {
  if (!isRecord(value)) {
    throw new InputValidationError('ToolConfig must be a non-null object.');
  }
  const unknownKeys = Object.keys(value).filter(
    (key) => key !== 'name' && key !== 'args',
  );
  if (unknownKeys.length > 0) {
    throw new InputValidationError(
      `ToolConfig received unknown key(s): ${unknownKeys.join(', ')}.`,
    );
  }

  const {name, args} = value;
  if (name === undefined) {
    throw new InputValidationError('ToolConfig `name` is required.');
  }
  if (typeof name !== 'string') {
    throw new InputValidationError('ToolConfig `name` must be a string.');
  }
  if (args === undefined || args === null) {
    return {name};
  }
  if (!isRecord(args)) {
    throw new InputValidationError('ToolConfig `args` must be an object.');
  }
  return {name, args: {...args}};
}
