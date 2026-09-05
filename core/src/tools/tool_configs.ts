/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The contract for declaring a tool in a configuration document.
 *
 * A configuration document names a tool with {@link toolConfigSchema} and
 * passes it settings through {@link toolArgsConfigSchema}. Five kinds of tool
 * can be named:
 *
 * 1. An ADK built-in tool instance or class. Reference it by its own name,
 *    and pass `args` when it takes any.
 *
 * ```yaml
 * tools:
 *   - name: google_search
 *   - name: AgentTool
 *     args:
 *       agent: ./another_agent.yaml
 *       skip_summarization: true
 * ```
 *
 * 2. A user-defined tool instance. The name is the fully qualified path to
 *    the instance.
 *
 * ```yaml
 * tools:
 *   - name: my_package.my_module.my_tool
 * ```
 *
 * 3. A user-defined tool class. The name is the fully qualified path to the
 *    class, and `args` are its constructor arguments.
 *
 * ```yaml
 * tools:
 *   - name: my_package.my_module.MyToolClass
 *     args:
 *       my_tool_arg1: value1
 *       my_tool_arg2: value2
 * ```
 *
 * 4. A user-defined function that returns a tool instance. The name is the
 *    fully qualified path to the function, and `args` are passed to it.
 *
 * ```yaml
 * tools:
 *   - name: my_package.my_module.myToolFactory
 *     args:
 *       my_function_arg1: value1
 * ```
 *
 * 5. A user-defined function tool. The name is the fully qualified path to
 *    the function.
 *
 * ```yaml
 * tools:
 *   - name: my_package.my_module.myFunctionTool
 * ```
 *
 * When none of the five suffices, a tool declares a config of its own by
 * extending {@link baseToolConfigSchema}.
 *
 * @module
 */

import {z} from 'zod';

import {camelCaseKeys} from '../utils/case_utils.js';

/**
 * The base schema every custom tool config extends.
 *
 * The base declares no key and rejects every key it was not extended with, so
 * a misspelled key in a configuration document is an error rather than a
 * silently ignored extension. A tool author gets that strictness by extending
 * the base; they do not have to ask for it.
 *
 * ```ts
 * const myToolConfigSchema = baseToolConfigSchema.extend({
 *   threshold: z.number(),
 *   label: z.string().optional(),
 * });
 *
 * myToolConfigSchema.parse({threshold: 1});
 * myToolConfigSchema.safeParse({threshold: 1, thresold: 2}).success; // false
 * ```
 *
 * The base is a plain object schema, not a preprocessed one, because only a
 * plain object schema has `.extend()`. A tool author whose document is
 * snake_case wraps their own extension:
 * `z.preprocess(camelCaseKeys, myToolConfigSchema)`.
 *
 * @experimental (Experimental, subject to change)
 */
export const baseToolConfigSchema = z.strictObject({});

/**
 * The args of one tool, as declared in a configuration document.
 *
 * The args are free key-value pairs whose shape belongs to the tool, so the
 * type states only that the value is an object and
 * {@link toolArgsConfigSchema} decides what a document may actually hold.
 *
 * The type is `object` rather than `Record<string, unknown>` so that a tool
 * can narrow it to its own config interface: TypeScript does not give an
 * interface an implicit index signature, so an interface is not assignable to
 * `Record<string, unknown>` (TS2322).
 *
 * @experimental (Experimental, subject to change)
 */
export type ToolArgsConfig = object;

/**
 * Validates the args bag of a tool declaration.
 *
 * Every key is kept, including keys ADK knows nothing about, because the
 * receiving tool owns their meaning. Keys are renamed to camelCase at every
 * depth, so a snake_case document maps onto TypeScript option names.
 *
 * @experimental (Experimental, subject to change)
 */
export const toolArgsConfigSchema = z.preprocess(
  camelCaseKeys,
  z.looseObject({}),
);

/**
 * One tool entry of a configuration document.
 *
 * @experimental (Experimental, subject to change)
 */
export interface ToolConfig {
  /**
   * The name of the tool.
   *
   * For an ADK built-in tool this is the name of the tool, for example
   * `google_search` or `AgentTool`. For a user-defined tool this is the fully
   * qualified path to the tool, for example `my_package.my_module.my_tool`.
   */
  name: string;

  /** The args for the tool. */
  args?: ToolArgsConfig | null;
}

/**
 * Validates one tool entry of a configuration document.
 *
 * The entry carries `name` and optionally `args`, and any other key is
 * rejected under the key the document actually used. `args` accepts `null`,
 * because `args:` written with no value in YAML parses to `null`.
 *
 * @experimental (Experimental, subject to change)
 */
export const toolConfigSchema = z.strictObject({
  name: z.string(),
  args: toolArgsConfigSchema.nullish(),
});
