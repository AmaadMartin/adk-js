/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Node error codes for an unresolvable module specifier. A native `import()`
 * fails with `ERR_MODULE_NOT_FOUND`; both published node builds target
 * `node10.4` (see `core/build.js`), so esbuild lowers `import()` to a
 * `require()` wrapper that fails with `MODULE_NOT_FOUND` instead.
 */
const MODULE_NOT_FOUND_CODES = new Set([
  'ERR_MODULE_NOT_FOUND',
  'MODULE_NOT_FOUND',
]);

/** Identifies an optional peer dependency for error reporting. */
export interface OptionalDependency {
  /** npm package name, e.g. '@google-cloud/storage'. */
  packageName: string;
  /** Human-readable name of the ADK feature that requires it. */
  feature: string;
}

/**
 * Loads an optional peer dependency, converting a missing-package failure into
 * an actionable install instruction.
 *
 * Any other failure — including a missing *transitive* dependency of the
 * package — is rethrown unchanged, so a genuine crash is never mislabelled as
 * "not installed".
 *
 * @param load Must wrap a literal `import()` specifier so bundlers can still
 *     see it.
 * @param dependency The package to name in the install instruction.
 */
export async function loadOptionalDependency<T>(
  load: () => Promise<T>,
  {packageName, feature}: OptionalDependency,
): Promise<T> {
  try {
    return await load();
  } catch (e: unknown) {
    if (!isMissingPackageError(e, packageName)) {
      throw e;
    }
    throw new Error(
      `${feature} requires the optional peer dependency '${packageName}', ` +
        `which is not installed. Run \`npm install ${packageName}\` to enable it.`,
    );
  }
}

function isMissingPackageError(e: unknown, packageName: string): boolean {
  if (typeof e !== 'object' || e === null) {
    return false;
  }

  const code = 'code' in e ? e.code : undefined;
  const message = 'message' in e ? e.message : undefined;

  return (
    typeof code === 'string' &&
    MODULE_NOT_FOUND_CODES.has(code) &&
    typeof message === 'string' &&
    // Node quotes the unresolved specifier: "Cannot find module '<pkg>'" (CJS)
    // and "Cannot find package '<pkg>' imported from <file>" (ESM). Requiring
    // the quoted form stops a transitive miss inside the package — whose
    // message embeds the package's unquoted directory path — being reported as
    // "the package is not installed".
    message.includes(`'${packageName}'`)
  );
}
