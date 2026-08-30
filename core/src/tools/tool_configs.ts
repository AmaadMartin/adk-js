/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Free key-value pairs holding the args of a tool in a declarative config.
 *
 * A config loader reads these from a tool entry and hands them to
 * `BaseTool.fromConfig`. Mirrors `ToolArgsConfig` in adk-python.
 */
export type ToolArgsConfig = Record<string, unknown>;
