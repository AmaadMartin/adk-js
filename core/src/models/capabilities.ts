/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Resolved capabilities for an LLM instance, as reported by a model's
 * `capabilities` getter. The fields are `readonly` because every access
 * returns a fresh snapshot; declare a capability by subclassing the model.
 */
export interface LlmCapabilities {
  /** Whether the model can use an output schema together with tools. */
  readonly outputSchemaAndTools: boolean;
}
