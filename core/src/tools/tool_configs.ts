/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {z} from 'zod';
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
 * The arguments of one tool in a config document.
 *
 * @experimental
 */
export type ToolArgsConfig = z.infer<typeof toolArgsConfigSchema>;

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
 * @experimental
 */
export type ToolConfig = z.infer<typeof toolConfigSchema>;
