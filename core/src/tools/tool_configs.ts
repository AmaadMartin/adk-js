/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {InputValidationError} from '../errors/input_validation_error.js';

/**
 * The base of every strictly validated tool config.
 *
 * A tool config is written in a configuration file, outside the type system,
 * so an undeclared key is a typo rather than an extension point. A config type
 * declares its fields and rejects every other key instead of dropping it in
 * silence. Extend this type and call {@link validateToolConfigKeys} with your
 * own field names to get that behaviour.
 *
 * @experimental (Experimental, subject to change)
 */
export type BaseToolConfig = object;

/**
 * The declared args of one tool in a configuration file.
 *
 * The args are free key-value pairs. Their shape is whatever the tool's own
 * constructor accepts, so no key is rejected and no key is renamed; only the
 * container is checked.
 *
 * @experimental (Experimental, subject to change)
 */
export type ToolArgsConfig = object;

/**
 * The configuration for a tool.
 *
 * A `ToolConfig` is a {@link BaseToolConfig}: it declares `name` and `args`,
 * and {@link createToolConfig} rejects any other key. TypeScript cannot write
 * `extends object`, so the relationship is stated here rather than in the
 * type.
 *
 * The config supports these types of tools:
 * 1. ADK built-in tools
 * 2. User-defined tool instances
 * 3. User-defined tool classes
 * 4. User-defined functions that generate tool instances
 * 5. User-defined function tools
 *
 * For examples:
 *
 * 1. ADK built-in tool instances or classes are referenced directly by
 * `name`, and optionally with `args`.
 *
 * ```yaml
 * tools:
 *   - name: google_search
 *   - name: AgentTool
 *     args:
 *       agent: ./another_agent.yaml
 *       skipSummarization: true
 * ```
 *
 * 2. For a user-defined tool instance, `name` is the fully qualified path to
 * the instance.
 *
 * ```yaml
 * tools:
 *   - name: my_package.my_module.myTool
 * ```
 *
 * 3. For a user-defined tool class, `name` is the fully qualified path to the
 * class and `args` are the arguments for the tool.
 *
 * ```yaml
 * tools:
 *   - name: my_package.my_module.MyToolClass
 *     args:
 *       myToolArg1: value1
 *       myToolArg2: value2
 * ```
 *
 * 4. For a user-defined function that generates a tool instance, `name` is the
 * fully qualified path to the function and `args` are passed to the function.
 *
 * ```yaml
 * tools:
 *   - name: my_package.my_module.myToolFunction
 *     args:
 *       myFunctionArg1: value1
 *       myFunctionArg2: value2
 * ```
 *
 * The function must have the following signature:
 *
 * ```ts
 * (args: ToolArgsConfig) => BaseTool | Promise<BaseTool>;
 * ```
 *
 * 5. For a user-defined function tool, `name` is the fully qualified path to
 * the function.
 *
 * ```yaml
 * tools:
 *   - name: my_package.my_module.myFunctionTool
 * ```
 *
 * If the above use cases do not suffice, define a custom tool config by
 * extending {@link BaseToolConfig}.
 *
 * Two things differ from the adk-python reference. The arg keys are camelCase,
 * because `args` reaches an adk-js constructor. And adk-js has no
 * configuration-file loader yet, so `name` is carried verbatim and the
 * consuming loader resolves it.
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

/**
 * The declared keys of {@link ToolConfig}.
 *
 * A record rather than a list of names, so a field added to the interface
 * fails to compile until it is listed here.
 */
const TOOL_CONFIG_KEYS: Record<keyof ToolConfig, true> = {
  name: true,
  args: true,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Rejects a key that the config type does not declare.
 *
 * `Object.hasOwn` rather than `in`, or every `Object.prototype` member
 * (`toString`, `constructor`) would pass as a declared field.
 *
 * @param value - The parsed config object to check.
 * @param declaredKeys - The keys the config type declares. Type it as
 *   `Record<keyof MyToolConfig, true>` so a new field must be listed.
 * @param configName - The config type name, used in the error message.
 * @throws {InputValidationError} Naming every offending key.
 */
export function validateToolConfigKeys(
  value: object,
  declaredKeys: Readonly<Record<string, true>>,
  configName: string,
): void {
  const unknownKeys = Object.keys(value).filter(
    (key) => !Object.hasOwn(declaredKeys, key),
  );
  if (unknownKeys.length > 0) {
    throw new InputValidationError(
      `${configName} received unknown key(s): ${unknownKeys.join(', ')}.`,
    );
  }
}

/**
 * Validates a parsed tool declaration and returns it as a {@link ToolConfig}.
 *
 * The input is whatever a YAML or JSON parse produced, so it is typed
 * `unknown` and every field is checked. `args` is shallow-copied, so the
 * returned config never aliases the caller's object.
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
  validateToolConfigKeys(value, TOOL_CONFIG_KEYS, 'ToolConfig');

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
