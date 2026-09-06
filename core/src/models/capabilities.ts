/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {z} from 'zod';

/**
 * Runtime shape of a resolved capability snapshot.
 *
 * The object is strict, so an unknown key fails instead of attaching itself as
 * a capability nobody reads. Every capability has a default, so a snapshot is
 * always fully resolved.
 */
export const LlmCapabilitiesSchema = z.strictObject({
  outputSchemaAndTools: z.boolean().default(false),
});

/**
 * Resolved capabilities for an LLM instance.
 *
 * Each field holds the computed result for one capability, not an override, so
 * there is no "defer to auto-detection" state. Read the field instead of
 * re-deriving support from the model name or the backend variant.
 *
 * A snapshot is immutable. Build a new one with {@link createLlmCapabilities}
 * to change a capability.
 */
export interface LlmCapabilities {
  /** Whether the model can use an output schema together with tools. */
  readonly outputSchemaAndTools: boolean;
}

/**
 * Validates `init` and returns a frozen capability snapshot.
 *
 * The parameter is `unknown` because the factory exists to check input the
 * compiler has not: a parsed configuration file, a plugin's return value, or an
 * object spread from an older snapshot. A caller passing a typed literal
 * already gets excess-property checking from {@link LlmCapabilities}.
 *
 * @param init Capability values to apply over the defaults.
 * @return A frozen snapshot. Assigning to one of its fields throws a
 *     `TypeError`, because ES modules run in strict mode.
 * @throws A `ZodError` if `init` holds an unknown key or a wrong-typed value.
 */
export function createLlmCapabilities(init: unknown = {}): LlmCapabilities {
  return Object.freeze(LlmCapabilitiesSchema.parse(init));
}
