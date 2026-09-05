/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {z} from 'zod';
import {isPlainObject} from '../utils/object_utils.js';

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
 * The base is a plain object schema, so an author who needs one may wrap their
 * own extension in `z.preprocess`; only a plain object schema has `.extend()`.
 *
 * @experimental  (Experimental, subject to change)
 */
export const baseToolConfigSchema = z.strictObject({});

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
 * constructor or the factory exactly as the document writes them.
 *
 * @experimental  (Experimental, subject to change)
 */
export const toolConfigSchema = z.strictObject({
  name: z.string().min(1),
  args: z
    .custom<ToolArgsConfig>(isPlainObject, {error: 'Expected an object.'})
    .optional(),
});

/**
 * One tool entry in a config document.
 *
 * @experimental  (Experimental, subject to change)
 */
export type ToolConfig = z.infer<typeof toolConfigSchema>;
