/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Content} from '@google/genai';
import {z} from 'zod';

/**
 * A few-shot example.
 */
export interface Example {
  /**
   * The input content for the example.
   */
  input: Content;
  /**
   * The expected output content for the example.
   */
  output: Content[];
}

const contentSchema = z
  .object({
    role: z.string().optional(),
    parts: z.array(z.object({}).loose()).optional(),
  })
  .loose();

/**
 * Runtime shape check for {@link Example}.
 *
 * {@link Example} is erased at compile time, so a value that reaches the SDK
 * from untyped JavaScript or from a configuration file is unchecked. This
 * schema mirrors the `Example` pydantic model in adk-python, which requires the
 * same two fields.
 *
 * The check is deliberately shallow. `Content` and `Part` carry many optional
 * fields, so both objects stay open, and the schema pins only the invariants
 * the few-shot renderer depends on.
 */
export const exampleSchema = z.object({
  input: contentSchema,
  output: z.array(contentSchema),
});
