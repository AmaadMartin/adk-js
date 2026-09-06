/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {z} from 'zod';
import {camelCaseKeys} from '../utils/case_utils.js';

/**
 * Schema of a code reference to a variable, a function, or a class.
 *
 * The schema accepts either key casing: keys are camelCased before validation,
 * so the snake_case spelling of an on-disk config file also validates.
 *
 * @experimental
 */
export const codeConfigSchema = z.preprocess(
  camelCaseKeys,
  z.strictObject({
    /**
     * The fully qualified name of the variable, function, or class, such as
     * `google_search` for a built-in tool or `my_library.my_tools.my_tool` for
     * a user-defined one.
     */
    name: z.string(),
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
 * Schema of a reference to another agent.
 *
 * Exactly one of `code` or `config_path` is required. The schema accepts either
 * key casing, so `config_path` and `configPath` both validate.
 *
 * @experimental
 */
export const agentRefConfigSchema = z.preprocess(
  camelCaseKeys,
  z
    .strictObject({
      /** The config file path of the sub-agent, such as `search_agent.yaml`. */
      configPath: z.string().optional(),
      /** The fully qualified name of an agent instance defined in code. */
      code: z.string().optional(),
    })
    .refine((ref) => ref.code === undefined || ref.configPath === undefined, {
      error: 'Only one of `code` or `config_path` should be provided',
    })
    .refine((ref) => ref.code !== undefined || ref.configPath !== undefined, {
      error: 'Exactly one of `code` or `config_path` must be provided',
    }),
);

/**
 * A reference to another agent, by config file path or by code reference.
 *
 * @experimental
 */
export type AgentRefConfig = z.infer<typeof agentRefConfigSchema>;
