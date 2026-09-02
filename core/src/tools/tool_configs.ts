/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The declared args of one tool in a configuration file.
 *
 * A config comes from outside the type system, so the shape is whatever the
 * tool's own constructor accepts. `BaseTool.fromConfig` checks the entries it
 * reads and passes the rest through.
 *
 * Structural (`object`) rather than an index signature on purpose: a subclass
 * that narrows {@link BaseTool.fromConfig} to its own config interface must
 * stay assignable to this type, and a TypeScript interface is not assignable
 * to an index-signature type.
 */
export type ToolArgsConfig = object;
