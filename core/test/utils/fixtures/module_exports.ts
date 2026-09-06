/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Fixture module that `resolveFullyQualifiedName` imports by path, standing in
 * for the user code an agent config file names. The resolver reads an export
 * by name and returns it unchanged, so these are plain values compared by
 * identity.
 */

/** Read as `<module>#namedExport`, and as the default export. */
export const namedExport = {label: 'named'};

/** A second export, so a test can tell one name from another. */
export const otherExport = {label: 'other'};

export default namedExport;
