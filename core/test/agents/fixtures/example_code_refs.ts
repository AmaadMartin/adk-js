/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A module the code-reference tests resolve by name, standing in for the file
 * a configuration document points at.
 */

/** Resolved when a qualified name carries no export name. */
export default 'the default export';

/** Resolved by the export name `staticProvider`. */
export const staticProvider = () => 'provided';
