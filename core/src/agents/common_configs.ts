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
 * so a document written in the snake_case spelling adk-python uses also
 * validates. An unknown key is an error.
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
     * `my_library.my_callbacks.my_callback`. The declarative loader reads the
     * `<module specifier>#<export>` form instead, such as
     * `./my_tools.js#searchTool`; see `utils/module_utils.ts`.
     */
    name: z.string().min(1),
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
