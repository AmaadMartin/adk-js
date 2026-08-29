/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The args of a tool config, as free-form key/value pairs.
 *
 * A config comes from outside the type system, so the shape is whatever the
 * tool's own constructor accepts. `BaseTool.fromConfig` validates the keys it
 * understands and ignores the rest.
 */
export type ToolArgsConfig = Record<string, unknown>;
