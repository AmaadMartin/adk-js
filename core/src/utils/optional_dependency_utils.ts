/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

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

  // Both codes are reachable. Running from source (vitest, ts-node, or a
  // bundler that preserves `import()`) gives a native import and
  // ERR_MODULE_NOT_FOUND. In the published builds esbuild lowers `import()` to
  // a `require()` wrapper, which throws MODULE_NOT_FOUND -- that applies to the
  // esm output too, which is why core/build.js gives it a `createRequire`
  // banner.
  const isUnresolved =
    code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND';

  return (
    isUnresolved &&
    typeof message === 'string' &&
    // Node quotes the unresolved specifier: "Cannot find module '<pkg>'" (CJS)
    // and "Cannot find package '<pkg>' imported from <file>" (ESM). Requiring
    // the quoted form stops a transitive miss inside the package — whose
    // message embeds the package's unquoted directory path — being reported as
    // "the package is not installed".
    message.includes(`'${packageName}'`)
  );
}
