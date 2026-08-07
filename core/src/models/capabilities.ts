/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Resolved capabilities for an LLM instance.
 *
 * The fields are `readonly` because `BaseLlm.capabilities` recomputes a fresh
 * snapshot on every access: mutating one in place would have no effect on the
 * model. Override a capability by subclassing the model instead.
 */
export interface LlmCapabilities {
  /** Whether the model can use an output schema together with tools. */
  readonly outputSchemaAndTools: boolean;
}
