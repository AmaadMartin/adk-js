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

/** Matches a specifier that opens with a URL scheme, such as `data:`. */
const URL_SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*:/i;

/**
 * Turns a module specifier into one `import()` resolves the same way on every
 * platform. A filesystem path becomes a `file:` URL, because Windows reads the
 * drive letter in `C:\dir\mod.js` as a URL scheme. A bare specifier passes
 * through, so an installed package resolves the way Node normally resolves it.
 *
 * A specifier carrying any other URL scheme is refused. `import()` accepts a
 * `data:` URL, which carries its own source, so without this a configuration
 * file could supply the module body it wanted to run.
 */
function toImportSpecifier(specifier: string, baseFilePath?: string): string {
  if (specifier.startsWith('./') || specifier.startsWith('../')) {
    if (baseFilePath === undefined) {
      throw new Error(
        `Relative specifier "${specifier}" needs the path of the file that ` +
          `names it.`,
      );
    }
    return new URL(specifier, pathToFileURL(baseFilePath)).href;
  }
  if (isAbsolute(specifier)) {
    return pathToFileURL(specifier).href;
  }
  const scheme = URL_SCHEME_PATTERN.exec(specifier)?.[0];
  if (scheme !== undefined) {
    throw new Error(
      `Module specifier "${specifier}" uses the "${scheme}" URL scheme. A ` +
        `configuration file can name a file path or a package, nothing else.`,
    );
  }
  return specifier;
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
 * The import runs the named module's top-level code, so a caller trusts `name`
 * exactly as far as it trusts the configuration file the name came from. Node
 * built-ins are refused so that a configuration file cannot reach
 * `node:child_process`.
 *
 * @param name The fully-qualified name to resolve.
 * @param baseFilePath Absolute path of the file the name came from. A relative
 *   specifier resolves against its directory and fails without it. Bare and
 *   absolute specifiers ignore it.
 * @return The exported value.
 * @throws {InputValidationError} When the specifier names a built-in, needs a
 *   base path it was not given, fails to load, or has no such export. The
 *   underlying failure is attached as the error's `cause`.
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
