/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {z} from 'zod';

/**
 * Code reference config for a variable, a function, or a class.
 *
 * Only references an object by name. This is a minimal, experimental config:
 * declarative configs cannot pass constructor arguments, so build the object
 * elsewhere and reference its fully qualified name here.
 *
 * Rejects unknown keys (parity with adk-python's `extra="forbid"`).
 */
export const CodeConfigSchema = z
  .object({
    /** The fully qualified name of the variable, function, or class. */
    name: z.string(),
  })
  .strict();

/**
 * Code reference config for a variable, a function, or a class.
 */
export type CodeConfig = z.infer<typeof CodeConfigSchema>;
