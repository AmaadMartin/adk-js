/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {InputValidationError} from '../errors/input_validation_error.js';

/**
 * The declared args of one tool in a configuration file.
 *
 * The args are free key-value pairs. Their shape is whatever the tool's own
 * constructor accepts, so no key is rejected and no key is renamed; only the
 * container is checked.
 *
 * @experimental (Experimental, subject to change)
 */
export type ToolArgsConfig = Record<string, unknown>;

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
 * @param value - The parsed tool declaration.
 * @returns A validated {@link ToolConfig}.
 * @throws {InputValidationError} When the declaration is not an object, when
 *   it carries a key {@link ToolConfig} does not declare, when `name` is
 *   missing or is not a string, or when `args` is not an object.
 *
 * @experimental (Experimental, subject to change)
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
