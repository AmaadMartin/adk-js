/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Resolved capabilities for an LLM instance.
 *
 * Each field holds the computed result for one capability, not an override, so
 * there is no "defer to auto-detection" placeholder.
 *
 * Models self-report by overriding `BaseLlm.capabilities`. Callers read the
 * field instead of re-deriving support from the model name, backend variant, or
 * type.
 *
 * The fields are `readonly` because `BaseLlm.capabilities` recomputes a fresh
 * snapshot on every access: mutating one in place would have no effect on the
 * model. Override a capability by subclassing the model instead.
 */
export interface LlmCapabilities {
  /** Whether the model can use an output schema together with tools. */
  readonly outputSchemaAndTools: boolean;
}
