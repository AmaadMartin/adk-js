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
 * Keys are camelCased before validation, so a document written in the
 * snake_case spelling adk-python uses also validates. An unknown key is an
 * error.
 *
 * @experimental
 */
export const codeConfigSchema = z.preprocess(
  camelCaseKeys,
  z.strictObject({
    /**
     * The fully qualified name of the variable, function, or class, such as
     * `google_search` for a built-in tool or `my_library.my_tools.my_tool` for
     * a user-defined one. A callback names a function, such as
     * `my_library.my_callbacks.my_callback`.
     */
    name: z.string().min(1),
  }),
);

/**
 * A code reference to a variable, a function, or a class.
 *
 * The reference names an object; it cannot pass constructor arguments. To use
 * a configured object, build it in code and name it here.
 *
 * @experimental
 */
export type CodeConfig = z.infer<typeof codeConfigSchema>;

/**
 * One source of an agent reference. An explicit `null` counts as "not
 * provided", the way `Optional[str] = None` does, because a key written in a
 * YAML document with no value parses to `null`.
 */
const agentRefSource = z
  .string()
  .min(1)
  .nullish()
  .transform((value) => value ?? undefined);

/**
 * Schema of a reference to another agent.
 *
 * Exactly one of `code` or `configPath` is required. Keys are camelCased
 * before validation, so `config_path` and `configPath` both validate. An
 * unknown key is an error.
 *
 * @experimental
 */
export const agentRefConfigSchema = z.preprocess(
  camelCaseKeys,
  z
    .strictObject({
      /**
       * The config file of the sub-agent, such as `search_agent.yaml`, or
       * `my_library/my_custom_agent.yaml`.
       */
      configPath: agentRefSource,
      /**
       * The fully qualified name of an agent instance defined in code, such as
       * `my_library.custom_agents.my_custom_agent`.
       */
      code: agentRefSource,
    })
    .refine((ref) => ref.code === undefined || ref.configPath === undefined, {
      error: 'Only one of `code` or `configPath` should be provided',
    })
    .refine((ref) => ref.code !== undefined || ref.configPath !== undefined, {
      error: 'Exactly one of `code` or `configPath` must be provided',
    }),
);

/**
 * A reference to another agent, by config file path or by code reference.
 *
 * @experimental
 */
export type AgentRefConfig = z.infer<typeof agentRefConfigSchema>;
