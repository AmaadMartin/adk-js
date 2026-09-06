/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {isBuiltin} from 'node:module';
import {isAbsolute} from 'node:path';
import {pathToFileURL} from 'node:url';

import {InputValidationError} from '../errors/input_validation_error.js';

/** Separates the module specifier from the export name. */
const EXPORT_SEPARATOR = '#';

/** Export read when a qualified name names no export. */
const DEFAULT_EXPORT = 'default';

/** Splits a qualified name into its module specifier and its export name. */
function splitQualifiedName(name: string): [string, string] {
  const separatorIndex = name.indexOf(EXPORT_SEPARATOR);
  if (separatorIndex === -1) {
    return [name, DEFAULT_EXPORT];
  }
  const exportName = name.slice(separatorIndex + 1);
  return [name.slice(0, separatorIndex), exportName || DEFAULT_EXPORT];
}

/** Returns true when the specifier is resolved against a base file. */
function isRelative(specifier: string): boolean {
  return specifier.startsWith('./') || specifier.startsWith('../');
}

/**
 * Turns a module specifier into one `import()` resolves the same way on every
 * platform. A filesystem path becomes a `file:` URL, because Windows reads the
 * drive letter in `C:\dir\mod.js` as a URL scheme. A bare specifier passes
 * through, so an installed package resolves the way Node normally resolves it.
 */
function toImportSpecifier(specifier: string, baseFilePath?: string): string {
  if (isRelative(specifier)) {
    if (baseFilePath === undefined) {
      throw new Error(
        `Relative specifier "${specifier}" needs the path of the file it ` +
          `came from.`,
      );
    }
    return new URL(specifier, pathToFileURL(baseFilePath)).href;
  }
  return isAbsolute(specifier) ? pathToFileURL(specifier).href : specifier;
}

/** Builds the error every failure mode of the resolver reports. */
function invalidName(name: string, cause: unknown): InputValidationError {
  return new InputValidationError(`Invalid fully qualified name: ${name}`, {
    cause,
  });
}

/**
 * Resolves a fully-qualified name of the form `<module specifier>#<export>` to
 * the value the named module exports. When the separator is absent the whole
 * string is the specifier and the `default` export is read.
 *
 * The import runs the named module's top-level code, so a caller must trust
 * `name` as far as it trusts the configuration file the name came from. Node
 * built-ins are refused so that a configuration file cannot reach
 * `node:child_process`.
 *
 * Unlike `optional_peer.ts`, which keeps its specifiers literal so that
 * bundlers can see them, the specifier here is user configuration and is known
 * only at run time.
 *
 * @param name The fully-qualified name to resolve.
 * @param baseFilePath Absolute path of the file the name came from. A relative
 *   specifier resolves against its directory and needs it. Bare and absolute
 *   specifiers ignore it.
 * @return The exported value.
 * @throws {InputValidationError} When the specifier names a built-in, the
 *   module fails to load, or the module has no such export. The underlying
 *   failure is attached as the error's `cause`.
 */
export async function resolveFullyQualifiedName(
  name: string,
  baseFilePath?: string,
): Promise<unknown> {
  const [specifier, exportName] = splitQualifiedName(name);
  if (isBuiltin(specifier)) {
    throw invalidName(
      name,
      new Error(
        `Node built-in module "${specifier}" cannot be named in a ` +
          `configuration file.`,
      ),
    );
  }
  let namespace: Record<string, unknown>;
  try {
    namespace = await import(toImportSpecifier(specifier, baseFilePath));
  } catch (err: unknown) {
    throw invalidName(name, err);
  }
  if (!(exportName in namespace)) {
    throw invalidName(
      name,
      new Error(`Module "${specifier}" has no export named "${exportName}".`),
    );
  }
  return namespace[exportName];
}
