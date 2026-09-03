/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {z} from 'zod';
import {InputValidationError} from '../errors/input_validation_error.js';
import {camelCaseKeys} from '../utils/case_utils.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Schema every custom tool config extends.
 *
 * The base declares no key and rejects every key it was not extended with, so
 * a tool author gets that strictness by extending the base instead of by
 * remembering to ask for it, and a misspelled key in a config document is an
 * error rather than a field ADK ignores in silence.
 *
 * ```ts
 * const myToolConfigSchema = baseToolConfigSchema.extend({
 *   threshold: z.number(),
 *   label: z.string().optional(),
 * });
 * ```
 *
 * The base is a plain object schema, not a preprocessed one, because only a
 * plain object schema has `.extend()`. An author whose document is snake_case
 * wraps their own extension in `z.preprocess(camelCaseKeys, ...)`.
 *
 * @experimental  (Experimental, subject to change)
 */
export const baseToolConfigSchema = z.strictObject({});

/**
 * Schema of the free key-value bag that holds a tool's constructor arguments.
 *
 * The accepted keys belong to the tool, not to ADK, so every key is kept. Keys
 * are camelCased before validation, at every depth.
 *
 * An agent config document camelCases its whole body, `tools[].args` included,
 * so this is the schema a caller applies to a bag it holds on its own.
 * {@link toolConfigSchema} keeps the bag verbatim instead, because the
 * declarative loader hands it to a factory the document names.
 *
 * @experimental  (Experimental, subject to change)
 */
export const toolArgsConfigSchema = z.preprocess(
  camelCaseKeys,
  z.looseObject({}),
);

/**
 * The declared args of one tool in a configuration file.
 *
 * A config comes from outside the type system, so the shape is whatever the
 * tool's own constructor, or the factory the tool names, accepts.
 *
 * Structural (`object`) rather than an index signature on purpose: a tool that
 * narrows its factory parameter to its own config interface must stay
 * assignable to this type, and TypeScript gives an interface no implicit index
 * signature, so an interface is not assignable to an index-signature type
 * (TS2322).
 *
 * @experimental  (Experimental, subject to change)
 */
export type ToolArgsConfig = object;

/**
 * Schema of one tool entry in a config document.
 *
 * `name` addresses the tool and `args` carries the settings of a tool that is
 * built from a class or a factory function. A document may reference a tool in
 * five ways.
 *
 * 1. An ADK built-in tool instance or class, by its own name, with `args` when
 *    it takes any.
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
 * 2. A user-defined tool instance, by the fully qualified path to the
 *    instance.
 *
 * ```yaml
 * tools:
 *   - name: my_package.my_module.myTool
 * ```
 *
 * 3. A user-defined tool class, by the fully qualified path to the class, with
 *    its constructor arguments in `args`.
 *
 * ```yaml
 * tools:
 *   - name: my_package.my_module.MyToolClass
 *     args:
 *       myToolArg1: value1
 *       myToolArg2: value2
 * ```
 *
 * 4. A user-defined function that returns a tool instance, by the fully
 *    qualified path to the function, with the arguments it is passed in
 *    `args`. The function has the signature
 *    `(args: ToolArgsConfig) => BaseTool | Promise<BaseTool>`.
 *
 * ```yaml
 * tools:
 *   - name: my_package.my_module.myToolFactory
 *     args:
 *       myFunctionArg1: value1
 * ```
 *
 * 5. A user-defined function tool, by the fully qualified path to the
 *    function.
 *
 * ```yaml
 * tools:
 *   - name: my_package.my_module.myFunctionTool
 * ```
 *
 * A tool whose settings none of the five can express declares a config of its
 * own by extending {@link baseToolConfigSchema}.
 *
 * `args` is validated as an object and nothing more, mirroring adk-python's
 * `extra='allow'`: the keys belong to the tool, not to ADK, and they reach the
 * constructor or the factory exactly as the document writes them. A document
 * that wants them camelCased runs them through {@link toolArgsConfigSchema}.
 *
 * @experimental  (Experimental, subject to change)
 */
export const toolConfigSchema = z.strictObject({
  name: z.string().min(1),
  args: z
    .custom<ToolArgsConfig>(isRecord, {error: 'Expected an object.'})
    .optional(),
});

/**
 * One tool entry in a config document.
 *
 * @experimental  (Experimental, subject to change)
 */
export type ToolConfig = z.infer<typeof toolConfigSchema>;

/**
 * Validates a parsed tool declaration and returns it as a {@link ToolConfig}.
 *
 * The input is whatever a YAML or JSON parse produced, so it is typed
 * `unknown` and every field is checked. A declaration comes from outside the
 * type system, so an undeclared key is a typo rather than an extension point,
 * and it is rejected instead of dropped in silence. `args` is shallow-copied,
 * so the returned config never aliases the caller's object.
 *
 * This checks one standalone declaration. {@link toolConfigSchema} checks the
 * same entry inside an agent config document, where the loader has already
 * normalized the document.
 *
 * @param value - The parsed tool declaration.
 * @returns A validated {@link ToolConfig}.
 * @throws {InputValidationError} When the declaration is not an object, when
 *   it carries a key {@link ToolConfig} does not declare, when `name` is
 *   missing or is not a string, or when `args` is not an object.
 *
 * @experimental  (Experimental, subject to change)
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
