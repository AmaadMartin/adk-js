/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {z} from 'zod';

import {isPlainObject} from '../utils/object_utils.js';

/**
 * The declared args of one tool in a configuration file.
 *
 * A config comes from outside the type system, so the shape is whatever the
 * factory the tool names accepts. The keys reach that factory exactly as the
 * document writes them.
 *
 * Structural (`object`) rather than an index signature on purpose: a factory
 * that narrows its parameter to its own config interface must stay assignable
 * to this type, and a TypeScript interface is not assignable to an
 * index-signature type.
 */
export type ToolArgsConfig = object;

/**
 * A declarative reference to one tool of an agent.
 *
 * @experimental (Experimental, subject to change.)
 */
export interface ToolConfig {
  /**
   * The fully-qualified name of the tool, as `<module specifier>#<export>`. It
   * may name a tool instance, a toolset, or a factory that builds one from
   * {@link ToolConfig.args}.
   *
   * Example: `./my_tools.js#searchTool`.
   */
  name: string;

  /** The args passed to the factory the `name` refers to. */
  args?: ToolArgsConfig;
}

/**
 * Schema of a {@link ToolConfig}.
 *
 * `args` is validated as an object and nothing more, mirroring adk-python's
 * `extra='allow'`: the keys belong to the tool, not to ADK.
 */
export const toolConfigSchema = z.strictObject({
  name: z.string().min(1),
  args: z
    .custom<ToolArgsConfig>(isPlainObject, {error: 'Expected an object.'})
    .optional(),
});
